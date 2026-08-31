import { buildStableRequestId } from '../core/utils/hash.js';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_MS = 800;
const DEFAULT_BODY_LIMIT = 384 * 1024;
const MAX_BODY_LIMIT = 768 * 1024;
const NATIVE_BATCH_LIMIT = 720 * 1024;
const MAX_EXPRESSION_BYTES = 768 * 1024;
const DEFAULT_ACTION_RESULT_LIMIT = 64 * 1024;
const MAX_ACTION_RESULT_LIMIT = 256 * 1024;
const DEFAULT_ACTION_SETTLE_MS = 1500;
const MAX_ACTION_SETTLE_MS = 10000;
const NON_BLOCKING_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping']);

export class CDPCaptureController {
    constructor({ chromeApi = globalThis.chrome, emit = () => true } = {}) {
        this.chrome = chromeApi;
        this.emit = emit;
        this.sessions = new Map();
        this.controlAttachments = new Map();
        this.captureTail = Promise.resolve();
        this.queuedCaptures = 0;
        this.captureOperationActive = false;
        this.pendingPersistentAttachments = 0;
        this.reloadPending = false;
        this.boundEvent = (source, method, params) => this.handleDebuggerEvent(source, method, params);
        this.boundDetach = (source, reason) => this.handleDebuggerDetach(source, reason);
        this.chrome.debugger.onEvent.addListener(this.boundEvent);
        this.chrome.debugger.onDetach.addListener(this.boundDetach);
    }

    isCapturingTab(tabId) {
        return this.sessions.has(Number(tabId));
    }

    async status(bridgeStatus = {}) {
        const [tabs, platform, debuggerGranted] = await Promise.all([
            this.queryTabs({}),
            this.call(this.chrome.runtime, 'getPlatformInfo').catch(() => ({})),
            this.containsPermissions({ permissions: ['debugger'] }),
        ]);
        return {
            connected: true,
            bridge: bridgeStatus,
            extension_id: this.chrome.runtime.id,
            extension_version: this.chrome.runtime.getManifest().version,
            user_agent: globalThis.navigator?.userAgent || '',
            platform,
            tabs: tabs.length,
            active_captures: this.captureOperationActive ? 1 : this.sessions.size,
            queued_captures: this.queuedCaptures,
            attached_targets: this.controlAttachments.size,
            reload_pending: this.reloadPending,
            permissions: { debugger: debuggerGranted },
            capabilities: [
                'tabs', 'targets', 'background_tab_create', 'background_navigation', 'network_capture', 'response_bodies',
                'session_fetch', 'runtime_evaluate', 'raw_cdp', 'persistent_debugger_attachment',
                'captured_action', 'native_browser_identity', 'extension_self_reload',
            ],
        };
    }

    async listTabs() {
        const tabs = await this.queryTabs({});
        return tabs
            .filter((tab) => tab.id != null)
            .map((tab) => ({
                id: tab.id,
                window_id: tab.windowId,
                active: Boolean(tab.active),
                pinned: Boolean(tab.pinned),
                incognito: Boolean(tab.incognito),
                discarded: Boolean(tab.discarded),
                status: tab.status || '',
                title: tab.title || '',
                url: tab.url || tab.pendingUrl || '',
            }));
    }

    async listTargets() {
        const targets = await this.call(this.chrome.debugger, 'getTargets');
        return (targets || []).map((target) => ({
            id: target.id,
            tab_id: target.tabId,
            type: target.type || '',
            attached: Boolean(target.attached),
            title: target.title || '',
            url: target.url || '',
        }));
    }

    async attachControl(params = {}) {
        this.assertReloadNotPending('attach a debugger target');
        this.pendingPersistentAttachments += 1;
        try {
            const debuggee = await this.resolveDebuggee(params);
            const key = debuggeeKey(debuggee);
            if (debuggee.tabId != null && this.sessions.has(debuggee.tabId)) {
                throw rpcError('tab_busy', `tab ${debuggee.tabId} has an active capture`);
            }
            if (this.controlAttachments.has(key)) {
                return { attached: true, already_attached: true, debuggee, context_overrides: {} };
            }
            await this.debugAttachTarget(debuggee);
            const contextOverrides = await this.prepareRealBrowserContext(debuggee);
            this.controlAttachments.set(key, debuggee);
            return { attached: true, already_attached: false, debuggee, context_overrides: contextOverrides };
        } finally {
            this.pendingPersistentAttachments -= 1;
        }
    }

    async detachControl(params = {}) {
        const debuggee = await this.resolveDebuggee(params);
        const key = debuggeeKey(debuggee);
        if (!this.controlAttachments.has(key)) {
            return { attached: false, already_detached: true, debuggee };
        }
        await this.debugDetachTarget(debuggee);
        this.controlAttachments.delete(key);
        return { attached: false, already_detached: false, debuggee };
    }

    async sendCDP(params = {}) {
        this.assertReloadNotPending('send a CDP command');
        const persistentRequested = Boolean(params.keep_attached);
        if (persistentRequested) this.pendingPersistentAttachments += 1;
        try {
            return await this.sendCDPUnlocked(params);
        } finally {
            if (persistentRequested) this.pendingPersistentAttachments -= 1;
        }
    }

    async sendCDPUnlocked(params = {}) {
        const debuggee = await this.resolveDebuggee(params);
        const method = String(params.method || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(method)) {
            throw rpcError('invalid_argument', 'method must be a CDP Domain.command name');
        }
        const commandParams = params.command_params == null ? {} : params.command_params;
        if (!commandParams || typeof commandParams !== 'object' || Array.isArray(commandParams)) {
            throw rpcError('invalid_argument', 'command_params must be a JSON object');
        }
        const key = debuggeeKey(debuggee);
        const captureAttached = debuggee.tabId != null && this.sessions.get(debuggee.tabId)?.attached;
        const controlAttached = this.controlAttachments.has(key);
        let temporaryAttachment = false;
        let contextOverrides = {};
        if (!captureAttached && !controlAttached) {
            await this.debugAttachTarget(debuggee);
            temporaryAttachment = true;
            contextOverrides = await this.prepareRealBrowserContext(debuggee);
        }
        try {
            const result = await this.sendDebugCommand(debuggee, method, commandParams);
            if (params.keep_attached && temporaryAttachment) {
                this.controlAttachments.set(key, debuggee);
                temporaryAttachment = false;
            }
            return {
                method,
                debuggee,
                attached: captureAttached || controlAttached || Boolean(params.keep_attached),
                context_overrides: contextOverrides,
                result: result ?? {},
            };
        } finally {
            if (temporaryAttachment) await this.debugDetachTarget(debuggee).catch(() => {});
        }
    }

    reloadBlockers() {
        return {
            active_captures: this.captureOperationActive ? 1 : this.sessions.size,
            queued_captures: this.queuedCaptures,
            attached_targets: this.controlAttachments.size,
            pending_attachments: this.pendingPersistentAttachments,
        };
    }

    beginReload() {
        if (this.reloadPending) {
            throw rpcError('extension_busy', 'extension reload is already pending', {
                ...this.reloadBlockers(),
                reload_pending: true,
            });
        }
        const blockers = this.reloadBlockers();
        if (Object.values(blockers).some((count) => count > 0)) {
            throw rpcError('extension_busy', 'extension reload refused while browser operations are active', blockers);
        }
        this.reloadPending = true;
        return blockers;
    }

    cancelReload() {
        this.reloadPending = false;
    }

    assertReloadNotPending(operation) {
        if (!this.reloadPending) return;
        throw rpcError('extension_reload_pending', `cannot ${operation} while extension reload is pending`);
    }

    async runExplicitCapture(params, operation, task) {
        this.assertReloadNotPending(`start ${operation}`);
        const timeoutMs = clampInteger(params?.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120000);
        const deadlineAt = Date.now() + timeoutMs;
        const previous = this.captureTail;
        let releaseGate;
        let released = false;
        const gate = new Promise((resolve) => { releaseGate = resolve; });
        const release = () => {
            if (released) return;
            released = true;
            releaseGate();
        };
        this.captureTail = gate;
        this.queuedCaptures += 1;

        await previous;
        this.queuedCaptures -= 1;
        try {
            this.assertReloadNotPending(`start ${operation}`);
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs < 1000) {
                throw rpcError('capture_queue_timeout', `${operation} expired while waiting for the active capture`, {
                    timeout_ms: timeoutMs,
                });
            }
            this.captureOperationActive = true;
            return await task({
                ...params,
                timeout_ms: Math.min(timeoutMs, Math.floor(remainingMs)),
            });
        } finally {
            this.captureOperationActive = false;
            release();
        }
    }

    async evaluate(params = {}) {
        const expression = String(params.expression || '');
        if (!expression) throw rpcError('invalid_argument', 'expression is required');
        if (new TextEncoder().encode(expression).length > MAX_EXPRESSION_BYTES) {
            throw rpcError('invalid_argument', `expression exceeds ${MAX_EXPRESSION_BYTES} bytes`);
        }
        return this.sendCDP({
            ...params,
            method: 'Runtime.evaluate',
            command_params: {
                expression,
                awaitPromise: params.await_promise !== false,
                returnByValue: params.return_by_value !== false,
                userGesture: Boolean(params.user_gesture),
                includeCommandLineAPI: true,
                replMode: Boolean(params.repl_mode),
            },
        });
    }

    action(params = {}) {
        return this.runExplicitCapture(params, 'browser action', (boundedParams) => this.actionUnlocked(boundedParams));
    }

    async actionUnlocked(params = {}) {
        const expression = String(params.expression || '');
        if (!expression) throw rpcError('invalid_argument', 'expression is required');
        if (new TextEncoder().encode(expression).length > MAX_EXPRESSION_BYTES) {
            throw rpcError('invalid_argument', `expression exceeds ${MAX_EXPRESSION_BYTES} bytes`);
        }
        const debuggee = await this.resolveDebuggee(params);
        if (debuggee.tabId == null) {
            throw rpcError('invalid_argument', 'captured actions require a page tab or page target');
        }
        const tab = await this.call(this.chrome.tabs, 'get', debuggee.tabId);
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120000);
        const idleMs = clampInteger(params.idle_ms, 300, 100, 10000);
        const requestedSettleMs = clampInteger(
            params.settle_ms,
            DEFAULT_ACTION_SETTLE_MS,
            0,
            MAX_ACTION_SETTLE_MS,
        );
        // Leave enough of the hard timeout for one final idle interval. The
        // timeout still covers debugger setup and the evaluation itself.
        const settleMs = Math.min(requestedSettleMs, Math.max(0, timeoutMs - idleMs));
        const maxBodyBytes = clampInteger(params.max_body_bytes, DEFAULT_BODY_LIMIT, 0, MAX_BODY_LIMIT);
        const maxResultBytes = clampInteger(params.max_result_bytes, DEFAULT_ACTION_RESULT_LIMIT, 0, MAX_ACTION_RESULT_LIMIT);
        const session = await this.startSession(debuggee.tabId, {
            url: tab.url || tab.pendingUrl || 'about:blank',
            timeoutMs,
            idleMs,
            maxBodyBytes,
            captureMode: 'action',
        });

        let evaluation;
        let captureResult;
        try {
            await this.debugCommand(debuggee.tabId, 'Runtime.enable');
            evaluation = await this.debugCommand(debuggee.tabId, 'Runtime.evaluate', {
                expression,
                awaitPromise: params.await_promise !== false,
                returnByValue: params.return_by_value !== false,
                userGesture: Boolean(params.user_gesture),
                includeCommandLineAPI: true,
                replMode: Boolean(params.repl_mode),
            });
            if (evaluation?.exceptionDetails) {
                const description = evaluation.exceptionDetails.exception?.description
                    || evaluation.exceptionDetails.text
                    || 'browser action failed';
                throw rpcError('evaluation_failed', description, evaluation.exceptionDetails);
            }
            session.loaded = true;
            // Runtime.evaluate can return before browser-managed callbacks
            // (Turnstile, postMessage handlers, timers, framework effects)
            // issue their network requests. Keep the capture observable for a
            // bounded minimum window, then require the ordinary idle period.
            session.observeFor(settleMs);
            session.checkIdle();
            captureResult = await session.settled;
        } catch (error) {
            session.fail(error);
            await session.settled.catch(() => {});
            throw error;
        } finally {
            captureResult = captureResult || { timedOut: false, reason: 'failed' };
            await this.finishSession(session, captureResult);
        }

        const boundedEvaluation = boundEvaluationResult(evaluation, maxResultBytes);
        return {
            session_id: session.id,
            tab_id: debuggee.tabId,
            evaluation: boundedEvaluation.value,
            evaluation_bytes: boundedEvaluation.bytes,
            evaluation_truncated: boundedEvaluation.truncated,
            load_state: captureResult.reason,
            timed_out: Boolean(captureResult.timedOut),
            pending_requests: captureResult.pendingRequests || 0,
            settle_ms: settleMs,
            duration_ms: Date.now() - session.startedAt,
            ...summarizeRequests(session.requestList()),
        };
    }

    async probeIdentity(params = {}) {
        const evaluated = await this.evaluate({
            ...params,
            expression: buildIdentityProbeExpression(),
            await_promise: true,
            return_by_value: true,
        });
        if (evaluated.result?.exceptionDetails) {
            throw rpcError('evaluation_failed', evaluated.result.exceptionDetails.text || 'identity probe failed', evaluated.result.exceptionDetails);
        }
        return {
            debuggee: evaluated.debuggee,
            attached: evaluated.attached,
            context_overrides: evaluated.context_overrides,
            identity: evaluated.result?.result?.value ?? null,
        };
    }

    async createTab(params = {}) {
        this.assertReloadNotPending('create a tab');
        const requestedURL = String(params.url || 'about:blank').trim();
        const url = requestedURL === 'about:blank' ? requestedURL : normalizeURL(requestedURL);
        const tab = await this.call(this.chrome.tabs, 'create', {
            url,
            active: Boolean(params.active),
        });
        return {
            created: true,
            tab_id: tab.id,
            window_id: tab.windowId,
            active: Boolean(tab.active),
            status: tab.status || '',
        };
    }

    async closeTab(params = {}) {
        const tabId = Number(params.tab_id);
        if (!Number.isInteger(tabId) || tabId < 0) throw rpcError('invalid_argument', 'tab_id must be a non-negative integer');
        if (this.isCapturingTab(tabId)) throw rpcError('tab_busy', `tab ${tabId} has an active capture`);
        await this.call(this.chrome.tabs, 'remove', tabId);
        return { closed: true, tab_id: tabId };
    }

    open(params = {}) {
        return this.runExplicitCapture(params, 'browser open', (boundedParams) => this.openUnlocked(boundedParams));
    }

    async openUnlocked(params = {}) {
        const redactOutput = Boolean(params.redact_output);
        const url = normalizeBrowserOperationURL(params.url, redactOutput, 'browser open');
        const referrer = params.referrer ? normalizeBrowserOperationURL(params.referrer, redactOutput, 'browser open') : '';
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120000);
        const idleMs = clampInteger(params.idle_ms, DEFAULT_IDLE_MS, 100, 10000);
        const maxBodyBytes = clampInteger(params.max_body_bytes, DEFAULT_BODY_LIMIT, 0, MAX_BODY_LIMIT);
        const active = Boolean(params.active);
        const keepTab = Boolean(params.keep_tab);
        const requestedTabId = params.tab_id == null ? null : Number(params.tab_id);
        let tab;
        let ownedTab = false;
        let tabClosed = false;
        let operationSucceeded = false;
        let operationError = null;
        let session;
        let navigation;
        let captureResult;
        let finalTab = null;
        try {
            if (Number.isInteger(requestedTabId) && requestedTabId >= 0) {
                tab = await this.call(this.chrome.tabs, 'get', requestedTabId);
            } else {
                tab = await this.call(this.chrome.tabs, 'create', { url: 'about:blank', active });
                ownedTab = true;
            }
            session = await this.startSession(tab.id, {
                url,
                timeoutMs,
                idleMs,
                maxBodyBytes,
                captureMode: 'navigate',
            });

            try {
                navigation = await this.debugCommand(tab.id, 'Page.navigate', {
                    url,
                    ...(referrer ? { referrer } : {}),
                });
                if (navigation?.errorText) throw rpcError('navigation_failed', navigation.errorText, navigation);
                captureResult = await session.settled;
            } catch (error) {
                session.fail(error);
                await session.settled.catch(() => {});
                throw error;
            } finally {
                captureResult = captureResult || { timedOut: false, reason: 'failed' };
                await this.finishSession(session, captureResult);
            }

            try { finalTab = await this.call(this.chrome.tabs, 'get', tab.id); } catch (_) { /* tab closed externally */ }
            operationSucceeded = true;
        } catch (error) {
            operationError = redactOutput ? redactBrowserOperationError(error, 'browser open') : error;
            throw operationError;
        } finally {
            if (ownedTab && tab?.id != null && (!operationSucceeded || !keepTab)) {
                try {
                    tabClosed = await this.closeOwnedTab(tab.id);
                } catch (cleanupError) {
                    if (!operationError) throw cleanupError;
                    operationError.data = {
                        ...(isPlainObject(operationError.data) ? operationError.data : {}),
                        temporary_tab_cleanup_failed: true,
                        tab_id: tab.id,
                    };
                }
            }
        }

        const summary = summarizeRequests(session.requestList());
        return {
            session_id: session.id,
            ...(redactOutput
                ? {
                    sensitive_output_redacted: true,
                    requested_url_redacted: true,
                    final_url_redacted: true,
                    navigation_omitted: true,
                }
                : {
                    requested_url: url,
                    final_url: finalTab?.url || session.finalURL || url,
                    navigation,
                }),
            tab_id: tabClosed ? null : tab.id,
            tab_closed: tabClosed,
            load_state: captureResult.reason,
            timed_out: Boolean(captureResult.timedOut),
            pending_requests: captureResult.pendingRequests || 0,
            duration_ms: Date.now() - session.startedAt,
            ...summary,
        };
    }

    fetch(params = {}) {
        return this.runExplicitCapture(params, 'browser fetch', (boundedParams) => this.fetchUnlocked(boundedParams));
    }

    async fetchUnlocked(params = {}) {
        const redactOutput = Boolean(params.redact_output);
        const url = normalizeBrowserOperationURL(params.url, redactOutput, 'browser fetch');
        const parsedURL = new URL(url);
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120000);
        const idleMs = clampInteger(params.idle_ms, 300, 100, 5000);
        const maxBodyBytes = clampInteger(params.max_body_bytes, DEFAULT_BODY_LIMIT, 0, MAX_BODY_LIMIT);
        const method = String(params.method || 'GET').toUpperCase();
        const headers = normalizeHeaderInput(params.headers);
        const cache = String(params.cache || 'default');
        if (!['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'].includes(cache)) {
            throw rpcError('invalid_argument', `unsupported fetch cache mode: ${cache}`);
        }
        const keepTab = Boolean(params.keep_tab);
        const existingTabId = params.tab_id == null ? null : Number(params.tab_id);

        let tab;
        let ownedTab = false;
        let tabClosed = false;
        let operationSucceeded = false;
        let operationError = null;
        let session;
        let fetchResult;
        let captureResult;
        try {
            if (Number.isInteger(existingTabId) && existingTabId >= 0) {
                tab = await this.call(this.chrome.tabs, 'get', existingTabId);
            } else {
                const tabs = await this.queryTabs({});
                tab = tabs.find((candidate) => sameOrigin(candidate.url || candidate.pendingUrl, url) && !candidate.discarded);
                if (!tab) {
                    tab = await this.call(this.chrome.tabs, 'create', {
                        url: `${parsedURL.protocol}//${parsedURL.host}/`,
                        active: false,
                    });
                    ownedTab = true;
                    await this.waitForTabComplete(tab.id, Math.min(timeoutMs, 20000));
                    tab = await this.call(this.chrome.tabs, 'get', tab.id);
                }
            }
            if (!sameOrigin(tab.url || tab.pendingUrl, url)) {
                if (redactOutput) {
                    throw rpcError('origin_mismatch', `tab ${tab.id} is not on the requested private URL origin`, { tab_id: tab.id });
                }
                throw rpcError('origin_mismatch', `tab ${tab.id} is not on ${parsedURL.origin}`, { tab_url: tab.url, requested_url: url });
            }

            session = await this.startSession(tab.id, {
                url,
                timeoutMs,
                idleMs,
                maxBodyBytes,
                captureMode: 'fetch',
                headersOnly: Boolean(params.headers_only),
                fetchMethod: method,
            });

            try {
                await this.debugCommand(tab.id, 'Runtime.enable');
                const expression = buildFetchExpression({
                    url,
                    method,
                    headers,
                    body: ['GET', 'HEAD'].includes(method) ? undefined : params.body,
                    credentials: params.credentials || 'include',
                    cache,
                    maxBodyBytes,
                    headersOnly: Boolean(params.headers_only),
                });
                session.fetchArmed = true;
                const evaluated = await this.debugCommand(tab.id, 'Runtime.evaluate', {
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                    userGesture: false,
                });
                if (evaluated?.exceptionDetails) {
                    const description = evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'browser fetch failed';
                    throw rpcError('fetch_failed', description, evaluated.exceptionDetails);
                }
                fetchResult = evaluated?.result?.value;
                this.applyPrimaryFetchResult(session, fetchResult);
                session.loaded = true;
                session.checkIdle();
                session.startGrace(Math.max(1500, session.idleMs * 3));
                captureResult = await session.settled;
            } catch (error) {
                session.fail(error);
                await session.settled.catch(() => {});
                throw error;
            } finally {
                captureResult = captureResult || { timedOut: false, reason: 'failed' };
                await this.finishSession(session, captureResult);
            }

            operationSucceeded = true;
        } catch (error) {
            operationError = redactOutput ? redactBrowserOperationError(error, 'browser fetch') : error;
            throw operationError;
        } finally {
            if (ownedTab && tab?.id != null && (!operationSucceeded || !keepTab)) {
                try {
                    tabClosed = await this.closeOwnedTab(tab.id);
                } catch (cleanupError) {
                    if (!operationError) throw cleanupError;
                    operationError.data = {
                        ...(isPlainObject(operationError.data) ? operationError.data : {}),
                        temporary_tab_cleanup_failed: true,
                        tab_id: tab.id,
                    };
                }
            }
        }
        return {
            session_id: session.id,
            tab_id: tabClosed ? null : tab.id,
            tab_closed: tabClosed,
            ...(redactOutput
                ? {
                    sensitive_output_redacted: true,
                    request: { method, url_redacted: true },
                    response: redactFetchResult(fetchResult),
                }
                : {
                    request: { method, url },
                    response: fetchResult,
                }),
            timed_out: Boolean(captureResult.timedOut),
            pending_requests: captureResult.pendingRequests || 0,
            duration_ms: Date.now() - session.startedAt,
            ...summarizeRequests(session.requestList()),
        };
    }

    async closeOwnedTab(tabId) {
        try {
            await this.call(this.chrome.tabs, 'remove', tabId);
            return true;
        } catch (error) {
            if (/no tab with id|invalid tab id|tab not found/i.test(String(error?.message || ''))) return true;
            throw rpcError('tab_cleanup_failed', `failed to close temporary tab ${tabId}`, { tab_id: tabId });
        }
    }

    applyPrimaryFetchResult(session, fetchResult = {}) {
        if (!session.fetchRequestID) return;
        const record = session.current.get(session.fetchRequestID);
        if (!record?.fetchPrimary || !record.response) return;
        const body = typeof fetchResult?.body === 'string' ? fetchResult.body : '';
        record.response.body = body;
        record.response_encoding = '';
        if (fetchResult?.body_truncated) record.response_body_truncated = true;
        record.fetchBodyLimitCancellation = Boolean(fetchResult?.body_truncated && !fetchResult?.body_omitted);
        if (record.fetchBodyLimitCancellation && record.canceled && record.error_text === 'net::ERR_ABORTED') {
            delete record.error_text;
            record.intentional_cancellation = 'body-limit';
        }
    }

    async startSession(tabId, options) {
        if (this.sessions.has(tabId)) throw rpcError('tab_busy', `tab ${tabId} already has an active capture`);
        const session = createCaptureSession(tabId, options);
        this.sessions.set(tabId, session);
        try {
            const controlAttached = this.controlAttachments.has(debuggeeKey({ tabId }));
            if (!controlAttached) await this.debugAttach(tabId);
            session.attached = true;
            session.detachOnFinish = !controlAttached;
            session.contextOverrides = await this.prepareRealBrowserContext({ tabId });
            await this.debugCommand(tabId, 'Network.enable', {
                maxTotalBufferSize: 20 * 1024 * 1024,
                maxResourceBufferSize: Math.max(options.maxBodyBytes * 2, 1024 * 1024),
                maxPostDataSize: Math.max(options.maxBodyBytes, 256 * 1024),
            });
            await this.debugCommand(tabId, 'Page.enable');
            this.emit({
                action: 'session_begin',
                session_id: session.id,
                url: options.url,
                tab_id: tabId,
                capture_mode: options.captureMode,
            });
            return session;
        } catch (error) {
            this.sessions.delete(tabId);
            if (session.attached && session.detachOnFinish) await this.debugDetach(tabId).catch(() => {});
            if (!error.code) error.code = 'debugger_attach_failed';
            throw error;
        }
    }

    async finishSession(session, settleResult) {
        session.stopTimer();
        await Promise.race([
            Promise.allSettled(Array.from(session.bodyPromises)),
            delay(2000),
        ]);
        // ExtraInfo events can trail loadingFinished by a few ticks.
        await delay(75);
        if (session.attached && session.detachOnFinish) await this.debugDetach(session.tabId).catch(() => {});
        this.sessions.delete(session.tabId);

        const requests = session.requestList();
        for (const batch of chunkForNativeMessaging(requests)) {
            this.emit({ action: 'add_many', session_id: session.id, requests: batch });
        }
        this.emit({
            action: 'session_end',
            session_id: session.id,
            url: session.finalURL || session.url,
            tab_id: session.tabId,
            capture_mode: session.captureMode,
            timed_out: Boolean(settleResult?.timedOut),
        });
    }

    handleDebuggerEvent(source, method, params = {}) {
        const tabId = source?.tabId;
        const session = this.sessions.get(tabId);
        if (!session) return;

        switch (method) {
        case 'Network.requestWillBeSent':
            this.onRequestWillBeSent(session, params);
            break;
        case 'Network.requestWillBeSentExtraInfo':
            this.onRequestExtraInfo(session, params);
            break;
        case 'Network.responseReceived':
            this.onResponseReceived(session, params);
            break;
        case 'Network.responseReceivedExtraInfo':
            this.onResponseExtraInfo(session, params);
            break;
        case 'Network.loadingFinished':
            this.onLoadingFinished(session, params);
            break;
        case 'Network.loadingFailed':
            this.onLoadingFailed(session, params);
            break;
        case 'Page.downloadWillBegin':
            this.onDownloadWillBegin(session, params);
            break;
        case 'Network.webSocketHandshakeResponseReceived':
            this.onWebSocketResponse(session, params);
            break;
        case 'Page.loadEventFired':
            session.loaded = true;
            session.checkIdle();
            session.startGrace(Math.max(2500, session.idleMs * 4));
            break;
        case 'Page.frameNavigated':
            if (!params.frame?.parentId && params.frame?.url) session.finalURL = params.frame.url;
            break;
        default:
            break;
        }
    }

    handleDebuggerDetach(source, reason) {
        this.controlAttachments.delete(debuggeeKey(source || {}));
        const session = this.sessions.get(source?.tabId);
        if (!session) return;
        session.attached = false;
        if (!session.done) session.fail(rpcError('debugger_detached', `Debugger detached: ${reason || 'unknown'}`));
    }

    onRequestWillBeSent(session, params) {
        const requestId = params.requestId;
        const previous = session.current.get(requestId);
        if (previous && params.redirectResponse) {
            previous.response = responseFromCDP(params.redirectResponse);
            previous.response_ordinal ||= session.nextEventOrdinal();
            previous.completion_ordinal = session.nextEventOrdinal();
            previous.complete = true;
            session.blocking.delete(previous.key);
        }
        const sequence = session.requestSequence.get(requestId) || 0;
        session.requestSequence.set(requestId, sequence + 1);
        const request = params.request || {};
        const timestamp = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();
        const originalID = sequence ? `${requestId}:redirect-${sequence}` : requestId;
        const key = `${requestId}:${sequence}`;
        const startOrdinal = session.nextEventOrdinal();
        const downloadKey = normalizedURLKey(request.url);
        const pendingDownload = session.pendingDownloads.get(downloadKey)?.shift();
        if (session.pendingDownloads.get(downloadKey)?.length === 0) session.pendingDownloads.delete(downloadKey);
        const fetchPrimary = Boolean(session.captureMode === 'fetch' && (
            session.fetchRequestID === requestId
            || (
                session.fetchArmed
                && !session.fetchRequestID
                && stringsEqualURL(request.url, session.url)
                && String(request.method || 'GET').toUpperCase() === session.fetchMethod
            )
        ));
        const record = {
            id: buildStableRequestId({ requestId: originalID, tabId: session.tabId, timestamp, method: request.method, url: request.url }),
            original_id: originalID,
            method: request.method || 'GET',
            url: request.url || '',
            page_url: session.finalURL || session.url,
            resource_type: String(params.type || '').toLowerCase(),
            initiator: initiatorURL(params.initiator),
            headers: headersToMap(request.headers),
            body: request.postData || '',
            response: null,
            response_encoding: '',
            capture_source: 'cdp',
            tab_id: session.tabId,
            timestamp,
            start_ordinal: startOrdinal,
            key,
            complete: false,
            fetchPrimary,
            headersOnlyPrimary: Boolean(session.headersOnly && fetchPrimary),
            downloadStarted: Boolean(pendingDownload),
        };
        if (fetchPrimary && !session.fetchRequestID) {
            session.fetchRequestID = requestId;
        }
        const pendingHeaders = session.requestExtra.get(requestId);
        if (pendingHeaders) {
            record.headers = mergeHeaderMaps(record.headers, pendingHeaders);
            session.requestExtra.delete(requestId);
        }
        session.requests.set(key, record);
        session.current.set(requestId, record);
        if (!NON_BLOCKING_TYPES.has(params.type)) session.blocking.add(key);
        session.cancelIdle();
        // Long-lived non-blocking transports still count as activity, but do
        // not prevent quiescence forever merely because they never finish.
        session.checkIdle();
    }

    onRequestExtraInfo(session, params) {
        const record = session.current.get(params.requestId);
        const headers = headersToMap(params.headers);
        if (record) record.headers = mergeHeaderMaps(record.headers, headers);
        else session.requestExtra.set(params.requestId, headers);
    }

    onResponseReceived(session, params) {
        const record = session.current.get(params.requestId);
        if (!record) return;
        record.response = responseFromCDP(params.response);
        record.response_ordinal ||= session.nextEventOrdinal();
        record.resource_type = record.resource_type || String(params.type || '').toLowerCase();
        const pending = session.responseExtra.get(params.requestId);
        if (pending) {
            record.response.headers = mergeHeaderMaps(record.response.headers, pending.headers);
            if (pending.status) record.response.status = pending.status;
            session.responseExtra.delete(params.requestId);
        }
    }

    onResponseExtraInfo(session, params) {
        const record = session.current.get(params.requestId);
        const extra = { headers: headersToMap(params.headers), status: params.statusCode || 0 };
        if (record?.response) {
            record.response.headers = mergeHeaderMaps(record.response.headers, extra.headers);
            if (extra.status) record.response.status = extra.status;
        } else {
            session.responseExtra.set(params.requestId, extra);
        }
    }

    onLoadingFinished(session, params) {
        const record = session.current.get(params.requestId);
        if (!record || record.complete) return;
        record.completion_ordinal = session.nextEventOrdinal();
        const bodyPromise = this.captureResponseBody(session, record, params)
            .catch((error) => { record.response_body_error = error?.message || String(error); })
            .finally(() => {
                record.complete = true;
                session.blocking.delete(record.key);
                session.checkIdle();
                session.bodyPromises.delete(bodyPromise);
            });
        session.bodyPromises.add(bodyPromise);
    }

    async captureResponseBody(session, record, params) {
        if (!record.response || session.maxBodyBytes <= 0) return;
        // The renderer fetch already retained a byte-bounded prefix. Asking CDP
        // for the same body would materialize the complete response a second time.
        if (record.fetchPrimary) return;

        const status = Number(record.response.status || 0);
        const method = String(record.method || 'GET').toUpperCase();
        const declaredBytes = parseNonNegativeInteger(firstHeaderValue(record.response.headers, 'content-length'));
        const contentEncoding = firstHeaderValue(record.response.headers, 'content-encoding').trim().toLowerCase();
        const encodedBytes = Number(params.encodedDataLength);
        if (method === 'HEAD' || status === 204 || status === 304 || declaredBytes === 0) return;
        if (!Number.isFinite(encodedBytes) || encodedBytes <= 0) {
            omitResponseBody(record, 'transfer size is unavailable');
            return;
        }
        if (encodedBytes > session.maxBodyBytes) {
            omitResponseBody(record, `${Math.round(encodedBytes)} encoded bytes exceeds capture limit`);
            return;
        }
        if (contentEncoding && contentEncoding !== 'identity') {
            omitResponseBody(record, `compressed ${contentEncoding} response has no safe decoded-size bound`);
            return;
        }
        if (declaredBytes != null && declaredBytes > session.maxBodyBytes) {
            omitResponseBody(record, `${declaredBytes} declared bytes exceeds capture limit`);
            return;
        }

        const result = await this.debugCommand(session.tabId, 'Network.getResponseBody', { requestId: params.requestId });
        const body = result?.body || '';
        if (result?.base64Encoded) {
            const decodedBytes = base64DecodedLength(body);
            if (decodedBytes > session.maxBodyBytes) {
                omitResponseBody(record, `base64 body is ${decodedBytes} bytes and exceeds capture limit`);
                return;
            }
            record.response.body = body;
            record.response_encoding = 'base64';
            return;
        }
        const bounded = utf8BoundedPrefix(body, session.maxBodyBytes);
        record.response.body = bounded.text;
        if (bounded.truncated) record.response_body_truncated = true;
    }

    onLoadingFailed(session, params) {
        const record = session.current.get(params.requestId);
        if (!record) return;
        const errorText = params.errorText || 'network load failed';
        record.response ||= { status: 0, headers: {}, body: '' };
        record.canceled = Boolean(params.canceled) || errorText === 'net::ERR_ABORTED';
        record.completion_ordinal = session.nextEventOrdinal();
        const intentionalCancellation = classifyIntentionalCancellation(record, errorText);
        if (intentionalCancellation) record.intentional_cancellation = intentionalCancellation;
        else record.error_text = errorText;
        record.complete = true;
        session.blocking.delete(record.key);
        session.checkIdle();
    }

    onDownloadWillBegin(session, params) {
        const key = normalizedURLKey(params.url);
        if (!key) return;
        const ordinal = session.nextEventOrdinal();
        const records = Array.from(session.requests.values()).reverse();
        const record = records.find((candidate) => !candidate.downloadStarted && normalizedURLKey(candidate.url) === key && candidate.start_ordinal <= ordinal);
        if (!record) {
            const pending = session.pendingDownloads.get(key) || [];
            pending.push({ ordinal, frameId: params.frameId || '' });
            session.pendingDownloads.set(key, pending);
        } else {
            record.downloadStarted = true;
            if (record.canceled && record.error_text === 'net::ERR_ABORTED') {
                delete record.error_text;
                record.intentional_cancellation = 'browser-download';
            }
        }
        if (session.captureMode === 'navigate') {
            session.loaded = true;
            session.checkIdle();
            session.startGrace(Math.max(2500, session.idleMs * 4));
        }
    }

    onWebSocketResponse(session, params) {
        const record = session.current.get(params.requestId);
        if (!record) return;
        record.response = responseFromCDP(params.response);
        record.response_ordinal ||= session.nextEventOrdinal();
        record.completion_ordinal = session.nextEventOrdinal();
        record.complete = true;
        session.blocking.delete(record.key);
        session.checkIdle();
    }

    debugAttach(tabId) {
        return this.debugAttachTarget({ tabId });
    }

    debugDetach(tabId) {
        return this.debugDetachTarget({ tabId });
    }

    debugCommand(tabId, method, params = {}) {
        return this.sendDebugCommand({ tabId }, method, params);
    }

    debugAttachTarget(debuggee) {
        return this.call(this.chrome.debugger, 'attach', debuggee, '1.3');
    }

    debugDetachTarget(debuggee) {
        return this.call(this.chrome.debugger, 'detach', debuggee);
    }

    sendDebugCommand(debuggee, method, params = {}) {
        return this.call(this.chrome.debugger, 'sendCommand', debuggee, method, params);
    }

    async resolveDebuggee(params = {}) {
        const debuggee = debuggeeFromParams(params);
        if (!debuggee.targetId) return debuggee;

        // Page targets have both a CDP target ID and a Chrome tab ID. Canonicalize
        // them to tab IDs so persistent attachments are reused by capture sessions
        // and debugger detach events use the same bookkeeping key.
        const targets = await this.call(this.chrome.debugger, 'getTargets');
        const target = (targets || []).find((candidate) => candidate.id === debuggee.targetId);
        if (Number.isInteger(target?.tabId) && target.tabId >= 0) return { tabId: target.tabId };
        return debuggee;
    }

    async prepareRealBrowserContext(debuggee) {
        const commands = [
            ['Page.setWebLifecycleState', { state: 'active' }],
            ['Emulation.setFocusEmulationEnabled', { enabled: true }],
            ['Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true }],
            ['Emulation.setAutomationOverride', { enabled: false }],
        ];
        const applied = {};
        for (const [method, commandParams] of commands) {
            try {
                await this.sendDebugCommand(debuggee, method, commandParams);
                applied[method] = true;
            } catch (error) {
                applied[method] = false;
            }
        }
        return applied;
    }

    queryTabs(queryInfo) {
        return this.call(this.chrome.tabs, 'query', queryInfo);
    }

    containsPermissions(query) {
        if (!this.chrome.permissions?.contains) return Promise.resolve(false);
        return this.call(this.chrome.permissions, 'contains', query).catch(() => false);
    }

    call(owner, method, ...args) {
        return new Promise((resolve, reject) => {
            const callback = (result) => {
                const lastError = this.chrome.runtime?.lastError;
                if (lastError) {
                    reject(rpcError('chrome_api_error', lastError.message || String(lastError)));
                    return;
                }
                resolve(result);
            };
            try {
                owner[method](...args, callback);
            } catch (error) {
                reject(error);
            }
        });
    }

    waitForTabComplete(tabId, timeoutMs) {
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this.chrome.tabs.onUpdated.removeListener(listener);
            };
            const listener = (updatedTabId, changeInfo, tab) => {
                if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
                cleanup();
                resolve(tab);
            };
            this.chrome.tabs.onUpdated.addListener(listener);
            timer = setTimeout(() => {
                cleanup();
                reject(rpcError('tab_load_timeout', `tab ${tabId} did not finish loading within ${timeoutMs}ms`));
            }, timeoutMs);
            this.call(this.chrome.tabs, 'get', tabId).then((tab) => {
                if (tab.status === 'complete') {
                    cleanup();
                    resolve(tab);
                }
            }).catch(() => {});
        });
    }
}

function createCaptureSession(tabId, options) {
    const session = {
        id: makeSessionID(options.captureMode),
        tabId,
        url: options.url,
        finalURL: options.url,
        captureMode: options.captureMode,
        headersOnly: Boolean(options.headersOnly),
        fetchMethod: String(options.fetchMethod || 'GET').toUpperCase(),
        fetchArmed: false,
        fetchRequestID: '',
        startedAt: Date.now(),
        maxBodyBytes: options.maxBodyBytes,
        idleMs: options.idleMs,
        loaded: options.captureMode === 'fetch',
        attached: false,
        detachOnFinish: true,
        contextOverrides: {},
        done: false,
        requests: new Map(),
        current: new Map(),
        requestSequence: new Map(),
        requestExtra: new Map(),
        responseExtra: new Map(),
        eventOrdinal: 0,
        pendingDownloads: new Map(),
        blocking: new Set(),
        bodyPromises: new Set(),
        idleTimer: null,
        observeUntil: 0,
        graceTimer: null,
        timeoutTimer: null,
        nextEventOrdinal() {
            this.eventOrdinal += 1;
            return this.eventOrdinal;
        },
        requestList() {
            return Array.from(this.requests.values())
                .filter((request) => /^https?:/i.test(request.url))
                .sort((a, b) => a.timestamp - b.timestamp)
                .map(stripInternalFields);
        },
        cancelIdle() {
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = null;
        },
        checkIdle() {
            if (this.done || !this.loaded || this.blocking.size > 0 || this.idleTimer) return;
            const observationRemaining = Math.max(0, this.observeUntil - Date.now());
            const delayMs = Math.max(this.idleMs, observationRemaining);
            this.idleTimer = setTimeout(() => this.finish({ timedOut: false, reason: 'network-idle' }), delayMs);
        },
        observeFor(delayMs) {
            if (this.done) return;
            const nextDeadline = Date.now() + Math.max(0, Number(delayMs) || 0);
            if (nextDeadline <= this.observeUntil) return;
            this.observeUntil = nextDeadline;
            this.cancelIdle();
        },
        startGrace(delayMs) {
            if (this.done || this.graceTimer) return;
            this.graceTimer = setTimeout(() => this.finish({
                timedOut: false,
                reason: 'load-grace',
                pendingRequests: this.blocking.size,
            }), delayMs);
        },
        stopTimer() {
            this.cancelIdle();
            if (this.graceTimer) clearTimeout(this.graceTimer);
            this.graceTimer = null;
            if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        },
    };
    session.settled = new Promise((resolve, reject) => {
        session.finish = (value) => {
            if (session.done) return;
            session.done = true;
            session.stopTimer();
            resolve(value);
        };
        session.fail = (error) => {
            if (session.done) return;
            session.done = true;
            session.stopTimer();
            reject(error);
        };
    });
    session.timeoutTimer = setTimeout(() => session.finish({
        timedOut: true,
        reason: 'timeout',
        pendingRequests: session.blocking.size,
    }), options.timeoutMs);
    return session;
}

function normalizeBrowserOperationURL(input, redactOutput, operation) {
    try {
        return normalizeURL(input);
    } catch (error) {
        if (!redactOutput) throw error;
        throw redactBrowserOperationError(error, operation);
    }
}

function redactBrowserOperationError(error, operation) {
    return rpcError(
        error?.code || 'browser_operation_failed',
        `${operation} failed for a URL loaded from a private file; sensitive details were omitted`,
    );
}

function redactFetchResult(result = {}) {
    return {
        ok: Boolean(result?.ok),
        status: Number(result?.status || 0),
        redirected: Boolean(result?.redirected),
        type: String(result?.type || ''),
        body_bytes: Number(result?.body_bytes || 0),
        body_declared_bytes: result?.body_declared_bytes == null ? null : Number(result.body_declared_bytes),
        body_truncated: Boolean(result?.body_truncated),
        body_omitted: true,
        url_redacted: true,
        headers_omitted: true,
    };
}

function stringsEqualURL(left, right) {
    try {
        const a = new URL(left);
        const b = new URL(right);
        a.hash = '';
        b.hash = '';
        return a.href === b.href;
    } catch (_) {
        return false;
    }
}

function normalizedURLKey(value) {
    try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href;
    } catch (_) {
        return '';
    }
}

function firstHeaderValue(headers = {}, name) {
    const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!match) return '';
    const values = Array.isArray(match[1]) ? match[1] : [match[1]];
    return String(values[0] ?? '');
}

function parseNonNegativeInteger(value) {
    if (String(value).trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function omitResponseBody(record, reason) {
    record.response_body_truncated = true;
    record.response_body_error = `body omitted: ${reason}`;
}

function base64DecodedLength(value) {
    const body = String(value || '').replace(/\s+/g, '');
    if (!body) return 0;
    const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(body.length / 4) * 3 - padding);
}

function utf8BoundedPrefix(value, maxBytes) {
    const encoded = new TextEncoder().encode(String(value || ''));
    if (encoded.byteLength <= maxBytes) {
        return { text: String(value || ''), bytes: encoded.byteLength, truncated: false };
    }
    let end = Math.max(0, Math.min(maxBytes, encoded.byteLength));
    let lead = end - 1;
    while (lead >= 0 && (encoded[lead] & 0xc0) === 0x80) lead -= 1;
    if (lead < 0) {
        end = 0;
    } else {
        const first = encoded[lead];
        const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 1;
        if (end - lead < expected) end = lead;
    }
    return {
        text: new TextDecoder().decode(encoded.subarray(0, end)),
        bytes: end,
        truncated: true,
    };
}

function classifyIntentionalCancellation(record, errorText) {
    const status = Number(record?.response?.status || 0);
    if (!record?.canceled) return '';
    if (record.downloadStarted && errorText === 'net::ERR_ABORTED') return 'browser-download';
    if (record.headersOnlyPrimary && status >= 200 && status < 300) return 'headers-only';
    if (record.fetchBodyLimitCancellation && status >= 200 && status < 300 && errorText === 'net::ERR_ABORTED') return 'body-limit';
    return '';
}

export function normalizeURL(input) {
    let value = String(input || '').trim();
    if (!value) throw rpcError('invalid_url', 'URL is required');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw rpcError('invalid_url', `Invalid URL: ${input}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw rpcError('invalid_url', 'Only http:// and https:// URLs are supported');
    return parsed.href;
}

export function headersToMap(headers) {
    const output = {};
    if (!headers || typeof headers !== 'object') return output;
    for (const [name, rawValue] of Object.entries(headers)) {
        const values = Array.isArray(rawValue) ? rawValue : String(rawValue ?? '').split('\n');
        output[name] = values.map((value) => String(value));
    }
    return output;
}

export function mergeHeaderMaps(base = {}, extra = {}) {
    const result = { ...base };
    for (const [name, values] of Object.entries(extra)) result[name] = Array.from(values || [], String);
    return result;
}

export function buildFetchExpression(options) {
    const payload = JSON.stringify(options).replace(/</g, '\\u003c');
    return `(async () => {
        const options = ${payload};
        const init = {
            method: options.method,
            headers: options.headers,
            credentials: options.credentials,
            redirect: 'follow',
            cache: options.cache || 'default'
        };
        if (options.body !== undefined && options.body !== null) init.body = options.body;
        const response = await fetch(options.url, init);
        const declaredHeader = response.headers.get('content-length');
        const declaredNumber = declaredHeader == null ? NaN : Number(declaredHeader);
        const declaredBytes = Number.isFinite(declaredNumber) && declaredNumber >= 0 ? declaredNumber : null;
        if (options.headersOnly) {
            const hasBody = Boolean(response.body);
            try { await response.body?.cancel(); } catch (_) { /* response metadata is still valid */ }
            return {
                ok: response.ok,
                status: response.status,
                status_text: response.statusText,
                url: response.url,
                redirected: response.redirected,
                type: response.type,
                headers: Object.fromEntries(response.headers.entries()),
                body: '',
                body_bytes: 0,
                body_declared_bytes: declaredBytes,
                body_truncated: hasBody,
                body_omitted: true
            };
        }
        const limit = Math.max(0, Math.floor(Number(options.maxBodyBytes) || 0));
        const chunks = [];
        let capturedBytes = 0;
        let observedBytes = 0;
        let truncated = false;
        const reader = response.body?.getReader();
        if (reader) {
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value || 0);
                    observedBytes += chunk.byteLength;
                    const remaining = Math.max(0, limit - capturedBytes);
                    const take = Math.min(remaining, chunk.byteLength);
                    if (take > 0) {
                        chunks.push(chunk.slice(0, take));
                        capturedBytes += take;
                    }
                    if (capturedBytes >= limit && (
                        observedBytes > limit
                        || declaredBytes == null
                        || declaredBytes > limit
                    )) {
                        truncated = observedBytes > 0 || (declaredBytes != null && declaredBytes > 0);
                        try { await reader.cancel('rep response body limit reached'); } catch (_) { /* bounded prefix is still valid */ }
                        break;
                    }
                }
            } finally {
                try { reader.releaseLock(); } catch (_) { /* already released */ }
            }
        }
        const bytes = new Uint8Array(capturedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        let completeBytes = bytes.byteLength;
        if (truncated && completeBytes > 0) {
            let lead = completeBytes - 1;
            while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead -= 1;
            if (lead < 0) {
                completeBytes = 0;
            } else {
                const first = bytes[lead];
                const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 1;
                if (completeBytes - lead < expected) completeBytes = lead;
            }
        }
        const body = new TextDecoder().decode(bytes.subarray(0, completeBytes));
        const bodyBytes = new TextEncoder().encode(body).byteLength;
        return {
            ok: response.ok,
            status: response.status,
            status_text: response.statusText,
            url: response.url,
            redirected: response.redirected,
            type: response.type,
            headers: Object.fromEntries(response.headers.entries()),
            body,
            body_bytes: bodyBytes,
            body_observed_bytes: observedBytes,
            body_declared_bytes: declaredBytes,
            body_truncated: truncated
        };
    })()`;
}

export function buildIdentityProbeExpression() {
    return `(async () => {
        const nav = navigator;
        const webdriverDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav), 'webdriver');
        let uaData = null;
        try {
            uaData = nav.userAgentData ? await nav.userAgentData.getHighEntropyValues([
                'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model',
                'platformVersion', 'uaFullVersion', 'wow64'
            ]) : null;
        } catch (error) {
            uaData = { error: String(error) };
        }
        let webgl = null;
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            const extension = gl && gl.getExtension('WEBGL_debug_renderer_info');
            webgl = gl ? {
                vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
            } : null;
        } catch (error) {
            webgl = { error: String(error) };
        }
        return {
            url: location.href,
            origin: location.origin,
            secure_context: globalThis.isSecureContext,
            cross_origin_isolated: globalThis.crossOriginIsolated,
            webdriver: nav.webdriver,
            webdriver_descriptor: webdriverDescriptor ? {
                enumerable: webdriverDescriptor.enumerable,
                configurable: webdriverDescriptor.configurable,
                native_getter: /\\[native code\\]/.test(String(webdriverDescriptor.get))
            } : null,
            user_agent: nav.userAgent,
            user_agent_data: uaData,
            platform: nav.platform,
            vendor: nav.vendor,
            languages: Array.from(nav.languages || []),
            hardware_concurrency: nav.hardwareConcurrency,
            device_memory: nav.deviceMemory ?? null,
            max_touch_points: nav.maxTouchPoints,
            cookie_enabled: nav.cookieEnabled,
            plugins: Array.from(nav.plugins || [], plugin => ({ name: plugin.name, filename: plugin.filename })),
            mime_types: Array.from(nav.mimeTypes || [], mime => mime.type),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            locale: Intl.DateTimeFormat().resolvedOptions().locale,
            visibility_state: document.visibilityState,
            document_hidden: document.hidden,
            document_has_focus: document.hasFocus(),
            viewport: {
                inner_width: innerWidth,
                inner_height: innerHeight,
                outer_width: outerWidth,
                outer_height: outerHeight,
                device_pixel_ratio: devicePixelRatio
            },
            screen: {
                width: screen.width,
                height: screen.height,
                avail_width: screen.availWidth,
                avail_height: screen.availHeight,
                color_depth: screen.colorDepth,
                pixel_depth: screen.pixelDepth
            },
            webgl
        };
    })()`;
}

export function summarizeRequests(requests) {
    const domains = new Set();
    let responseBodies = 0;
    let bodyBytes = 0;
    let failed = 0;
    let ignoredCancellations = 0;
    for (const request of requests) {
        try { domains.add(new URL(request.url).host); } catch (_) { /* invalid event URL */ }
        if (request.response?.body) {
            responseBodies += 1;
            bodyBytes += request.response_encoding === 'base64'
                ? base64DecodedLength(request.response.body)
                : new TextEncoder().encode(request.response.body).byteLength;
        }
        if (request.intentional_cancellation) ignoredCancellations += 1;
        else if (request.error_text || (request.response && request.response.status === 0)) failed += 1;
    }
    return {
        requests: requests.length,
        domains: domains.size,
        response_bodies: responseBodies,
        captured_body_bytes: bodyBytes,
        failed_requests: failed,
        ignored_cancellations: ignoredCancellations,
    };
}

function responseFromCDP(response = {}) {
    return {
        status: Math.round(response.status || response.statusCode || 0),
        headers: headersToMap(response.headers),
        body: '',
    };
}

function initiatorURL(initiator = {}) {
    if (initiator.url) return initiator.url;
    const frames = initiator.stack?.callFrames || [];
    return frames.find((frame) => frame.url)?.url || initiator.type || '';
}

function stripInternalFields(record) {
    const output = { ...record };
    delete output.key;
    delete output.complete;
    delete output.fetchPrimary;
    delete output.fetchBodyLimitCancellation;
    delete output.headersOnlyPrimary;
    delete output.downloadStarted;
    if (!output.response) delete output.response;
    return output;
}

function chunkForNativeMessaging(requests) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const request of requests) {
        const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength + 1;
        if (batch.length > 0 && bytes + requestBytes > NATIVE_BATCH_LIMIT) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(request);
        bytes += requestBytes;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
}

function normalizeHeaderInput(headers) {
    if (headers == null) return {};
    if (Array.isArray(headers)) {
        const result = {};
        for (const item of headers) {
            const index = String(item).indexOf(':');
            if (index <= 0) throw rpcError('invalid_header', `Invalid header: ${item}`);
            result[String(item).slice(0, index).trim()] = String(item).slice(index + 1).trim();
        }
        return result;
    }
    if (typeof headers === 'object') return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
    throw rpcError('invalid_header', 'headers must be an object or array');
}

function sameOrigin(candidate, target) {
    try { return new URL(candidate).origin === new URL(target).origin; } catch (_) { return false; }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function debuggeeFromParams(params = {}) {
    const tabId = params.tab_id == null ? null : Number(params.tab_id);
    const targetId = String(params.target_id || '').trim();
    if (Number.isInteger(tabId) && tabId >= 0 && !targetId) return { tabId };
    if (targetId && params.tab_id == null) return { targetId };
    if (targetId && Number.isInteger(tabId) && tabId >= 0) {
        throw rpcError('invalid_argument', 'provide exactly one of tab_id or target_id');
    }
    throw rpcError('invalid_argument', 'tab_id or target_id is required');
}

function debuggeeKey(debuggee = {}) {
    if (debuggee.tabId != null) return `tab:${debuggee.tabId}`;
    if (debuggee.targetId) return `target:${debuggee.targetId}`;
    return 'unknown';
}

function makeSessionID(mode) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${mode}-${random}`;
}

function clampInteger(value, fallback, minimum, maximum) {
    const number = value == null ? fallback : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function boundEvaluationResult(evaluation, maxBytes) {
    let encoded;
    try {
        encoded = JSON.stringify(evaluation ?? {});
    } catch (_) {
        return { value: evaluationSummary(evaluation), bytes: null, truncated: true };
    }
    const bytes = new TextEncoder().encode(encoded).length;
    if (bytes <= maxBytes) return { value: evaluation ?? {}, bytes, truncated: false };
    return { value: evaluationSummary(evaluation), bytes, truncated: true };
}

function evaluationSummary(evaluation) {
    const remote = evaluation?.result || {};
    const result = {};
    for (const key of ['type', 'subtype', 'className', 'description']) {
        if (remote[key] == null) continue;
        result[key] = String(remote[key]).slice(0, 512);
    }
    return { result };
}

function rpcError(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
