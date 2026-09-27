// Owns browser/debugger control independently of network capture and archive transport.
// Capture controllers specialize only the capture-state hooks below.
import { SemanticRuntime } from './semantic-runtime.js';
import { navigate as navigatePage, screenshot as capturePage } from './page-control.js';

export const MAX_EXPRESSION_BYTES = 768 * 1024;

export class BrowserRuntime {
    constructor({ chromeApi = globalThis.chrome } = {}) {
        this.chrome = chromeApi;
        this.controlAttachments = new Map();
        this.pendingPersistentAttachments = 0;
        this.reloadPending = false;
        this.boundDetach = (source, reason) => this.handleDebuggerDetach(source, reason);
        this.chrome.debugger.onDetach.addListener(this.boundDetach);
        this.debuggerEventListeners = new Set();
        this.childCommands = new Map();
        this.chrome.debugger.onEvent?.addListener((source, method, params) => {
            if (method === 'Target.detachedFromTarget' && params?.sessionId) {
                this.abandonChildCommands(`${source?.tabId}:${params.sessionId}`);
            }
            for (const listener of this.debuggerEventListeners) {
                try { listener(source, method, params); } catch (_) { /* one waiter cannot break another */ }
            }
        });
        this.semantic = new SemanticRuntime(this);
    }

    // Short-lived waiters subscribe without registering another Chrome listener.
    addDebuggerEventListener(listener) {
        this.debuggerEventListeners.add(listener);
        return () => this.debuggerEventListeners.delete(listener);
    }

    navigate(params) { return navigatePage(this, params); }
    screenshot(params) { return capturePage(this, params); }

    captureActivity() { return { active_captures: 0, queued_captures: 0 }; }
    isCapturingTab() { return false; }
    isCaptureAttached() { return false; }
    handleDebuggerDetach(source) {
        this.controlAttachments.delete(debuggeeKey(source || {}));
        for (const key of [...this.childCommands.keys()]) {
            if (key.startsWith(`${source?.tabId}:`)) this.abandonChildCommands(key);
        }
        this.semantic.detached(source);
    }

    // Chromium answers a command to a child session that detached mid-flight
    // only after a long internal timeout (~6 s). The target is gone, so fail
    // those commands now; callers already treat them as target failures.
    abandonChildCommands(key) {
        const inflight = this.childCommands.get(key);
        if (!inflight) return;
        this.childCommands.delete(key);
        for (const abandon of [...inflight]) abandon(rpcError('target_detached', 'debugger target detached before the command completed'));
    }

    acquireLease(params) { return this.semantic.acquire(params); }
    releaseLease(params) { return this.semantic.release(params); }
    observe(params) { return this.semantic.observe(params); }
    validateObservation(params) { return this.semantic.validate(params); }

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
            if (debuggee.tabId != null && this.isCapturingTab(debuggee.tabId)) {
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
        if (debuggee.tabId != null && this.semantic.sessions.has(debuggee.tabId)) {
            throw rpcError('tab_busy', 'tab has a persistent observation session');
        }
        if (!this.controlAttachments.has(key)) {
            return { attached: false, already_detached: true, debuggee };
        }
        await this.debugDetachTarget(debuggee);
        this.controlAttachments.delete(key);
        return { attached: false, already_detached: false, debuggee };
    }

    async sendCDP(params = {}) {
        this.assertReloadNotPending('send a CDP command');
        if (params.lease_id || params.owner || params.frame_id || params.session_id || params.document_generation || params.generation) {
            return this.semantic.cdp(params);
        }
        if (this.semantic.activeExecution(Number(params.tab_id))) {
            throw rpcError('tab_busy', 'tab has an active execution lease');
        }
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
        const captureAttached = debuggee.tabId != null && this.isCaptureAttached(debuggee.tabId);
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
            ...this.captureActivity(),
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
        if (!debuggee?.sessionId) return this.call(this.chrome.debugger, 'sendCommand', debuggee, method, params);
        const key = `${debuggee.tabId}:${debuggee.sessionId}`;
        return new Promise((resolve, reject) => {
            let inflight = this.childCommands.get(key);
            if (!inflight) this.childCommands.set(key, inflight = new Set());
            let settled = false;
            // Settling is synchronous, so a detach cannot override a command
            // Chromium has already answered.
            const settle = (complete, value) => {
                if (settled) return;
                settled = true;
                inflight.delete(abandon);
                if (!inflight.size && this.childCommands.get(key) === inflight) this.childCommands.delete(key);
                complete(value);
            };
            const abandon = (error) => settle(reject, error);
            inflight.add(abandon);
            try {
                this.chrome.debugger.sendCommand(debuggee, method, params, (result) => {
                    const lastError = this.chrome.runtime?.lastError;
                    if (lastError) settle(reject, rpcError('chrome_api_error', lastError.message || String(lastError)));
                    else settle(resolve, result);
                });
            } catch (error) {
                settle(reject, error);
            }
        });
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

export function normalizeURL(input) {
    let value = String(input || '').trim();
    if (!value) throw rpcError('invalid_url', 'URL is required');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw rpcError('invalid_url', `Invalid URL: ${input}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw rpcError('invalid_url', 'Only http:// and https:// URLs are supported');
    return parsed.href;
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

export function debuggeeFromParams(params = {}) {
    const tabId = params.tab_id == null ? null : Number(params.tab_id);
    const targetId = String(params.target_id || '').trim();
    if (Number.isInteger(tabId) && tabId >= 0 && !targetId) return { tabId };
    if (targetId && params.tab_id == null) return { targetId };
    if (targetId && Number.isInteger(tabId) && tabId >= 0) {
        throw rpcError('invalid_argument', 'provide exactly one of tab_id or target_id');
    }
    throw rpcError('invalid_argument', 'tab_id or target_id is required');
}

export function debuggeeKey(debuggee = {}) {
    if (debuggee.tabId != null) return `tab:${debuggee.tabId}`;
    if (debuggee.targetId) return `target:${debuggee.targetId}`;
    return 'unknown';
}

export function rpcError(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
}
