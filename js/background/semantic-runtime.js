import { digest, projectAX } from './semantic-projection.js';
import { readAXScope, candidateDelta } from './semantic-scope.js';

const MAX_FRAMES = 16;
const MAX_NODES = 100000;
const MAX_TABS = 8;
const MAX_CANDIDATES = 4096;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_AX_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 16;
const MAX_HISTORY_BYTES = 512 * 1024;
const scopeKey = params => JSON.stringify([params.kind || 'controls', params.origin || '', params.frame_id || '', params.frame_url || '', params.root_backend_dom_node_id || 0]);
const IDLE_MS = 60000;
const LEASE_MS = 120000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const token = () => globalThis.crypto.randomUUID();
const originOf = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''; } catch (_) { return ''; } };
const readMethods = new Set(['Page.getFrameTree', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.getNodeForLocation', 'Runtime.releaseObjectGroup']);

// Owns browser-local evidence and routing. Events are invalidation hints, never a
// promise that an unchanged index is fresh. Every observation/validation boundary
// synchronously reprojects the supported semantic scope, including competitors.
export class SemanticRuntime {
    constructor(runtime) {
        this.runtime = runtime;
        this.sessions = new Map();
        this.creating = new Map();
        this.boundEvent = (source, method, params) => this.onEvent(source, method, params || {});
        runtime.chrome.debugger.onEvent?.addListener(this.boundEvent);
    }

    validateOwner(params) {
        if (typeof params.owner !== 'string' || !params.owner || params.owner.length > 256) throw failure('invalid_argument', 'a bounded task owner is required');
        if (!Number.isInteger(params.tab_id) || params.tab_id < 0) throw failure('invalid_argument', 'tab_id must be a nonnegative integer');
    }

    async ensure(tabId) {
        if (this.creating.has(tabId)) return this.creating.get(tabId);
        if (this.sessions.has(tabId)) return this.sessions.get(tabId);
        if (this.sessions.size + this.creating.size >= MAX_TABS) {
            await this.evictIdle();
            if (this.sessions.size + this.creating.size >= MAX_TABS) throw failure('observation_capacity', 'too many browser observation sessions');
        }
        const pending = this.create(tabId);
        this.creating.set(tabId, pending);
        try { return await pending; } finally { this.creating.delete(tabId); }
    }

    async create(tabId) {
        await this.evictIdle();
        if (this.sessions.size >= MAX_TABS) throw failure('observation_capacity', 'too many browser observation sessions');
        const attached = await this.runtime.attachControl({ tab_id: tabId });
        const session = { tabId, generation: token(), leases: new Map(), frames: new Map(), targets: new Map(),
            index: new Map(), history: new Map(), dirty: new Set(), revision: 0, tail: Promise.resolve(), lastUsed: Date.now(),
            ownsAttachment: !attached.already_attached, pending: new Set(), valid: true };
        this.sessions.set(tabId, session);
        try {
            await this.enableTarget(session, '');
            await this.refreshFrames(session);
            this.scheduleCleanup(session);
            return session;
        } catch (error) {
            this.sessions.delete(tabId);
            if (session.ownsAttachment) await this.runtime.detachControl({ tab_id: tabId }).catch(() => {});
            throw error;
        }
    }

    async enableTarget(session, sessionId, parentSession = '') {
        if (!session.valid) return;
        const target = session.targets.get(sessionId) || { sessionId, parentSession, epoch: token(), contexts: new Map() };
        session.targets.set(sessionId, target);
        const debuggee = this.debuggee(session, sessionId);
        for (const method of ['Page.enable', 'Runtime.enable', 'Accessibility.enable', 'DOM.enable']) {
            await this.runtime.sendDebugCommand(debuggee, method, {});
        }
        // Capture owns pause-before-network-enable while it is active. Changing
        // its auto-attach policy here could lose first requests or strand workers.
        if (!this.runtime.isCapturingTab(session.tabId)) await this.configureAutoAttach(debuggee);
    }

    configureAutoAttach(debuggee) {
        return this.runtime.sendDebugCommand(debuggee, 'Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
            filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
        });
    }

    async restoreAutoAttach(tabId) {
        const session = this.sessions.get(tabId);
        if (!session) return;
        for (const target of session.targets.values()) await this.configureAutoAttach(this.debuggee(session, target.sessionId));
    }

    debuggee(session, sessionId = '') { return sessionId ? { tabId: session.tabId, sessionId } : { tabId: session.tabId }; }

    onEvent(source, method, params) {
        const session = this.sessions.get(source?.tabId);
        if (!session) return;
        const sessionId = source.sessionId || '';
        const target = session.targets.get(sessionId);
        if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
            const pending = this.enableTarget(session, params.sessionId, sessionId)
                .then(() => { const child = session.targets.get(params.sessionId); if (child) child.setupError = false; })
                .catch(() => { const child = session.targets.get(params.sessionId); if (child) child.setupError = true; })
                .finally(() => session.pending.delete(pending));
            session.pending.add(pending);
        } else if (method === 'Target.detachedFromTarget') {
            this.removeTarget(session, params.sessionId);
        } else if (method === 'Runtime.executionContextCreated' && target) {
            const context = params.context;
            if (context?.auxData?.isDefault && context.auxData.frameId) target.contexts.set(context.auxData.frameId, context.id);
        } else if (method === 'Runtime.executionContextDestroyed' && target) {
            for (const [id, context] of target.contexts) if (context === params.executionContextId) target.contexts.delete(id);
        } else if ((method === 'Runtime.executionContextsCleared' || method === 'DOM.documentUpdated') && target) {
            target.epoch = token();
            if (method === 'Runtime.executionContextsCleared') target.contexts.clear();
        }
        if (/^(Accessibility|DOM|Page|Runtime|Target)\./.test(method)) {
            session.revision++;
            session.dirty.add(sessionId);
        }
    }

    removeTarget(session, sessionId) {
        for (const child of [...session.targets.values()]) if (child.parentSession === sessionId && child.sessionId !== sessionId) this.removeTarget(session, child.sessionId);
        session.targets.delete(sessionId);
        for (const [id, frame] of session.frames) if (frame.sessionId === sessionId) { session.frames.delete(id); session.index.delete(id); }
    }

    detached(source) {
        const session = this.sessions.get(source?.tabId);
        if (!session) return;
        if (source.sessionId) { this.removeTarget(session, source.sessionId); return; }
        session.valid = false;
        clearTimeout(session.timer);
        this.sessions.delete(source.tabId);
    }

    reconnect() {
        // Existing renderer sessions may survive host restart, but old handles and
        // leases cannot. A new host must explicitly reacquire them.
        for (const session of this.sessions.values()) {
            session.generation = token();
            session.leases.clear();
            session.index.clear();
            session.history?.clear();
            for (const target of session.targets.values()) target.epoch = token();
            this.scheduleCleanup(session);
        }
    }

    expireLeases(session) {
        for (const [id, lease] of session.leases) if (lease.expires <= Date.now()) session.leases.delete(id);
    }

    async acquire(params) {
        this.validateOwner(params);
        if (!['observe', 'execute'].includes(params.purpose)) throw failure('invalid_argument', 'lease purpose must be observe or execute');
        if (params.purpose === 'execute' && this.runtime.isCapturingTab(params.tab_id)) throw failure('tab_busy', 'tab has an active capture');
        const session = await this.ensure(params.tab_id);
        this.expireLeases(session);
        if (params.purpose === 'execute' && [...session.leases.values()].some(lease => lease.purpose === 'execute')) throw failure('tab_busy', 'tab has an active execution owner');
        const id = token();
        session.leases.set(id, { owner: params.owner, purpose: params.purpose, expires: Date.now() + LEASE_MS });
        session.lastUsed = Date.now();
        this.scheduleCleanup(session);
        return { lease_id: id, generation: session.generation };
    }

    lease(params) {
        this.validateOwner(params);
        const session = this.sessions.get(params.tab_id);
        if (!session?.valid) throw failure('stale_session', 'browser observation session is unavailable');
        this.expireLeases(session);
        const lease = session.leases.get(params.lease_id);
        if (!lease || lease.owner !== params.owner) throw failure('invalid_lease', 'browser lease is absent, expired or owned by another task');
        lease.expires = Date.now() + LEASE_MS;
        session.lastUsed = Date.now();
        return { session, lease };
    }

    async release(params) {
        this.validateOwner(params);
        const session = this.sessions.get(params.tab_id);
        if (!session) return { released: false };
        const lease = session.leases.get(params.lease_id);
        if (!lease) return { released: false };
        if (lease.owner !== params.owner) throw failure('invalid_lease', 'lease belongs to another task');
        session.leases.delete(params.lease_id);
        session.lastUsed = Date.now();
        this.scheduleCleanup(session);
        return { released: true };
    }

    async withLease(params, work) {
        let effective = params, temporary;
        if (!params.lease_id) {
            temporary = await this.acquire({ ...params, purpose: 'observe' });
            effective = { ...params, lease_id: temporary.lease_id };
        }
        try {
            const { session } = this.lease(effective);
            return await this.enqueue(session, () => work(session, effective));
        } finally { if (temporary) await this.release(effective); }
    }

    enqueue(session, work) {
        const result = session.tail.catch(() => {}).then(() => {
            if (!session.valid) throw failure('stale_session', 'browser was detached');
            return work();
        });
        session.tail = result.catch(() => {});
        return result;
    }

    async refreshFrames(session) {
        // Recursive child attachment setup can enqueue another child; drain to a
        // bounded stable point, then account for missing routes in coverage.
        for (let pass = 0; session.pending.size && pass < 16; pass++) await Promise.allSettled([...session.pending]);
        const next = new Map();
        let rootID = '';
        const targets = [...session.targets.values()];
        const depth = target => { let n = 0, current = target; const seen = new Set(); while (current.sessionId && !seen.has(current.sessionId)) { seen.add(current.sessionId); n++; current = session.targets.get(current.parentSession) || { sessionId: '' }; } return n; };
        targets.sort((a, b) => depth(a) - depth(b));
        for (const target of targets) {
            let tree;
            try { tree = await this.runtime.sendDebugCommand(this.debuggee(session, target.sessionId), 'Page.getFrameTree', {}); }
            catch (error) { if (!target.sessionId) throw error; target.readError = true; continue; }
            if (!tree?.frameTree?.frame?.id) { if (!target.sessionId) throw failure('invalid_frame_tree', 'browser returned no root frame'); target.readError = true; continue; }
            target.readError = false;
            if (!target.sessionId) rootID = tree.frameTree.frame.id;
            const walk = (branch, parentID = '', level = 0) => {
                if (level > 64 || next.size >= 1000) throw failure('frame_budget_exceeded', 'frame tree exceeds supported bounds');
                const frame = branch.frame;
                if (!frame?.id) throw failure('invalid_frame_tree', 'browser returned invalid frame identity');
                const previous = session.frames.get(frame.id);
                const identity = JSON.stringify([frame.loaderId || '', frame.url || '', target.sessionId, target.epoch]);
                next.set(frame.id, { id: frame.id, parentID: parentID || frame.parentId || next.get(frame.id)?.parentID || previous?.parentID || '', loaderID: frame.loaderId || '', url: frame.url || '', sessionId: target.sessionId,
                    identity, documentGeneration: previous?.identity === identity ? previous.documentGeneration : token(), contextID: target.contexts.get(frame.id) });
                for (const child of branch.childFrames || []) walk(child, frame.id, level + 1);
            };
            walk(tree.frameTree);
        }
        session.frames = next;
        session.rootID = rootID;
        for (const [key, entry] of session.index) {
            const frame = next.get(entry.frameID || key);
            if (!frame || (entry.documentGeneration && entry.documentGeneration !== frame.documentGeneration)) session.index.delete(key);
        }
        return [...next.values()].map(frame => [frame.id, frame.documentGeneration, frame.parentID]).sort((a, b) => a[0].localeCompare(b[0]));
    }

    async capture(session, params) {
        const kind = params.kind || 'controls';
        if (!['controls', 'text', 'all'].includes(kind)) throw failure('invalid_argument', 'invalid observation kind');
        const requestedOrigin = params.origin || '';
        if (requestedOrigin && originOf(requestedOrigin) !== requestedOrigin.replace(/\/$/, '')) throw failure('invalid_argument', 'origin must be an HTTP(S) origin');
        const rootBackend = params.root_backend_dom_node_id || 0;
        if (!Number.isSafeInteger(rootBackend) || rootBackend < 0 || (rootBackend && !params.frame_id && !params.frame_url)) throw failure('invalid_scope', 'subtree observation requires a positive backend node and explicit frame scope');
        const before = JSON.stringify(await this.refreshFrames(session));
        const root = session.frames.get(session.rootID);
        if (requestedOrigin && originOf(root?.url) !== requestedOrigin.replace(/\/$/, '')) throw failure('origin_mismatch', 'page origin does not match requested origin');
        const coverage = { total_candidates: 0, considered: 0, truncated: false, frames_read: 0, unavailable_frames: 0, omitted_nodes: 0, text_truncated: 0, frame_issues: [] };
        const scopedFrames = [...session.frames.values()].filter(frame => (!params.frame_id || frame.id === params.frame_id) && (!params.frame_url || frame.url === params.frame_url));
        if (!scopedFrames.length) throw failure('frame_unavailable', 'requested frame is unavailable');
        if ((params.frame_url && !params.frame_id || rootBackend) && scopedFrames.length !== 1) throw failure('ambiguous_frame', 'scope must resolve to exactly one frame');
        const candidates = [], evidence = [1, session.generation, kind, requestedOrigin, params.frame_id || '', params.frame_url || '', rootBackend, root?.documentGeneration, await digest(root?.url || '')];
        const documentKey = JSON.stringify([root?.documentGeneration, ...scopedFrames.map(frame => [frame.id, frame.documentGeneration])]);
        let count = 0, projectionBytes = 0, totalNodes = 0, scope;
        for (const frame of scopedFrames) {
            evidence.push([frame.id, frame.documentGeneration, await digest(frame.url)]);
            let unavailable = count++ >= MAX_FRAMES ? 'frame_limit' : '';
            if (requestedOrigin && originOf(frame.url) !== requestedOrigin.replace(/\/$/, '')) unavailable = 'outside_origin';
            if (!unavailable) {
                try {
                    let response, scoped;
                    if (rootBackend) {
                        const generation = session.generation, targetEpoch = session.targets.get(frame.sessionId)?.epoch;
                        scoped = await readAXScope((method, command) => this.runtime.sendDebugCommand(this.debuggee(session, frame.sessionId), method, command), {
                            backendDOMNodeId: rootBackend, frameId: frame.id,
                            assertCurrent: () => {
                                if (!session.valid || session.generation !== generation || session.targets.get(frame.sessionId)?.epoch !== targetEpoch) throw failure('stale_document', 'document changed during subtree observation');
                            },
                        });
                        response = { nodes: scoped.nodes };
                        coverage.omitted_nodes += scoped.coverage.omittedNodes;
                        if (!scoped.coverage.complete) coverage.frame_issues.push({ frame_id: frame.id, reason: 'scope_incomplete' });
                        const contextRoot = scoped.nodes.find(node => node.nodeId === scoped.contextRootNodeID);
                        scope = { frame_id: frame.id, root_backend_dom_node_id: rootBackend, context_root_backend_dom_node_id: contextRoot?.backendDOMNodeId || 0,
                            context_expanded: scoped.contextExpanded, nodes_read: scoped.nodes.length, ax_calls: scoped.calls, complete: scoped.coverage.complete, issues: scoped.coverage.issues };
                        evidence.push([rootBackend, scoped.contextRootNodeID, scoped.coverage.issues]);
                    } else {
                        response = await this.runtime.sendDebugCommand(this.debuggee(session, frame.sessionId), 'Accessibility.getFullAXTree', { frameId: frame.id });
                    }
                    if (!Array.isArray(response?.nodes) || response.nodes.length === 0 || response.nodes.length > MAX_NODES || new TextEncoder().encode(JSON.stringify(response)).length > MAX_AX_BYTES) throw failure('invalid_ax_tree', 'accessibility evidence budget exceeded or empty');
                    const remaining = Math.max(0, MAX_NODES - totalNodes);
                    coverage.omitted_nodes += Math.max(0, response.nodes.length - remaining);
                    totalNodes += response.nodes.length;
                    const projection = await projectAX(response.nodes.slice(0, remaining), frame, kind, {
                        maxCandidates: Math.max(0, MAX_CANDIDATES - candidates.length), maxBytes: Math.max(0, MAX_PROJECTION_BYTES - projectionBytes),
                        allowedNodeIDs: scoped?.allowedNodeIDs,
                    });
                    // Cache identity includes the actual document and explicit
                    // subtree. An entry is never a substitute for a fresh read.
                    const indexKey = JSON.stringify([frame.id, frame.documentGeneration, kind, requestedOrigin, rootBackend]);
                    session.index.delete(indexKey);
                    session.index.set(indexKey, { frameID: frame.id, documentGeneration: frame.documentGeneration, candidates: projection.candidates, bytes: projection.bytes, fingerprint: await digest(JSON.stringify(projection.evidence)) });
                    let retainedBytes = [...session.index.values()].reduce((sum, item) => sum + item.bytes, 0);
                    for (const [id, entry] of session.index) {
                        if (retainedBytes <= MAX_PROJECTION_BYTES) break;
                        retainedBytes -= entry.bytes;
                        session.index.delete(id);
                    }
                    candidates.push(...projection.candidates);
                    evidence.push(projection.evidence);
                    coverage.frames_read++;
                    coverage.omitted_nodes += projection.omittedNodes;
                    coverage.text_truncated += projection.textTruncated;
                    coverage.total_candidates += projection.totalCandidates;
                    projectionBytes += projection.bytes;
                } catch (error) {
                    // Losing an explicitly selected root must never broaden to
                    // the page, another frame, or a different observation tier.
                    if (rootBackend) throw error;
                    if (frame.id === session.rootID) throw failure('accessibility_unavailable', 'cannot read top-frame accessibility evidence');
                    unavailable = 'accessibility_unavailable';
                }
            }
            if (unavailable) { coverage.frame_issues.push({ frame_id: frame.id, reason: unavailable }); evidence.push(unavailable); }
        }
        if (before !== JSON.stringify(await this.refreshFrames(session))) throw failure('page_changed', 'page frames changed during observation');
        if (session.pending.size || [...session.targets.values()].some(target => target.setupError || target.readError)) {
            coverage.frame_issues.push({ frame_id: session.rootID, reason: 'related_targets_unavailable' });
            evidence.push('related_targets_unavailable');
        }
        coverage.considered = candidates.length;
        coverage.truncated = coverage.omitted_nodes > 0 || candidates.length < coverage.total_candidates;
        coverage.observed_candidates = coverage.total_candidates;
        coverage.total_candidates = candidates.length;
        coverage.unavailable_frames = coverage.frame_issues.length;
        evidence.push(coverage.omitted_nodes);
        const snapshot = { schema: 1, generation: session.generation, fingerprint: await digest(JSON.stringify(evidence)), candidates, coverage, ...(scope ? { scope } : {}), full: true };
        session.snapshot = snapshot;
        session.dirty.clear();
        session.history ||= new Map();
        const key = scopeKey(params), historyKey = `${key}\0${snapshot.fingerprint}`;
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
        session.history.delete(historyKey);
        session.history.set(historyKey, { scopeKey: key, snapshot, documentKey, bytes });
        let retained = [...session.history.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const [id, entry] of session.history) {
            if (session.history.size <= MAX_HISTORY_ENTRIES && retained <= MAX_HISTORY_BYTES) break;
            retained -= entry.bytes; session.history.delete(id);
        }
        session.lastDocumentKey = documentKey;
        return snapshot;
    }

    observe(params) {
        return this.withLease(params, async session => {
            const since = params.since || params.since_fingerprint || '';
            if (typeof since !== 'string' || since.length > 128) throw failure('invalid_argument', 'since must be a bounded snapshot fingerprint');
            const previous = since && session.history?.get(`${scopeKey(params)}\0${since}`);
            const snapshot = await this.capture(session, params);
            if (!previous || previous.documentKey !== session.lastDocumentKey || previous.snapshot.generation !== snapshot.generation) return snapshot;
            const { candidates, ...metadata } = snapshot;
            return { ...metadata, full: false, delta: { base_fingerprint: since, ...candidateDelta(previous.snapshot.candidates, candidates) } };
        });
    }

    validate(params) {
        return this.withLease(params, async session => {
            const snapshot = await this.capture(session, params);
            return { fresh: params.generation === snapshot.generation && params.fingerprint === snapshot.fingerprint, snapshot };
        });
    }

    activeExecution(tabId) {
        const session = this.sessions.get(tabId);
        if (!session) return false;
        this.expireLeases(session);
        return [...session.leases.values()].some(lease => lease.purpose === 'execute');
    }

    async guardFramePoint(session, frame, input) {
        let point = input, current = frame;
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw failure('invalid_argument', 'frame_point requires finite x and y');
        const visited = new Set();
        while (current.id !== session.rootID) {
            if (visited.has(current.id)) throw failure('frame_route_incomplete', 'cyclic parent frame route');
            visited.add(current.id);
            const parent = session.frames.get(current.parentID);
            if (!parent) throw failure('frame_route_incomplete', 'frame parent is unavailable');
            const debuggee = this.debuggee(session, parent.sessionId);
            const owner = await this.runtime.sendDebugCommand(debuggee, 'DOM.getFrameOwner', { frameId: current.id });
            const resolved = await this.runtime.sendDebugCommand(debuggee, 'DOM.resolveNode', {
                backendNodeId: owner.backendNodeId, ...(parent.contextID ? { executionContextId: parent.contextID } : {}), objectGroup: 'rep-frame-guard',
            });
            const objectId = resolved.object?.objectId;
            if (!objectId) throw failure('frame_owner_unavailable', 'cannot resolve frame owner');
            let checked;
            try {
                checked = await this.runtime.sendDebugCommand(debuggee, 'Runtime.callFunctionOn', {
                    objectId, returnByValue: true, arguments: [{ value: point }],
                    functionDeclaration: `function(point) {
                        if (!this.isConnected) return {code:'frame_owner_detached'};
                        const rect=this.getBoundingClientRect(), style=getComputedStyle(this);
                        if (rect.width<=0||rect.height<=0||style.visibility!=='visible'||style.display==='none') return {code:'frame_owner_hidden'};
                        for(let node=this;node;node=node.parentElement||node.getRootNode()?.host) {
                            const css=getComputedStyle(node);
                            if(css.transform!=='none'||(css.rotate&&css.rotate!=='none')||(css.scale&&css.scale!=='none')||(css.translate&&css.translate!=='none')||css.perspective!=='none'||(css.zoom&&css.zoom!=='1'&&css.zoom!=='normal')) return {code:'frame_transform_unsupported'};
                            if(node.hidden||node.inert||node.getAttribute('aria-hidden')==='true') return {code:'frame_owner_hidden'};
                        }
                        if(['paddingLeft','paddingTop','paddingRight','paddingBottom'].some(name=>parseFloat(style[name])!==0)) return {code:'frame_padding_unsupported'};
                        if(point.x<0||point.y<0||point.x>=this.clientWidth||point.y>=this.clientHeight) return {code:'frame_point_outside'};
                        const x=rect.left+this.clientLeft+point.x,y=rect.top+this.clientTop+point.y;
                        for(let expected=this;expected;) {
                            const root=expected.getRootNode(), hit=root.elementFromPoint?.(x,y);
                            if(!hit||(hit!==expected&&!expected.contains(hit))) return {code:'frame_owner_occluded'};
                            expected=root.host||null;
                        }
                        return {point:{x,y}};
                    }`,
                });
            } finally { await this.runtime.sendDebugCommand(debuggee, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
            const value = checked?.result?.value;
            if (!value?.point || checked.exceptionDetails) throw failure(value?.code || 'frame_guard_failed', 'ancestor frame could not receive the intended input');
            point = value.point;
            current = parent;
        }
    }

    async cdp(params) {
        let dispatched = false;
        try {
            const { session, lease } = this.lease(params);
            return await this.enqueue(session, async () => {
                this.lease(params);
                if (params.generation && params.generation !== session.generation) throw failure('stale_session', 'browser session generation changed');
                const method = String(params.method || '');
                if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(method)) throw failure('invalid_argument', 'invalid CDP method');
                if (lease.purpose !== 'execute' && !readMethods.has(method) && !method.startsWith('Accessibility.')) throw failure('execution_lease_required', 'this command requires an execution lease');
                await this.refreshFrames(session);
                const frame = session.frames.get(params.frame_id || session.rootID);
                if (!frame || (params.session_id && frame.sessionId !== params.session_id)) throw failure('stale_frame', 'frame route is no longer available');
                if (params.document_generation && frame.documentGeneration !== params.document_generation) throw failure('stale_document', 'frame document changed');
                if (params.expected_root_url && session.frames.get(session.rootID)?.url !== params.expected_root_url) throw failure('page_changed', 'root page URL changed');
                if (params.expected_frame_url && frame.url !== params.expected_frame_url) throw failure('page_changed', 'frame URL changed');
                if (params.frame_point) await this.guardFramePoint(session, frame, params.frame_point);
                const command = params.command_params == null ? {} : { ...params.command_params };
                if (!params.command_params || typeof params.command_params === 'object' && !Array.isArray(params.command_params)) {
                    if (params.frame_id && method === 'Runtime.evaluate') {
                        if (!frame.contextID) throw failure('frame_context_unavailable', 'frame execution context is unavailable');
                        if (command.contextId && command.contextId !== frame.contextID) throw failure('frame_context_mismatch', 'execution context does not match frame');
                        command.contextId = frame.contextID;
                    }
                    if (params.frame_id && method === 'DOM.resolveNode' && frame.contextID) command.executionContextId = frame.contextID;
                } else throw failure('invalid_argument', 'command_params must be an object');
                const debuggee = this.debuggee(session, frame.sessionId);
                dispatched = true;
                const result = await this.runtime.sendDebugCommand(debuggee, method, command);
                return { method, debuggee, attached: true, context_overrides: {}, result: result ?? {} };
            });
        } catch (error) {
            if (!dispatched) {
                if (!error || typeof error !== 'object') error = failure('browser_guard_failed', 'browser command was rejected before dispatch');
                error.code ||= 'browser_guard_failed';
                error.data = { ...(error.data && typeof error.data === 'object' ? error.data : {}), phase: 'before_dispatch' };
            }
            throw error;
        }
    }

    scheduleCleanup(session) {
        clearTimeout(session.timer);
        session.timer = setTimeout(() => { this.evictIdle().catch(() => {}); }, session.leases.size ? LEASE_MS + 1 : IDLE_MS + 1);
        session.timer.unref?.();
    }

    async evictIdle() {
        for (const [id, session] of this.sessions) {
            this.expireLeases(session);
            if (session.leases.size || Date.now() - session.lastUsed < IDLE_MS || this.runtime.isCapturingTab(id)) { this.scheduleCleanup(session); continue; }
            await session.tail;
            if (session.leases.size) continue;
            session.valid = false;
            clearTimeout(session.timer);
            this.sessions.delete(id);
            if (session.ownsAttachment) await this.runtime.detachControl({ tab_id: id }).catch(() => {});
        }
    }
}
