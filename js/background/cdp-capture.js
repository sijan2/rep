import { buildStableRequestId } from '../core/utils/hash.js';
import { TransportCapture } from './transport-capture.js';
import { CaptureBodyBudget, ResponseBodyCollector, nativeRequestMessages } from './body-capture.js';
import { BrowserRuntime, MAX_EXPRESSION_BYTES, normalizeURL, debuggeeKey, rpcError } from './browser-runtime.js';
export { normalizeURL, buildIdentityProbeExpression } from './browser-runtime.js';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_MS = 800;
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;
const MAX_BODY_LIMIT = 256 * 1024 * 1024;
const BODY_DRAIN_MS = 5000;
const DEFAULT_ACTION_RESULT_LIMIT = 64 * 1024;
const MAX_ACTION_RESULT_LIMIT = 256 * 1024;
const DEFAULT_ACTION_SETTLE_MS = 1500;
const MAX_ACTION_SETTLE_MS = 10000;
const NON_BLOCKING_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping']);
const DEFAULT_CAPTURE_LIMITS = Object.freeze({ max_total_body_bytes: 64 * 1024 * 1024, max_requests: 10000, max_events: 10000, max_native_backlog_bytes: 16 * 1024 * 1024 });

export class CDPCaptureController extends BrowserRuntime {
    constructor({ chromeApi = globalThis.chrome, emit = () => true, capturePreflight = async () => true } = {}) {
        super({ chromeApi });
        this.emit = emit;
        this.capturePreflight = capturePreflight;
        this.sessions = new Map();
        this.captureTail = Promise.resolve();
        this.queuedCaptures = 0;
        this.captureOperationActive = false;
        this.boundEvent = (source, method, params) => this.handleDebuggerEvent(source, method, params);
        this.chrome.debugger.onEvent.addListener(this.boundEvent);
    }

    captureActivity() {
        return { active_captures: this.captureOperationActive ? 1 : this.sessions.size, queued_captures: this.queuedCaptures };
    }

    isCaptureAttached(tabId) { return Boolean(this.sessions.get(tabId)?.attached); }

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
                'streamed_response_bodies', 'body_capture_diagnostics', 'related_target_capture', 'fragmented_request_transport',
                'lifecycle_navigation', 'page_screenshot',
                'websocket_records_v1', 'webtransport_lifecycle_v1', 'protocol_payloads_v1', 'webrtc_media_v1', 'network_metadata', 'incremental_capture', 'capture_budgets',
            ],
        };
    }

    assertAmbientCanStart() {
        this.assertReloadNotPending('start ambient capture');
        const { active_captures, queued_captures } = this.reloadBlockers();
        if (active_captures > 0 || queued_captures > 0) {
            throw rpcError('capture_busy', 'cannot start ambient capture while explicit captures are active or queued', {
                active_captures,
                queued_captures,
            });
        }
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
            // Keep ambient capture excluded while the native capability
            // handshake is pending, as well as during the browser operation.
            this.captureOperationActive = true;
            await this.capturePreflight();
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw rpcError('capture_queue_timeout', `${operation} expired while waiting for the active capture`, {
                    timeout_ms: timeoutMs,
                });
            }
            return await task({
                ...params,
                timeout_ms: Math.min(timeoutMs, Math.floor(remainingMs)),
            });
        } finally {
            this.captureOperationActive = false;
            release();
        }
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
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1, 120000);
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
        const maxBodyBytes = responseBodyLimit(params.max_body_bytes);
        const maxResultBytes = clampInteger(params.max_result_bytes, DEFAULT_ACTION_RESULT_LIMIT, 0, MAX_ACTION_RESULT_LIMIT);
        const session = await this.startSession(debuggee.tabId, {
            url: tab.url || tab.pendingUrl || 'about:blank',
            timeoutMs,
            idleMs,
            maxBodyBytes,
            captureMode: 'action',
            limits: captureLimits(params),
                protocolPayloads: params.protocol_payloads === true,
                webrtcMedia: params.webrtc_media === true,
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

    open(params = {}) {
        return this.runExplicitCapture(params, 'browser open', (boundedParams) => this.openUnlocked(boundedParams));
    }

    async openUnlocked(params = {}) {
        const redactOutput = Boolean(params.redact_output);
        const url = normalizeBrowserOperationURL(params.url, redactOutput, 'browser open');
        const referrer = params.referrer ? normalizeBrowserOperationURL(params.referrer, redactOutput, 'browser open') : '';
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1, 120000);
        const idleMs = clampInteger(params.idle_ms, DEFAULT_IDLE_MS, 100, 10000);
        const maxBodyBytes = responseBodyLimit(params.max_body_bytes);
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
                limits: captureLimits(params),
                protocolPayloads: params.protocol_payloads === true,
                webrtcMedia: params.webrtc_media === true,
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
        const timeoutMs = clampInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS, 1, 120000);
        const idleMs = clampInteger(params.idle_ms, 300, 100, 5000);
        const maxBodyBytes = responseBodyLimit(params.max_body_bytes);
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
                limits: captureLimits(params),
                protocolPayloads: params.protocol_payloads === true,
                webrtcMedia: params.webrtc_media === true,
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
                    timeoutMs,
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
                    response: fetchResponsePreview(fetchResult, session),
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
        const captured = boundedCapturedBody(session, body, fetchResult?.body_encoding === 'base64', record);
        record.response.body = captured.body;
        record.response_encoding = captured.encoding;
        record.response_body_capture = {
            state: fetchResult?.body_omitted ? 'unavailable' : (captured.truncated || fetchResult?.body_truncated || fetchResult?.body_error) ? 'partial' : 'complete',
            reason: fetchResult?.body_omitted ? 'headers_only' : captured.reason || (fetchResult?.body_error ? 'network_failed' : fetchResult?.body_truncated ? 'body_limit' : undefined),
            source: 'renderer-fetch', captured_bytes: captured.bytes,
            observed_bytes: Number(fetchResult?.body_observed_bytes) || Number(fetchResult?.body_bytes) || 0, encoding: captured.encoding || 'utf-8',
        };
        record.bodyFinalized = true;
        if (fetchResult?.body_error) record.response_body_error = fetchResult.body_error;
        if (captured.truncated || fetchResult?.body_truncated) record.response_body_truncated = true;
        record.fetchBodyLimitCancellation = Boolean(fetchResult?.body_truncated && !fetchResult?.body_omitted);
        if (record.fetchBodyLimitCancellation && record.canceled && record.error_text === 'net::ERR_ABORTED') {
            delete record.error_text;
            record.intentional_cancellation = 'body-limit';
        }
        this.queueCompletedRecord(session, record);
    }

    async startSession(tabId, options) {
        if (this.sessions.has(tabId)) throw rpcError('tab_busy', `tab ${tabId} already has an active capture`);
        if (this.semantic.activeExecution(tabId)) throw rpcError('tab_busy', `tab ${tabId} has an active execution lease`);
        const session = createCaptureSession(tabId, options);
        session.transports = new TransportCapture(this, session, options.protocolPayloads === true, options.webrtcMedia === true);
        this.sessions.set(tabId, session);
        try {
            const controlAttached = this.controlAttachments.has(debuggeeKey({ tabId }));
            if (!controlAttached) await this.debugAttach(tabId);
            session.attached = true;
            session.detachOnFinish = !controlAttached;
            session.contextOverrides = await this.prepareRealBrowserContext({ tabId });
            await this.emit({
                action: 'session_begin',
                session_id: session.id,
                url: options.url,
                tab_id: tabId,
                capture_mode: options.captureMode,
                incremental: true,
                capture_limits: session.limits,
            });
            session.nativeStarted = true;
            await this.enableCaptureTarget(session, { tabId });
            await this.debugCommand(tabId, 'Page.enable');
            return session;
        } catch (error) {
            session.stopTimer();
            await session.transports.stop();
            session.collectionStopped = true;
            session.sealed = true;
            session.transportError = error;
            await session.exportTail;
            try { await this.emit({ action: 'session_abort', session_id: session.id, capture_error: error?.message || String(error) }); } catch (_) { /* host may already be disconnected */ }
            this.sessions.delete(tabId);
            if (session.attached && session.detachOnFinish) await this.debugDetach(tabId).catch(() => {});
            if (!error.code) error.code = 'debugger_attach_failed';
            throw error;
        }
    }

    async enableCaptureTarget(session, debuggee, type = 'page') {
        const resourceBytes = Math.max(1024 * 1024, Math.min(session.maxBodyBytes * 2, 64 * 1024 * 1024));
        const options = {
            maxTotalBufferSize: Math.max(20 * 1024 * 1024, resourceBytes * 2),
            maxResourceBufferSize: resourceBytes,
            maxPostDataSize: Math.max(session.maxBodyBytes, 256 * 1024),
        };
        await this.sendDebugCommand(debuggee, 'Network.enable', { ...options, enableDurableMessages: true })
            .catch(() => this.sendDebugCommand(debuggee, 'Network.enable', options));
        await session.transports.enableTarget(debuggee, type);
        await this.sendDebugCommand(debuggee, 'Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
            filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }],
        }).catch((error) => { session.targetCoverageError = error?.message || String(error); });
    }

    async finishSession(session, settleResult) {
        if (!session.finishPromise) session.finishPromise = this.finishSessionOnce(session, settleResult);
        return session.finishPromise;
    }

    async finishSessionOnce(session, settleResult) {
        session.stopTimer();
        // The set can grow while earlier body reads resolve. Drain until quiet,
        // then freeze the observation boundary before detaching the debugger.
        const deadline = Date.now() + BODY_DRAIN_MS;
        do {
            await delay(75);
            if (session.bodyPromises.size) {
                await Promise.race([
                    Promise.allSettled(Array.from(session.bodyPromises)),
                    delay(Math.max(0, deadline - Date.now())),
                ]);
            }
        } while (session.bodyPromises.size && Date.now() < deadline);
        await session.transports.stop();
        session.sealed = true;
        for (const record of session.requests.values()) {
            if (record.exportQueued) continue;
            if (isStreamRecord(record)) {
                if (record.stream.state !== 'closed') {
                    const reason = session.attached
                        ? (settleResult?.timedOut ? 'capture_deadline' : 'capture_ended')
                        : 'debugger_detached';
                    this.finishStreamRecord(session, record, reason);
                }
                this.queueCompletedRecord(session, record);
                continue;
            }
            if (record.bodyStream?.enabled && !record.bodyFinalized) {
                this.applyStreamBody(record, record.network_state === 'complete' ? '' : record.network_state === 'failed' ? 'network_failed' : 'capture_deadline');
            }
            if (!record.response_body_capture || record.response_body_capture.state === 'pending') {
                record.response_body_capture = {
                    state: record.response?.body ? 'partial' : 'unavailable',
                    reason: session.attached ? 'capture_deadline' : 'debugger_detached',
                    source: 'cdp', captured_bytes: 0,
                };
                record.response_body_error ||= 'capture ended before the response body became available';
            }
            if (record.request_body_capture?.state === 'pending') {
                record.request_body_capture = { ...record.request_body_capture, state: 'unavailable', reason: 'capture_deadline' };
            }
            record.complete = true;
            this.queueCompletedRecord(session, record);
        }
        if (session.attached && session.detachOnFinish) await this.debugDetach(session.tabId).catch(() => {});
        else if (session.attached) {
            if (this.semantic.sessions.has(session.tabId)) await this.semantic.restoreAutoAttach(session.tabId).catch(() => {});
            else await this.debugCommand(session.tabId, 'Target.setAutoAttach', {
                autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
            }).catch(() => {});
        }
        this.sessions.delete(session.tabId);

        await session.exportTail;
        if (session.transportError) {
            try { await this.emit({ action: 'session_abort', session_id: session.id, capture_error: session.transportError.message }); } catch (_) { /* disconnected host cannot acknowledge abort */ }
            throw session.transportError;
        }
        if (session.bodyBudget.exhausted) session.warnings.add('total_body_limit');
        if (session.targetCoverageError) session.warnings.add('related_targets_unavailable');
        try { await this.emit({
            action: 'session_end', session_id: session.id,
            url: session.finalURL || session.url, tab_id: session.tabId,
            capture_mode: session.captureMode, timed_out: Boolean(settleResult?.timedOut),
            expected_requests: session.exportedRecords,
            capture_warnings: [...session.warnings],
            capture_stats: { retained_body_bytes: session.bodyBudget.bytes, observed_events: session.observedEvents, dropped_events: session.droppedEvents, dropped_requests: session.droppedRequests, exported_records: session.exportedRecords, ...session.transports.statistics() },
        }); } catch (error) {
            try { await this.emit({ action: 'session_abort', session_id: session.id, capture_error: error?.message || String(error) }); } catch (_) { /* host may already be disconnected */ }
            throw error;
        }
    }

    queueCompletedRecord(session, record) {
        if (!session.nativeStarted || record.exportQueued || !record.complete || session.transportError) return;
        if (record.request_body_capture?.state === 'pending' || record.response_body_capture?.state === 'pending') return;
        if (record.bodyStream && !record.bodyStream.ready && !record.bodyFinalized && !session.sealed) return;
        if (record.fetchPrimary && !record.bodyFinalized && !session.sealed) return;
        if (!isStreamRecord(record) && !/^https?:/i.test(record.url)) return;
        if (record.bodyStream?.collector.bytes && record.response_body_capture?.source !== 'cdp-stream') {
            // A failed/unavailable stream may have retained data events whose
            // initial buffered prefix never arrived. Those bytes are absent
            // from the exported body and must not consume its archive budget.
            session.bodyBudget.release(record.bodyStream.collector.bytes);
            record.bodyStream.collector.bytes = 0;
            record.bodyStream.collector.parts = [];
        }
        const snapshot = structuredClone(stripInternalFields(record));
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
        if (session.exportPendingBytes + bytes > session.limits.max_native_backlog_bytes) {
            session.transportError = rpcError('capture_backlog_limit', 'completed capture records exceeded the native export byte budget; capture was not sealed', { max_native_backlog_bytes: session.limits.max_native_backlog_bytes });
            session.collectionStopped = true;
            session.fail(session.transportError);
            return;
        }
        record.exportQueued = true;
        session.sourceRecords.get(record.debuggee?.sessionId || '')?.delete(record);
        session.exportPendingBytes += bytes;
        session.exportTail = session.exportTail.then(async () => {
            if (session.transportError) return;
            for await (const message of nativeRequestMessages([snapshot], session.id)) {
                if (session.transportError) return;
                await this.emit(message);
            }
            if (session.transportError) return;
            session.exportedRecords += 1;
            record.exported = true;
            record.body = '';
            if (record.response) record.response.body = '';
            if (record.stream) record.stream.events = [];
            if (record.bodyStream) record.bodyStream.collector.parts = [];
        }).catch((error) => {
            session.transportError = error;
            session.collectionStopped = true;
            session.fail(error);
        }).finally(() => { session.exportPendingBytes -= bytes; });
    }

    handleDebuggerEvent(source, method, params = {}) {
        const tabId = source?.tabId;
        const session = this.sessions.get(tabId);
        if (!session) return;
        if (method === 'Target.attachedToTarget') {
            const debuggee = { tabId, sessionId: params.sessionId };
            const setup = (session.sealed ? Promise.resolve() : this.enableCaptureTarget(session, debuggee, params.targetInfo?.type || 'iframe'))
                .catch((error) => { if (session.targetSetups.has(params.sessionId)) session.targetCoverageError = error?.message || String(error); })
                .finally(async () => {
                    // Startup is briefly paused so a new frame/worker cannot
                    // issue its first requests before Network.enable finishes.
                    await this.sendDebugCommand(debuggee, 'Runtime.runIfWaitingForDebugger').catch((error) => { if (session.targetSetups.has(params.sessionId)) session.targetCoverageError = error?.message || String(error); });
                    session.bodyPromises.delete(setup);
                    session.targetSetups.delete(params.sessionId);
                });
            session.bodyPromises.add(setup);
            session.targetSetups.set(params.sessionId, setup);
            return;
        }
        if (method === 'Target.detachedFromTarget') {
            // A command sent to a target that detaches (commonly the previous
            // document's frames during navigation) gets no reply until Chromium
            // gives up seconds later. The target is gone, so its setup no longer
            // gates sealing; otherwise every such capture waited ~5 s to finish.
            const setup = session.targetSetups.get(params.sessionId);
            if (setup) {
                session.bodyPromises.delete(setup);
                session.targetSetups.delete(params.sessionId);
            }
        }
        if (session.sealed || session.collectionStopped) return;
        if (session.transports.handle(source, method, params)) return;
        if (source.sessionId && params.requestId) {
            const routed = `${source.sessionId}:${params.requestId}`;
            // An out-of-process iframe's navigation starts in its parent's
            // session, but the child reports the document's data and completion
            // under the same raw ID. Without this route the frame document stays
            // pending, the capture waits out its load-grace timer, and the body
            // is never read. The child session owns the body from here on.
            if (method !== 'Network.requestWillBeSent' && !session.current.has(routed)) {
                const parent = session.pendingDocuments.get(params.requestId);
                if (parent && !parent.complete && parent.debuggee?.sessionId !== source.sessionId) {
                    session.sourceRecords.get(parent.debuggee?.sessionId || '')?.delete(parent);
                    parent.debuggee = { tabId, sessionId: source.sessionId };
                    trackSourceRecord(session, parent);
                    session.current.set(routed, parent);
                }
            }
            params = { ...params, rawRequestId: params.requestId, requestId: routed, debuggee: { tabId, sessionId: source.sessionId } };
        }

        switch (method) {
        case 'Target.detachedFromTarget':
            for (const record of session.sourceRecords.get(params.sessionId) || []) {
                if (isStreamRecord(record) && record.debuggee?.sessionId === params.sessionId && !record.complete) {
                    this.finishStreamRecord(session, record, 'target_detached');
                    this.queueCompletedRecord(session, record);
                    continue;
                }
                if (record.debuggee?.sessionId !== params.sessionId || record.network_state !== 'pending') continue;
                if (record.bodyStream?.enabled) this.applyStreamBody(record, 'target_detached');
                else record.response_body_capture = { state: 'unavailable', reason: 'target_detached', source: 'cdp', captured_bytes: 0 };
                record.bodyFinalized = true;
                record.complete = true;
                session.blocking.delete(record.key);
                this.queueCompletedRecord(session, record);
            }
            session.sourceRecords.delete(params.sessionId);
            session.checkIdle();
            break;
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
        case 'Network.dataReceived':
            this.onDataReceived(session, params);
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
        case 'Network.webSocketCreated':
        case 'Network.webSocketWillSendHandshakeRequest':
        case 'Network.webSocketHandshakeResponseReceived':
        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameReceived':
        case 'Network.webSocketFrameError':
        case 'Network.webSocketClosed':
            this.onWebSocketEvent(session, method, params);
            break;
        case 'Page.loadEventFired':
            if (source.sessionId) break;
            session.loaded = true;
            session.checkIdle();
            session.startGrace(Math.max(2500, session.idleMs * 4));
            break;
        case 'Page.frameNavigated':
            if (!source.sessionId && !params.frame?.parentId && params.frame?.url) session.finalURL = params.frame.url;
            break;
        default:
            break;
        }
    }

    handleDebuggerDetach(source, reason) {
        super.handleDebuggerDetach(source, reason);
        const session = this.sessions.get(source?.tabId);
        if (!session) return;
        session.attached = false;
        if (!session.done) session.fail(rpcError('debugger_detached', `Debugger detached: ${reason || 'unknown'}`));
    }

    onRequestWillBeSent(session, params) {
        if (/^wss?:/i.test(params.request?.url || '') || params.type === 'WebSocket') {
            this.onWebSocketEvent(session, 'Network.webSocketCreated', { ...params, url: params.request?.url });
            return;
        }
        if (!/^https?:/i.test(params.request?.url || '')) return;
        const requestId = params.requestId;
        const previous = session.current.get(requestId);
        if (previous && params.redirectResponse) {
            previous.response = responseFromCDP(params.redirectResponse);
            previous.response_ordinal ||= session.nextEventOrdinal();
            previous.completion_ordinal = session.nextEventOrdinal();
            previous.complete = true;
            previous.network_state = 'redirected';
            previous.response_body_capture = { state: 'not_applicable', reason: 'redirect_response', source: 'cdp', captured_bytes: 0 };
            previous.bodyFinalized = true;
            session.blocking.delete(previous.key);
            this.queueCompletedRecord(session, previous);
        }
        if (session.requests.size >= session.limits.max_requests) {
            session.droppedRequests += 1;
            session.warnings.add('request_limit');
            session.current.delete(requestId);
            return;
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
        if (pendingDownload) session.pendingDownloadCount -= 1;
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
            body: '',
            response: null,
            response_encoding: '',
            network_state: 'pending',
            response_body_capture: { state: 'pending', source: 'cdp', captured_bytes: 0 },
            cdpRequestID: params.rawRequestId || requestId,
            debuggee: params.debuggee || { tabId: session.tabId },
            capture_source: 'cdp',
            tab_id: session.tabId,
            timestamp,
            ...(params.timestamp != null ? { monotonic_timestamp: params.timestamp } : {}),
            frame_id: params.frameId || '',
            loader_id: params.loaderId || '',
            source_session_id: params.debuggee?.sessionId || '',
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
        trackSourceRecord(session, record);
        session.current.set(requestId, record);
        if (downloadKey && !pendingDownload) {
            const candidates = session.downloadCandidates.get(downloadKey) || [];
            candidates.push(record);
            session.downloadCandidates.set(downloadKey, candidates);
        }
        if (record.resource_type === 'document') session.pendingDocuments.set(record.cdpRequestID, record);
        if (Object.hasOwn(request, 'postData')) {
            const bounded = boundedRequestBody(session, request.postData);
            record.body = bounded.text;
            record.request_body_capture = { state: bounded.truncated ? 'partial' : 'complete', reason: bounded.reason, source: 'cdp-inline', captured_bytes: bounded.bytes, observed_bytes: bounded.observed };
            if (/multipart\/form-data/i.test(firstHeaderValue(record.headers, 'content-type'))) {
                record.request_body_capture.state = 'partial';
                record.request_body_capture.reason = 'multipart_file_bytes_unavailable';
            }
        }
        if (request.hasPostData && !Object.hasOwn(request, 'postData')) {
            record.request_body_capture = { state: 'pending', source: 'cdp', captured_bytes: 0 };
            const post = this.sendDebugCommand(record.debuggee, 'Network.getRequestPostData', { requestId: record.cdpRequestID })
                .then((result) => {
                    if (session.sealed) return;
                    if (typeof result?.postData !== 'string') throw new Error('browser omitted post data');
                    const bounded = boundedRequestBody(session, result.postData);
                    record.body = bounded.text;
                    record.request_body_capture = {
                        state: bounded.truncated ? 'partial' : 'complete', reason: bounded.reason,
                        source: 'cdp', captured_bytes: bounded.bytes, observed_bytes: bounded.observed,
                    };
                    // CDP deliberately omits file bytes from multipart post data.
                    if (/multipart\/form-data/i.test(firstHeaderValue(record.headers, 'content-type'))) {
                        record.request_body_capture.state = 'partial';
                        record.request_body_capture.reason = 'multipart_file_bytes_unavailable';
                    }
                }).catch((error) => {
                    if (!session.sealed) record.request_body_capture = { state: 'unavailable', reason: 'browser_post_data_unavailable', source: 'cdp', captured_bytes: 0 };
                }).finally(() => { session.bodyPromises.delete(post); this.queueCompletedRecord(session, record); });
            session.bodyPromises.add(post);
        }
        if (!NON_BLOCKING_TYPES.has(params.type)) session.blocking.add(key);
        session.cancelIdle();
        // Long-lived non-blocking transports still count as activity, but do
        // not prevent quiescence forever merely because they never finish.
        session.checkIdle();
    }

    onRequestExtraInfo(session, params) {
        const record = session.current.get(params.requestId);
        const headers = headersToMap(params.headers);
        if (record?.exportQueued) { session.warnings.add('late_metadata_after_export'); return; }
        if (record) record.headers = mergeHeaderMaps(record.headers, headers);
        else if (session.requestExtra.size < session.limits.max_requests) session.requestExtra.set(params.requestId, headers);
        else session.warnings.add('request_metadata_limit');
    }

    onResponseReceived(session, params) {
        let record = session.current.get(params.requestId);
        if (!record && /^https?:/i.test(params.response?.url || '')) {
            if (session.requests.size >= session.limits.max_requests) { session.warnings.add('request_limit'); return; }
            this.onRequestWillBeSent(session, {
                ...params, request: { url: params.response.url, method: 'UNKNOWN', headers: {} },
            });
            record = session.current.get(params.requestId);
            if (record) record.request_body_capture = { state: 'unavailable', reason: 'request_started_before_capture', source: 'cdp', captured_bytes: 0 };
        }
        if (!record) return;
        if (record.exportQueued) { session.warnings.add('late_metadata_after_export'); return; }
        record.response = responseFromCDP(params.response);
        if (params.timestamp != null) record.response.monotonic_timestamp = params.timestamp;
        record.response_ordinal ||= session.nextEventOrdinal();
        record.resource_type = record.resource_type || String(params.type || '').toLowerCase();
        if (bodyNotApplicable(record)) {
            record.response_body_capture = { state: 'not_applicable', reason: 'http_no_body', source: 'cdp', captured_bytes: 0 };
        } else this.startResponseStream(session, record);
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
        if (record?.exportQueued) { session.warnings.add('late_metadata_after_export'); return; }
        if (record?.response) {
            record.response.headers = mergeHeaderMaps(record.response.headers, extra.headers);
            if (extra.status) record.response.status = extra.status;
        } else {
            if (session.responseExtra.size < session.limits.max_requests) session.responseExtra.set(params.requestId, extra);
            else session.warnings.add('request_metadata_limit');
        }
    }

    startResponseStream(session, record) {
        if (record.fetchPrimary || record.bodyStream || session.maxBodyBytes <= 0) return;
        if (bodyNotApplicable(record)) return;
        const stream = { collector: new ResponseBodyCollector(session.maxBodyBytes, session.bodyBudget), enabled: false, ready: false };
        record.bodyStream = stream;
        stream.promise = this.sendDebugCommand(record.debuggee, 'Network.streamResourceContent', { requestId: record.cdpRequestID })
            .then((result) => {
                if (session.sealed || record.exportQueued || record.bodyFinalized || stream.error || typeof result?.bufferedData !== 'string') return;
                stream.collector.prependBase64(result.bufferedData);
                stream.enabled = true;
            }).catch((error) => { stream.error = error?.message || String(error); })
            .finally(() => {
                stream.ready = true;
                session.bodyPromises.delete(stream.promise);
                if (!session.sealed && !record.exportQueued && record.complete && record.network_state === 'failed') this.applyStreamBody(record, 'network_failed');
                this.queueCompletedRecord(session, record);
            });
        session.bodyPromises.add(stream.promise);
    }

    onDataReceived(session, params) {
        const record = session.current.get(params.requestId);
        if (!record || record.exportQueued || record.bodyFinalized) return;
        record.receivedDecodedBytes = (record.receivedDecodedBytes || 0) + Math.max(0, Number(params.dataLength) || 0);
        if (typeof params.data === 'string' && record.bodyStream) {
            try { record.bodyStream.collector.appendBase64(params.data); }
            catch (error) { record.bodyStream.error = error?.message || String(error); record.bodyStream.enabled = false; }
        }
    }

    onLoadingFinished(session, params) {
        const record = session.current.get(params.requestId);
        if (!record || record.complete || record.bodyReadStarted) return;
        record.bodyReadStarted = true;
        record.network_state = 'complete';
        record.completion_monotonic_timestamp = params.timestamp;
        if (record.response && params.encodedDataLength != null) record.response.encoded_data_length = params.encodedDataLength;
        record.completion_ordinal = session.nextEventOrdinal();
        const bodyPromise = this.captureResponseBody(session, record, params)
            .catch((error) => {
                if (session.sealed || record.bodyFinalized) return;
                record.response_body_error = error?.message || String(error);
                if (record.bodyStream?.enabled && record.bodyStream.collector.bytes > 0) {
                    this.applyStreamBody(record, 'stream_data_missing');
                } else record.response_body_capture = { state: 'unavailable', reason: 'browser_buffer_unavailable', source: 'cdp-buffer', captured_bytes: 0 };
            }).finally(() => {
                record.complete = true;
                session.blocking.delete(record.key);
                session.checkIdle();
                session.bodyPromises.delete(bodyPromise);
                this.queueCompletedRecord(session, record);
            });
        session.bodyPromises.add(bodyPromise);
    }

    applyStreamBody(record, reason = '') {
        if (!record.response || !record.bodyStream?.enabled || record.bodyFinalized) return;
        const collector = record.bodyStream.collector;
        const rendered = collector.materialize(firstHeaderValue(record.response.headers, 'content-type'));
        record.response.body = rendered.body;
        record.response_encoding = rendered.encoding;
        const partialReason = rendered.truncated ? (collector.budgetTruncated ? 'total_body_limit' : 'body_limit') : reason;
        record.response_body_capture = {
            state: partialReason ? 'partial' : 'complete', reason: partialReason || undefined,
            source: 'cdp-stream', captured_bytes: rendered.captured,
            observed_bytes: Math.max(collector.observed, record.receivedDecodedBytes || 0),
            encoding: rendered.charset, chunks: collector.chunks,
        };
        if (partialReason) record.response_body_truncated = true;
        record.bodyFinalized = true;
        // Release raw chunks once the immutable representation has been made.
        collector.parts = [];
    }

    async captureResponseBody(session, record) {
        if (!record.response) return;
        if (record.fetchPrimary) return;
        if (bodyNotApplicable(record)) {
            record.response_body_capture = { state: 'not_applicable', reason: 'http_no_body', source: 'cdp', captured_bytes: 0 };
            return;
        }
        if (session.maxBodyBytes <= 0) {
            record.response_body_capture = { state: 'unavailable', reason: 'body_capture_disabled', source: 'cdp', captured_bytes: 0 };
            return;
        }
        if (session.bodyBudget.bytes >= session.bodyBudget.limit && !record.bodyStream?.collector.bytes) {
            session.bodyBudget.exhausted = true;
            record.response_body_capture = { state: 'unavailable', reason: 'total_body_limit', source: 'cdp', captured_bytes: 0, observed_bytes: record.receivedDecodedBytes || 0 };
            return;
        }
        if (record.bodyStream) await record.bodyStream.promise;
        if (session.sealed || record.bodyFinalized) return;
        if (record.bodyStream?.enabled) {
            const missingStreamBytes = Math.max(0, (record.receivedDecodedBytes || 0) - record.bodyStream.collector.observed);
            if (!missingStreamBytes) {
                this.applyStreamBody(record);
                return;
            }
        }
        // Cached responses can have zero encoded transfer bytes; compressed
        // responses have a decoded body too. Neither is a reason to omit it.
        const result = await this.sendDebugCommand(record.debuggee, 'Network.getResponseBody', { requestId: record.cdpRequestID });
        if (session.sealed || record.bodyFinalized) return;
        if (typeof result?.body !== 'string') throw new Error('browser omitted response body');
        const body = result.body;
        const bounded = boundedCapturedBody(session, body, Boolean(result?.base64Encoded), record);
        record.response.body = bounded.body;
        record.response_encoding = bounded.encoding;
        record.response_body_capture = {
            state: bounded.truncated ? 'partial' : 'complete', reason: bounded.reason,
            source: 'cdp-buffer', captured_bytes: bounded.bytes,
            observed_bytes: bounded.observed, encoding: bounded.encoding || 'utf-8',
        };
        if (bounded.truncated) record.response_body_truncated = true;
        record.bodyFinalized = true;
    }

    onLoadingFailed(session, params) {
        const record = session.current.get(params.requestId);
        if (!record || record.exportQueued) return;
        const errorText = params.errorText || 'network load failed';
        record.response ||= { status: 0, headers: {}, body: '' };
        record.network_state = 'failed';
        record.completion_monotonic_timestamp = params.timestamp;
        if (record.bodyStream?.enabled) this.applyStreamBody(record, 'network_failed');
        if (!record.bodyFinalized) record.response_body_capture = { state: 'unavailable', reason: 'network_failed', source: 'cdp', captured_bytes: 0 };
        record.canceled = Boolean(params.canceled) || errorText === 'net::ERR_ABORTED';
        record.completion_ordinal = session.nextEventOrdinal();
        const intentionalCancellation = classifyIntentionalCancellation(record, errorText);
        if (intentionalCancellation) record.intentional_cancellation = intentionalCancellation;
        else record.error_text = errorText;
        record.complete = true;
        session.blocking.delete(record.key);
        session.checkIdle();
        this.queueCompletedRecord(session, record);
    }

    onDownloadWillBegin(session, params) {
        const key = normalizedURLKey(params.url);
        if (!key) return;
        const ordinal = session.nextEventOrdinal();
        const candidates = session.downloadCandidates.get(key);
        const record = candidates?.pop();
        if (candidates?.length === 0) session.downloadCandidates.delete(key);
        if (!record) {
            if (session.pendingDownloadCount >= session.limits.max_requests) session.warnings.add('download_metadata_limit');
            else {
                const pending = session.pendingDownloads.get(key) || [];
                pending.push({ ordinal, frameId: params.frameId || '' });
                session.pendingDownloads.set(key, pending);
                session.pendingDownloadCount += 1;
            }
        } else if (record.exportQueued) {
            // An immutable exported record cannot be reclassified using a
            // download notification that arrived after its observation boundary.
            session.warnings.add('late_download_after_export');
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

    onWebSocketEvent(session, method, params) {
        let record = session.current.get(params.requestId);
        const created = method === 'Network.webSocketCreated';
        if (!record) {
            if (session.requests.size >= session.limits.max_requests) {
                if (created) session.droppedRequests += 1;
                session.observedEvents += 1;
                session.droppedEvents += 1;
                session.warnings.add('request_limit');
                return;
            }
            const timestamp = params.wallTime ? Math.round(params.wallTime * 1000) : Date.now();
            record = {
                id: buildStableRequestId({ requestId: params.requestId, tabId: session.tabId, timestamp, method: '', url: params.url || '' }),
                original_id: params.requestId, record_kind: 'websocket', method: '', url: params.url || '',
                page_url: session.finalURL || session.url, resource_type: 'websocket', headers: {}, body: '',
                capture_source: 'cdp', tab_id: session.tabId, timestamp,
                ...(params.timestamp != null ? { monotonic_timestamp: params.timestamp } : {}),
                source_session_id: params.debuggee?.sessionId || '', frame_id: params.frameId || '', loader_id: params.loaderId || '',
                initiator: initiatorURL(params.initiator),
                cdpRequestID: params.rawRequestId || params.requestId, debuggee: params.debuggee || { tabId: session.tabId },
                key: `websocket:${params.requestId}`, network_state: 'pending', complete: false, streamSequence: 0,
                request_body_capture: { state: 'not_applicable', reason: 'websocket_messages', source: 'cdp', captured_bytes: 0 },
                response_body_capture: { state: 'not_applicable', reason: 'websocket_messages', source: 'cdp', captured_bytes: 0 },
                stream: { version: 1, protocol: 'websocket', connection_id: `${session.id}:${params.requestId}`, state: created ? 'connecting' : 'open', events: [],
                    capture: { state: 'pending', ...(created ? {} : { reason: 'connection_started_before_capture' }), captured_events: 0, observed_events: 0, captured_bytes: 0, observed_bytes: 0, dropped_events: 0 } },
            };
            session.requests.set(record.key, record);
            trackSourceRecord(session, record);
            session.current.set(params.requestId, record);
        }
        if (record.record_kind !== 'websocket') { session.warnings.add('websocket_identity_conflict'); return; }
        if (record.exportQueued) {
            session.observedEvents += 1;
            session.droppedEvents += 1;
            session.warnings.add('websocket_event_after_close');
            return;
        }
        const event = { sequence: ++record.streamSequence, kind: 'created', ...(params.timestamp != null ? { timestamp: params.timestamp } : {}) };
        let sourcePayload;
        let binary = false;
        switch (method) {
        case 'Network.webSocketCreated':
            if (params.url) record.url = params.url;
            break;
        case 'Network.webSocketWillSendHandshakeRequest':
            event.kind = 'handshake_request'; event.direction = 'sent';
            record.headers = headersToMap(params.request?.headers);
            if (params.wallTime) record.timestamp = Math.round(params.wallTime * 1000);
            break;
        case 'Network.webSocketHandshakeResponseReceived':
            event.kind = 'handshake_response'; event.direction = 'received';
            record.response = responseFromCDP(params.response);
            record.response_ordinal = session.nextEventOrdinal();
            record.stream.state = 'open';
            break;
        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameReceived':
            // CDP exposes complete WebSocket messages. These bytes do not
            // reconstruct transport fragmentation, masking or compression.
            event.kind = 'message';
            event.direction = method.endsWith('Sent') ? 'sent' : 'received';
            event.opcode = Number(params.response?.opcode) || 0;
            event.mask = Boolean(params.response?.mask);
            sourcePayload = String(params.response?.payloadData || '');
            binary = event.opcode !== 1;
            break;
        case 'Network.webSocketFrameError':
            event.kind = 'error'; event.error = String(params.errorMessage || 'WebSocket error');
            record.error_text = event.error;
            break;
        case 'Network.webSocketClosed':
            event.kind = 'closed';
            break;
        default: return;
        }
        this.appendStreamEvent(session, record, event, sourcePayload, binary);
        if (method === 'Network.webSocketClosed') {
            this.finishStreamRecord(session, record);
            this.queueCompletedRecord(session, record);
        }
        session.cancelIdle();
        session.checkIdle();
    }

    appendStreamEvent(session, record, event, payload, binary = false) {
        const capture = record.stream.capture;
        capture.observed_events += 1;
        session.observedEvents += 1;
        const observedBytes = payload == null ? 0 : binary ? base64DecodedLength(payload) : new TextEncoder().encode(payload).byteLength;
        capture.observed_bytes += observedBytes;
        if (session.capturedEvents >= session.limits.max_events) {
            capture.dropped_events += 1;
            session.droppedEvents += 1;
            capture.reason = 'event_limit';
            session.warnings.add('event_limit');
            return;
        }
        if (payload != null) {
            try {
                const captured = boundedCapturedBody(session, payload, binary);
                event.payload = captured.body;
                event.payload_encoding = captured.encoding || 'utf-8';
                event.bytes = captured.bytes;
                if (captured.truncated) { event.truncated = true; capture.reason = captured.reason; session.warnings.add(captured.reason); }
                capture.captured_bytes += captured.bytes;
            } catch (_) {
                event.error = 'browser_payload_decode_failed';
                event.truncated = true;
                event.bytes = 0;
                capture.reason = 'browser_payload_decode_failed';
                session.warnings.add('browser_payload_decode_failed');
            }
        }
        record.stream.events.push(event);
        capture.captured_events += 1;
        session.capturedEvents += 1;
    }

    finishStreamRecord(session, record, reason = '') {
        if (record.complete) return;
        if (reason) {
            this.appendStreamEvent(session, record, { sequence: ++record.streamSequence, kind: reason === 'target_detached' ? 'target_detached' : 'capture_end' });
            record.stream.capture.reason ||= reason;
        }
        record.stream.state = reason ? 'interrupted' : 'closed';
        record.stream.capture.state = record.stream.capture.reason ? 'partial' : 'complete';
        record.network_state = reason ? 'pending' : 'complete';
        record.complete = true;
        record.completion_ordinal = session.nextEventOrdinal();
    }


}

function createCaptureSession(tabId, options) {
    const limits = captureLimits(options.limits || options);
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
        maxBodyBytes: options.maxBodyBytes ?? DEFAULT_BODY_LIMIT,
        limits,
        bodyBudget: new CaptureBodyBudget(limits.max_total_body_bytes),
        observedEvents: 0,
        capturedEvents: 0,
        droppedEvents: 0,
        droppedRequests: 0,
        warnings: new Set(),
        nativeStarted: false,
        exportTail: Promise.resolve(),
        exportPendingBytes: 0,
        exportedRecords: 0,
        collectionStopped: false,
        idleMs: options.idleMs,
        loaded: options.captureMode === 'fetch',
        attached: false,
        detachOnFinish: true,
        contextOverrides: {},
        done: false,
        sealed: false,
        requests: new Map(),
        current: new Map(),
        sourceRecords: new Map(),
        requestSequence: new Map(),
        requestExtra: new Map(),
        responseExtra: new Map(),
        eventOrdinal: 0,
        pendingDownloads: new Map(),
        pendingDownloadCount: 0,
        downloadCandidates: new Map(),
        pendingDocuments: new Map(),
        targetSetups: new Map(),
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
                .filter((request) => isStreamRecord(request) || /^https?:/i.test(request.url))
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
    // Setup and export can fail before the operation reaches its await below.
    // The caller still observes the original rejection through settled/finish.
    session.settled.catch(() => {});
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

function responseBodyLimit(value) {
    if (value == null) return DEFAULT_BODY_LIMIT;
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_BODY_LIMIT) {
        throw rpcError('invalid_argument', `max_body_bytes must be an integer from 0 to ${MAX_BODY_LIMIT}`, { max_body_bytes: MAX_BODY_LIMIT });
    }
    return limit;
}

function captureLimits(values = {}) {
    values = values.capture_limits || values;
    const limits = {};
    const maxima = { max_total_body_bytes: 256 * 1024 * 1024, max_requests: 100000, max_events: 100000, max_native_backlog_bytes: 64 * 1024 * 1024 };
    for (const [name, fallback] of Object.entries(DEFAULT_CAPTURE_LIMITS)) {
        const value = values[name] == null ? fallback : Number(values[name]);
        const minimum = name === 'max_native_backlog_bytes' ? 1024 * 1024 : 0;
        if (!Number.isSafeInteger(value) || value < minimum || value > maxima[name]) throw rpcError('invalid_argument', `${name} must be an integer from ${minimum} to ${maxima[name]}`);
        limits[name] = value;
    }
    return limits;
}

function trackSourceRecord(session, record) {
    const source = record.debuggee?.sessionId || '';
    const records = session.sourceRecords.get(source) || new Set();
    records.add(record);
    session.sourceRecords.set(source, records);
}

function boundedCapturedBody(session, body, base64 = false, replacingRecord = null) {
    const previous = replacingRecord?.bodyStream?.collector;
    if (previous?.bytes) { session.bodyBudget.release(previous.bytes); previous.bytes = 0; previous.parts = []; }
    const collector = new ResponseBodyCollector(session.maxBodyBytes, session.bodyBudget);
    if (base64) collector.appendBase64(body);
    else collector.appendBytes(new TextEncoder().encode(body));
    const rendered = collector.materialize(base64 ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    return { body: rendered.body, encoding: rendered.encoding, bytes: rendered.captured, observed: collector.observed, truncated: rendered.truncated,
        reason: rendered.truncated ? (collector.budgetTruncated ? 'total_body_limit' : 'body_limit') : undefined };
}

function boundedRequestBody(session, body) {
    const remaining = Math.max(0, session.bodyBudget.limit - session.bodyBudget.bytes);
    const bounded = utf8BoundedPrefix(body, Math.min(session.maxBodyBytes, remaining));
    session.bodyBudget.take(bounded.bytes);
    const totalLimited = bounded.truncated && remaining < session.maxBodyBytes;
    if (totalLimited) session.bodyBudget.exhausted = true;
    return { ...bounded, observed: new TextEncoder().encode(body).byteLength, reason: bounded.truncated ? (totalLimited ? 'total_body_limit' : 'body_limit') : undefined };
}

function bodyNotApplicable(record) {
    const status = Number(record.response?.status || 0);
    return String(record.method || '').toUpperCase() === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
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
        text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded.subarray(0, end)),
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
        const abortController = new AbortController();
        init.signal = abortController.signal;
        const timeout = setTimeout(() => abortController.abort('rep fetch deadline reached'), Math.max(1, options.timeoutMs || 30000));
        try {
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
        let bodyError = '';
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
            } catch (error) {
                bodyError = String(error?.message || error);
                truncated = true;
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
        let body = '';
        let bodyEncoding = '';
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const textual = contentType.startsWith('text/') || ['json', 'javascript', 'xml', 'x-www-form-urlencoded', 'graphql'].some(type => contentType.includes(type));
        try {
            if (!textual) throw new Error('binary response');
            body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch (_) {
            bodyEncoding = 'base64';
            const pieces = [];
            for (let index = 0; index < bytes.length; index += 16384) pieces.push(String.fromCharCode(...bytes.subarray(index, index + 16384)));
            body = btoa(pieces.join(''));
        }
        const bodyBytes = capturedBytes;
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
            body_encoding: bodyEncoding,
            body_error: bodyError || undefined,
            body_observed_bytes: observedBytes,
            body_declared_bytes: declaredBytes,
            body_truncated: truncated
        };
        } finally { clearTimeout(timeout); }
    })()`;
}

export function summarizeRequests(requests) {
    const domains = new Set();
    let responseBodies = 0;
    let bodyBytes = 0;
    let failed = 0;
    let ignoredCancellations = 0;
    let pendingNetwork = 0;
    const bodyStates = { complete: 0, partial: 0, unavailable: 0, pending: 0, not_applicable: 0, unknown: 0 };
    for (const request of requests) {
        try { domains.add(new URL(request.url).host); } catch (_) { /* invalid event URL */ }
        const state = request.response_body_capture?.state || 'unknown';
        bodyStates[Object.hasOwn(bodyStates, state) ? state : 'unknown'] += 1;
        if (request.network_state === 'pending') pendingNetwork += 1;
        const retainedBytes = request.response_body_capture?.captured_bytes;
        if (request.response?.body || retainedBytes > 0) {
            responseBodies += 1;
            bodyBytes += retainedBytes ?? (request.response_encoding === 'base64'
                ? base64DecodedLength(request.response.body)
                : new TextEncoder().encode(request.response.body).byteLength);
        }
        if (request.intentional_cancellation) ignoredCancellations += 1;
        else if (request.error_text || (request.record_kind !== 'websocket' && request.response && request.response.status === 0)) failed += 1;
    }
    return {
        requests: requests.length,
        domains: domains.size,
        response_bodies: responseBodies,
        captured_body_bytes: bodyBytes,
        failed_requests: failed,
        ignored_cancellations: ignoredCancellations,
        pending_network_requests: pendingNetwork,
        body_capture_states: bodyStates,
    };
}

function fetchResponsePreview(result = {}, session) {
    const bounded = utf8BoundedPrefix(result.body || '', 64 * 1024);
    const record = session.current.get(session.fetchRequestID);
    return {
        ...result, body: bounded.text,
        request_id: record?.id,
        ...(bounded.truncated ? { body_preview_truncated: true, body_preview_bytes: bounded.bytes, full_body_in_capture: true } : {}),
    };
}

function responseFromCDP(response = {}) {
    const output = {
        status: Math.round(response.status || response.statusCode || 0),
        headers: headersToMap(response.headers),
        body: '',
    };
    for (const [source, target] of Object.entries({ protocol: 'protocol', remoteIPAddress: 'remote_ip_address', remotePort: 'remote_port', connectionId: 'connection_id', connectionReused: 'connection_reused', timing: 'timing', securityDetails: 'security_details', securityState: 'security_state', fromDiskCache: 'from_disk_cache', fromServiceWorker: 'from_service_worker', fromPrefetchCache: 'from_prefetch_cache', encodedDataLength: 'encoded_data_length' })) {
        if (response[source] !== undefined) output[target] = response[source];
    }
    return output;
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
    for (const name of ['bodyStream', 'bodyFinalized', 'bodyReadStarted', 'receivedDecodedBytes', 'debuggee', 'cdpRequestID', 'exported', 'exportQueued', 'streamSequence', 'protocolContextID']) delete output[name];
    if (!output.response) delete output.response;
    return output;
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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStreamRecord(record) { return ['websocket', 'webtransport', 'webrtc', 'webrtc_media'].includes(record.record_kind); }
