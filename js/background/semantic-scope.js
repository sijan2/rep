// Explicit AX scopes are refreshed synchronously. Events may schedule a refresh,
// but a quiet event stream never proves that a previously read scope is current.
const failure = (code, message) => Object.assign(new Error(message), { code });
const entities = new Set(['row', 'layouttablerow', 'listitem', 'article']);
const role = node => String(node?.role?.value || '').toLowerCase();
const signature = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/**
 * Read a caller-selected subtree and the context required by projectAX.
 * send(method, params) must already route to the selected frame's CDP session.
 * assertCurrent may reject a changed document; the owner must also compare
 * document identities around the entire capture, including all protocol calls.
 *
 * Ancestors, and an enclosing entity's sibling facts when needed, remain in
 * nodes for context. ONLY allowedNodeIDs may become selectable candidates.
 * A removed root is an error. Missing descendants and budget limits produce
 * explicit incomplete coverage; they never broaden candidate eligibility.
 */
export async function readAXScope(send, {
    backendDOMNodeId, frameId, maxNodes = 4096, maxDepth = 64, maxCalls = 1024,
    assertCurrent = () => {},
} = {}) {
    if (typeof send !== 'function' || !Number.isSafeInteger(backendDOMNodeId) || backendDOMNodeId <= 0 || typeof frameId !== 'string' || !frameId) {
        throw failure('invalid_scope', 'a positive backend node and one explicit frame are required');
    }
    for (const [name, value, cap] of [['maxNodes', maxNodes, 100000], ['maxDepth', maxDepth, 256], ['maxCalls', maxCalls, 100000]]) {
        if (!Number.isInteger(value) || value < 1 || value > cap) throw failure('invalid_scope', `${name} is outside supported bounds`);
    }
    const coverage = { complete: true, truncated: false, omittedNodes: 0, issues: [] };
    const problems = new Set();
    const issue = (code, id = '', truncated = false) => {
        const key = `${code}:${id}`;
        if (!problems.has(key)) {
            problems.add(key); coverage.omittedNodes++;
            if (coverage.issues.length < 64) coverage.issues.push({ code, node_id: id });
        }
        coverage.complete = false; coverage.truncated ||= truncated;
    };
    let calls = 0;
    const read = async (method, params, initial = false) => {
        await assertCurrent();
        if (calls >= maxCalls) { issue('scope_call_limit', params.id || '', true); return null; }
        calls++;
        let response;
        try { response = await send(method, params); }
        catch (_) { throw failure(initial ? 'scope_root_stale' : 'scope_changed', initial ? 'the requested subtree root is unavailable' : 'the subtree changed while it was being read'); }
        await assertCurrent();
        if (!Array.isArray(response?.nodes)) throw failure('invalid_ax_scope', 'browser returned invalid subtree evidence');
        if (new TextEncoder().encode(JSON.stringify(response)).length > 16 * 1024 * 1024) throw failure('scope_evidence_budget', 'subtree protocol response exceeded its byte budget');
        if (response.nodes.length > maxNodes) { issue('scope_response_limit', params.id || '', true); return response.nodes.slice(0, maxNodes); }
        return response.nodes;
    };
    const initial = await read('Accessibility.getAXNodeAndAncestors', { backendNodeId: backendDOMNodeId }, true);
    const roots = initial.filter(node => node.backendDOMNodeId === backendDOMNodeId);
    if (roots.length !== 1 || !roots[0].nodeId || roots[0].nodeId === '0') throw failure('scope_root_stale', 'the requested subtree root has no current accessibility identity');
    const root = roots[0], rootNodeID = root.nodeId;
    const initialByID = new Map(initial.filter(node => typeof node.nodeId === 'string' && node.nodeId).map(node => [node.nodeId, node]));
    const nodes = new Map(), ancestorIDs = new Set();
    let current = root, contextRoot = root, frameProved = false, depth = 0;
    // AX ancestry can cross a same-process iframe boundary. Stop at the selected
    // frame's root rather than importing its parent's page as local context.
    while (current) {
        if (ancestorIDs.has(current.nodeId)) { issue('scope_ancestor_cycle', current.nodeId); break; }
        if (depth++ >= maxDepth || nodes.size >= maxNodes) { issue('scope_ancestor_limit', current.nodeId, true); break; }
        if (current.frameId) {
            if (current.frameId !== frameId) throw failure('scope_frame_mismatch', 'subtree root belongs to another frame');
            frameProved = true;
        }
        ancestorIDs.add(current.nodeId);
        const atFrameRoot = current.frameId === frameId && ['rootwebarea', 'webarea'].includes(role(current));
        nodes.set(current.nodeId, atFrameRoot ? { ...current, parentId: undefined } : current);
        if (contextRoot === root && !entities.has(role(root)) && current !== root && entities.has(role(current))) contextRoot = current;
        if (atFrameRoot || !current.parentId) break;
        const parent = initialByID.get(current.parentId);
        if (!parent) { issue('scope_ancestor_missing', current.parentId); break; }
        current = parent;
    }
    // An incomplete ancestor path cannot prove a cross-frame route. Report the
    // lack of evidence through coverage; a contradictory frame is always fatal.
    if (!frameProved) issue('scope_frame_unproven', rootNodeID);
    const contextRootNodeID = contextRoot.nodeId;
    const visited = new Set(), queue = [{ id: contextRootNodeID, depth: 0 }];
    const descendant = (id, target, byID) => {
        const seen = new Set();
        while (id) {
            if (id === target) return true;
            if (seen.has(id)) { issue('scope_child_cycle', id); return false; }
            seen.add(id);
            const node = byID.get(id);
            if (!node) return false;
            id = node.parentId;
        }
        return false;
    };
    while (queue.length) {
        const item = queue.shift();
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        const parent = nodes.get(item.id);
        if (!parent) { issue('scope_child_missing', item.id); continue; }
        const expected = Array.isArray(parent.childIds) ? parent.childIds : [];
        if (!expected.length && !(parent.ignored && parent.childIds === undefined)) continue;
        if (item.depth >= maxDepth) { issue('scope_depth_limit', item.id, true); continue; }
        if (nodes.size >= maxNodes) { issue('scope_node_limit', item.id, true); continue; }
        const children = await read('Accessibility.getChildAXNodes', { id: item.id, frameId });
        if (children === null) break;
        const incoming = new Map();
        for (const node of children) {
            if (typeof node?.nodeId !== 'string' || !node.nodeId) { issue('scope_invalid_node', item.id); continue; }
            if (node.frameId && node.frameId !== frameId) { issue('scope_child_frame_mismatch', node.nodeId); continue; }
            if (incoming.has(node.nodeId) && signature(incoming.get(node.nodeId)) !== signature(node)) throw failure('scope_changed', 'conflicting subtree identities were returned');
            incoming.set(node.nodeId, !node.parentId && expected.includes(node.nodeId) ? { ...node, parentId: item.id } : node);
        }
        for (const id of expected) if (!incoming.has(id)) issue('scope_child_missing', id);
        const combined = new Map([...nodes, ...incoming]);
        for (const [id, node] of incoming) {
            if (id === item.id || (expected.includes(id) && descendant(item.id, id, combined))) { issue('scope_child_cycle', id); continue; }
            if (!descendant(id, contextRootNodeID, combined)) { issue('scope_unrelated_child', id); continue; }
            const previous = nodes.get(id);
            if (previous && signature(previous) !== signature(node)) throw failure('scope_changed', 'subtree facts changed between protocol reads');
            if (!previous && nodes.size >= maxNodes) { issue('scope_node_limit', id, true); continue; }
            nodes.set(id, node);
            let childDepth = 0, parentID = id;
            while (parentID !== contextRootNodeID && combined.has(parentID) && childDepth <= maxDepth) { parentID = combined.get(parentID).parentId; childDepth++; }
            if (!visited.has(id)) queue.push({ id, depth: childDepth });
        }
    }
    await assertCurrent();
    const allowedNodeIDs = new Set([...nodes.keys()].filter(id => descendant(id, rootNodeID, nodes)));
    if (!allowedNodeIDs.has(rootNodeID)) throw failure('scope_root_stale', 'subtree root was lost while reading');
    return { nodes: [...nodes.values()], allowedNodeIDs, rootNodeID, contextRootNodeID,
        contextExpanded: contextRootNodeID !== rootNodeID, coverage, calls };
}

// A delta is only meaningful for the exact same explicit scope and generation.
// Callers retain a bounded prior view; an absent base requires a full response.
export function candidateDelta(previous, current) {
    const before = new Map(previous.map(candidate => [candidate.id, candidate]));
    const upserted = [], removed = [];
    for (const candidate of current) {
        if (!before.has(candidate.id) || signature(before.get(candidate.id)) !== signature(candidate)) upserted.push(candidate);
        before.delete(candidate.id);
    }
    for (const id of before.keys()) removed.push(id);
    return { upserted, removed };
}
