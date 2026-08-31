import { describe, expect, it, vi } from 'vitest';
import {
    buildFetchExpression,
    buildIdentityProbeExpression,
    CDPCaptureController,
    headersToMap,
    mergeHeaderMaps,
    normalizeURL,
    summarizeRequests,
} from '../js/background/cdp-capture.js';
import { NativeBridge, normalizeRPCError } from '../js/background/native-bridge.js';
import { scheduleExtensionReload } from '../js/background/runtime-control.js';

function eventHook() {
    const listeners = [];
    return {
        addListener(fn) { listeners.push(fn); },
        emit(...args) { for (const listener of listeners) listener(...args); },
    };
}

describe('browser capture helpers', () => {
    it('normalizes bare domains and rejects non-http protocols', () => {
        expect(normalizeURL('github.com')).toBe('https://github.com/');
        expect(normalizeURL('http://example.com/a')).toBe('http://example.com/a');
        expect(() => normalizeURL('file:///tmp/a')).toThrow('Only http:// and https://');
    });

    it('preserves multi-value CDP headers', () => {
        expect(headersToMap({ 'set-cookie': 'a=1\nb=2', accept: 'application/json' })).toEqual({
            'set-cookie': ['a=1', 'b=2'],
            accept: ['application/json'],
        });
        expect(mergeHeaderMaps({ accept: ['*/*'] }, { cookie: ['sid=x'] })).toEqual({
            accept: ['*/*'],
            cookie: ['sid=x'],
        });
    });

    it('builds a credentialed, bounded fetch expression', () => {
        const expression = buildFetchExpression({
            url: 'https://example.com/api',
            method: 'POST',
            headers: { 'x-test': '1' },
            body: '{}',
            credentials: 'include',
            cache: 'default',
            maxBodyBytes: 1024,
            headersOnly: true,
        });
        expect(expression).toContain("credentials: options.credentials");
        expect(expression).toContain("cache: options.cache || 'default'");
        expect(expression).toContain('text.slice(0, limit)');
        expect(expression).toContain('options.headersOnly');
        expect(expression).toContain("response.body?.cancel()");
        expect(expression).toContain('body_omitted: true');
        expect(expression).toContain('https://example.com/api');
    });

    it('builds a native identity probe without rewriting browser globals', () => {
        const expression = buildIdentityProbeExpression();
        expect(expression).toContain('nav.webdriver');
        expect(expression).toContain('document.visibilityState');
        expect(expression).toContain('getHighEntropyValues');
        expect(expression).toContain('WEBGL_debug_renderer_info');
        expect(expression).not.toContain('defineProperty');
    });

    it('summarizes captured traffic', () => {
        expect(summarizeRequests([
            { url: 'https://a.test/1', response: { body: 'abc', status: 200 } },
            { url: 'https://b.test/2', response: { body: '', status: 0 }, error_text: 'failed' },
        ])).toEqual({
            requests: 2,
            domains: 2,
            response_bodies: 1,
            captured_body_bytes: 3,
            failed_requests: 1,
            ignored_cancellations: 0,
        });
        expect(summarizeRequests([
            {
                url: 'https://files.test/large',
                response: { body: '', status: 200 },
                canceled: true,
                intentional_cancellation: 'headers-only',
            },
            {
                url: 'https://files.test/broken',
                response: { body: '', status: 0 },
                error_text: 'net::ERR_CONNECTION_RESET',
            },
        ])).toMatchObject({ failed_requests: 1, ignored_cancellations: 1 });
    });
});

describe('CDP control attachment', () => {
    it('creates an inactive task-owned tab without navigation capture', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const created = [];
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                create(options, callback) {
                    created.push(options);
                    callback({ id: 77, windowId: 9, active: options.active, status: 'loading', pendingUrl: options.url });
                },
            },
            debugger: { onEvent, onDetach },
        };
        const controller = new CDPCaptureController({ chromeApi });

        await expect(controller.createTab()).resolves.toMatchObject({
            created: true,
            tab_id: 77,
            active: false,
        });
        expect(created).toEqual([{ url: 'about:blank', active: false }]);
        await expect(controller.createTab({ url: 'file:///tmp/private' })).rejects.toThrow('Only http:// and https://');
    });

    it('canonicalizes page target IDs and applies the real-browser context', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const attached = [];
        const detached = [];
        const commands = [];
        const chromeApi = {
            runtime: { lastError: null },
            debugger: {
                onEvent,
                onDetach,
                getTargets(callback) {
                    callback([{ id: 'page-target', tabId: 42, type: 'page' }]);
                },
                attach(debuggee, version, callback) {
                    attached.push({ debuggee, version });
                    callback();
                },
                detach(debuggee, callback) {
                    detached.push(debuggee);
                    callback();
                },
                sendCommand(debuggee, method, params, callback) {
                    commands.push({ debuggee, method, params });
                    callback({});
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi });

        const result = await controller.attachControl({ target_id: 'page-target' });
        expect(result.debuggee).toEqual({ tabId: 42 });
        expect(result.context_overrides).toEqual({
            'Page.setWebLifecycleState': true,
            'Emulation.setFocusEmulationEnabled': true,
            'Emulation.setIdleOverride': true,
            'Emulation.setAutomationOverride': true,
        });
        expect(attached).toEqual([{ debuggee: { tabId: 42 }, version: '1.3' }]);
        expect(commands).toHaveLength(4);

        await controller.detachControl({ target_id: 'page-target' });
        expect(detached).toEqual([{ tabId: 42 }]);
    });
});

describe('private URL navigation output', () => {
    it('keeps signed navigation URLs only in the sealed capture', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const emitted = [];
        const signedURL = 'https://files.example.test/start?signature=top-secret';
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                create(options, callback) { callback({ id: 91, windowId: 2, active: false, status: 'loading', url: options.url }); },
                get(tabId, callback) { callback({ id: tabId, url: signedURL, status: 'complete' }); },
            },
            debugger: {
                onEvent,
                onDetach,
                attach(debuggee, version, callback) { callback(); },
                detach(debuggee, callback) { callback(); },
                sendCommand(debuggee, method, params, callback) {
                    if (method === 'Page.navigate') {
                        const source = { tabId: debuggee.tabId };
                        onEvent.emit(source, 'Network.requestWillBeSent', {
                            requestId: 'private-navigation',
                            wallTime: Date.now() / 1000,
                            type: 'Document',
                            request: { method: 'GET', url: signedURL, headers: {} },
                            initiator: { type: 'other' },
                        });
                        onEvent.emit(source, 'Network.responseReceived', {
                            requestId: 'private-navigation',
                            type: 'Document',
                            response: { status: 200, headers: { 'set-cookie': 'private=value' } },
                        });
                        onEvent.emit(source, 'Network.loadingFinished', {
                            requestId: 'private-navigation',
                            encodedDataLength: 2,
                        });
                        onEvent.emit(source, 'Page.frameNavigated', { frame: { id: 'frame', url: signedURL } });
                        onEvent.emit(source, 'Page.loadEventFired', {});
                        callback({ frameId: 'frame', loaderId: 'loader' });
                    } else if (method === 'Network.getResponseBody') {
                        callback({ body: 'ok', base64Encoded: false });
                    } else callback({});
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi, emit: (message) => emitted.push(message) });
        const result = await controller.open({
            url: signedURL,
            keep_tab: true,
            redact_output: true,
            timeout_ms: 1000,
            idle_ms: 100,
            max_body_bytes: 1024,
        });

        expect(result).toMatchObject({
            sensitive_output_redacted: true,
            requested_url_redacted: true,
            final_url_redacted: true,
            requests: 1,
        });
        expect(result).not.toHaveProperty('requested_url');
        expect(result).not.toHaveProperty('final_url');
        expect(result).not.toHaveProperty('navigation');
        expect(JSON.stringify(result)).not.toContain('top-secret');
        const added = emitted.find((message) => message.action === 'add_many');
        expect(added.requests[0].url).toBe(signedURL);
    });

    it('omits a private URL from normalization errors', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const controller = new CDPCaptureController({
            chromeApi: { runtime: { lastError: null }, debugger: { onEvent, onDetach } },
        });
        const privateInvalidURL = 'http://[?signature=top-secret';
        let thrown;
        try {
            await controller.open({ url: privateInvalidURL, redact_output: true });
        } catch (error) {
            thrown = error;
        }
        expect(thrown?.code).toBe('invalid_url');
        expect(thrown?.message).toContain('sensitive details were omitted');
        expect(thrown?.message).not.toContain('top-secret');
    });
});

describe('captured page actions', () => {
    it('evaluates in one tab while capturing and sealing its network session', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const commands = [];
        const emitted = [];
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                get(tabId, callback) { callback({ id: tabId, url: 'https://example.test/app', status: 'complete' }); },
            },
            debugger: {
                onEvent,
                onDetach,
                attach(debuggee, version, callback) { callback(); },
                detach(debuggee, callback) { callback(); },
                sendCommand(debuggee, method, params, callback) {
                    commands.push({ debuggee, method, params });
                    if (method === 'Runtime.evaluate') {
                        callback(params.expression === 'large-result'
                            ? { result: { type: 'string', value: 'x'.repeat(4096) } }
                            : { result: { type: 'object', value: { clicked: true } } });
                    } else callback({});
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi, emit: (message) => emitted.push(message) });
        const result = await controller.action({
            tab_id: 42,
            expression: 'document.querySelector("button")?.click()',
            timeout_ms: 1000,
            idle_ms: 100,
            settle_ms: 0,
            max_body_bytes: 1024,
            user_gesture: true,
        });

        const evaluation = commands.find((command) => command.method === 'Runtime.evaluate');
        expect(evaluation.params.userGesture).toBe(true);
        expect(result).toMatchObject({ tab_id: 42, load_state: 'network-idle', requests: 0, evaluation_truncated: false });
        expect(emitted.map((message) => message.action)).toEqual(['session_begin', 'session_end']);
        expect(controller.sessions.size).toBe(0);

        const large = await controller.action({
            tab_id: 42,
            expression: 'large-result',
            timeout_ms: 1000,
            idle_ms: 100,
            settle_ms: 0,
            max_result_bytes: 128,
        });
        expect(large.evaluation_truncated).toBe(true);
        expect(large.evaluation_bytes).toBeGreaterThan(4096);
        expect(large.evaluation.result).toEqual({ type: 'string' });
        expect(JSON.stringify(large.evaluation).length).toBeLessThan(128);
        expect(controller.sessions.size).toBe(0);
    });

    it('keeps a bounded observation window for delayed action callbacks', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const emitted = [];
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                get(tabId, callback) { callback({ id: tabId, url: 'https://example.test/challenge', status: 'complete' }); },
            },
            debugger: {
                onEvent,
                onDetach,
                attach(debuggee, version, callback) { callback(); },
                detach(debuggee, callback) { callback(); },
                sendCommand(debuggee, method, params, callback) {
                    if (method === 'Runtime.evaluate') {
                        callback({ result: { type: 'boolean', value: true } });
                    } else if (method === 'Network.getResponseBody') {
                        callback({ body: '{"ok":true}', base64Encoded: false });
                    } else callback({});
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi, emit: (message) => emitted.push(message) });
        const action = controller.action({
            tab_id: 42,
            expression: 'document.querySelector("button")?.click()',
            timeout_ms: 1000,
            idle_ms: 100,
            settle_ms: 250,
            max_body_bytes: 1024,
        });

        // This starts after the ordinary 100ms idle interval. Without the
        // observation gate the action would already have sealed an empty
        // capture before this browser-managed callback runs.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const source = { tabId: 42 };
        onEvent.emit(source, 'Network.requestWillBeSent', {
            requestId: 'delayed-request',
            wallTime: Date.now() / 1000,
            type: 'Fetch',
            request: {
                method: 'POST',
                url: 'https://example.test/challenge/verify',
                headers: { 'content-type': 'application/json' },
                postData: '{}',
            },
            initiator: { type: 'script' },
        });
        onEvent.emit(source, 'Network.responseReceived', {
            requestId: 'delayed-request',
            type: 'Fetch',
            response: { status: 200, headers: { 'content-type': 'application/json' } },
        });
        onEvent.emit(source, 'Network.loadingFinished', {
            requestId: 'delayed-request',
            encodedDataLength: 11,
        });

        const result = await action;
        expect(result).toMatchObject({
            tab_id: 42,
            load_state: 'network-idle',
            requests: 1,
            response_bodies: 1,
            settle_ms: 250,
        });
        const added = emitted.find((message) => message.action === 'add_many');
        expect(added.requests[0]).toMatchObject({
            method: 'POST',
            url: 'https://example.test/challenge/verify',
            response: { status: 200, body: '{"ok":true}' },
        });
        expect(controller.sessions.size).toBe(0);
    });

    it('does not count a browser-managed attachment handoff as a failed action request', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const emitted = [];
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                get(tabId, callback) { callback({ id: tabId, url: 'https://app.example.test/download', status: 'complete' }); },
            },
            debugger: {
                onEvent,
                onDetach,
                attach(debuggee, version, callback) { callback(); },
                detach(debuggee, callback) { callback(); },
                sendCommand(debuggee, method, params, callback) {
                    if (method !== 'Runtime.evaluate') {
                        callback({});
                        return;
                    }
                    const source = { tabId: debuggee.tabId };
                    onEvent.emit(source, 'Network.requestWillBeSent', {
                        requestId: 'download-request',
                        wallTime: Date.now() / 1000,
                        type: 'Document',
                        request: { method: 'GET', url: 'https://files.example.test/artifact.ipa?secret=hidden', headers: {} },
                        initiator: { type: 'script' },
                    });
                    onEvent.emit(source, 'Network.responseReceived', {
                        requestId: 'download-request',
                        type: 'Document',
                        response: {
                            status: 200,
                            headers: {},
                        },
                    });
                    onEvent.emit(source, 'Page.downloadWillBegin', {
                        frameId: 'frame',
                        guid: 'download-guid',
                        url: 'https://files.example.test/artifact.ipa?secret=hidden',
                        suggestedFilename: 'artifact.ipa',
                    });
                    onEvent.emit(source, 'Network.loadingFailed', {
                        requestId: 'download-request',
                        canceled: true,
                        errorText: 'net::ERR_ABORTED',
                    });
                    callback({ result: { type: 'object', value: { clicked: true } } });
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi, emit: (message) => emitted.push(message) });
        const result = await controller.action({
            tab_id: 42,
            expression: 'document.querySelector("button")?.click()',
            timeout_ms: 1000,
            idle_ms: 100,
            settle_ms: 0,
            max_body_bytes: 1024,
        });

        expect(result).toMatchObject({ failed_requests: 0, ignored_cancellations: 1 });
        const added = emitted.find((message) => message.action === 'add_many');
        expect(added.requests[0]).toMatchObject({
            response: { status: 200 },
            canceled: true,
            intentional_cancellation: 'browser-download',
            start_ordinal: 1,
            response_ordinal: 2,
            completion_ordinal: 4,
        });
        expect(added.requests[0]).not.toHaveProperty('error_text');
    });
});

describe('credentialed browser fetch', () => {
    it('treats a headers-only body cancel as intentional and redacts private-file output', async () => {
        const onEvent = eventHook();
        const onDetach = eventHook();
        const emitted = [];
        const signedURL = 'https://files.example.test/large.ipa?signature=top-secret';
        const chromeApi = {
            runtime: { lastError: null },
            tabs: {
                get(tabId, callback) { callback({ id: tabId, url: 'https://files.example.test/app', status: 'complete' }); },
            },
            debugger: {
                onEvent,
                onDetach,
                attach(debuggee, version, callback) { callback(); },
                detach(debuggee, callback) { callback(); },
                sendCommand(debuggee, method, params, callback) {
                    if (method !== 'Runtime.evaluate') {
                        callback({});
                        return;
                    }
                    const source = { tabId: debuggee.tabId };
                    onEvent.emit(source, 'Network.requestWillBeSent', {
                        requestId: 'headers-only-request',
                        wallTime: Date.now() / 1000,
                        type: 'Fetch',
                        request: { method: 'GET', url: signedURL, headers: { accept: '*/*' } },
                        initiator: { type: 'script' },
                    });
                    onEvent.emit(source, 'Network.responseReceived', {
                        requestId: 'headers-only-request',
                        type: 'Fetch',
                        response: {
                            status: 200,
                            headers: { 'content-length': '999999', 'set-cookie': 'private=value' },
                        },
                    });
                    onEvent.emit(source, 'Network.loadingFailed', {
                        requestId: 'headers-only-request',
                        canceled: true,
                        errorText: 'net::ERR_ABORTED',
                    });
                    callback({
                        result: {
                            type: 'object',
                            value: {
                                ok: true,
                                status: 200,
                                url: signedURL,
                                redirected: false,
                                type: 'basic',
                                headers: { 'set-cookie': 'private=value' },
                                body: '',
                                body_bytes: 0,
                                body_declared_bytes: 999999,
                                body_truncated: true,
                                body_omitted: true,
                            },
                        },
                    });
                },
            },
        };
        const controller = new CDPCaptureController({ chromeApi, emit: (message) => emitted.push(message) });
        const result = await controller.fetch({
            tab_id: 42,
            url: signedURL,
            method: 'GET',
            headers_only: true,
            redact_output: true,
            timeout_ms: 1000,
            idle_ms: 100,
            max_body_bytes: 1024,
        });

        expect(result).toMatchObject({
            sensitive_output_redacted: true,
            request: { method: 'GET', url_redacted: true },
            response: {
                status: 200,
                body_declared_bytes: 999999,
                body_omitted: true,
                url_redacted: true,
                headers_omitted: true,
            },
            failed_requests: 0,
            ignored_cancellations: 1,
        });
        expect(result).not.toHaveProperty('requested_url');
        expect(result.request).not.toHaveProperty('url');
        expect(result.response).not.toHaveProperty('url');
        expect(result.response).not.toHaveProperty('headers');
        expect(result.response).not.toHaveProperty('body');

        const added = emitted.find((message) => message.action === 'add_many');
        expect(added.requests[0]).toMatchObject({
            url: signedURL,
            response: { status: 200 },
            canceled: true,
            intentional_cancellation: 'headers-only',
            start_ordinal: 1,
            response_ordinal: 2,
            completion_ordinal: 3,
        });
        expect(added.requests[0]).not.toHaveProperty('error_text');
    });
});

describe('native bridge', () => {
    it('schedules a self-reload after the RPC response can be posted', () => {
        const reload = vi.fn();
        let pending;
        const result = scheduleExtensionReload({
            chromeApi: { runtime: { reload } },
            schedule: (callback, delay) => { pending = { callback, delay }; },
        });
        expect(result).toEqual({ reloading: true, delay_ms: 150 });
        expect(reload).not.toHaveBeenCalled();
        expect(pending.delay).toBe(150);
        pending.callback();
        expect(reload).toHaveBeenCalledOnce();
    });

    it('routes host RPCs and returns structured results', async () => {
        const onMessage = eventHook();
        const onDisconnect = eventHook();
        const sent = [];
        const port = {
            onMessage,
            onDisconnect,
            postMessage(message) { sent.push(message); },
            disconnect: vi.fn(),
        };
        const chromeApi = {
            runtime: {
                id: 'a'.repeat(32),
                getManifest: () => ({ version: '9.9.9' }),
                connectNative: () => port,
                lastError: null,
            },
        };
        const bridge = new NativeBridge({
            chromeApi,
            onRPC: async (method, params) => ({ method, params, ok: true }),
        });
        bridge.start();
        expect(sent[0]).toMatchObject({ action: 'hello', extension_version: '9.9.9' });

        onMessage.emit({ action: 'rpc', id: 'rpc_1', method: 'browser.status', params: { compact: true } });
        await Promise.resolve();
        await Promise.resolve();
        expect(sent.at(-1)).toEqual({
            action: 'rpc_result',
            id: 'rpc_1',
            result: { method: 'browser.status', params: { compact: true }, ok: true },
        });
        bridge.stop();
    });

    it('normalizes thrown errors for RPC transport', () => {
        const error = Object.assign(new Error('no debugger'), { code: 'debugger_attach_failed', data: { tab: 7 } });
        expect(normalizeRPCError(error)).toEqual({
            code: 'debugger_attach_failed',
            message: 'no debugger',
            data: { tab: 7 },
        });
    });

    it('keeps ambient resume control ahead of a bounded reconnect backlog', () => {
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.enqueue({ action: 'ambient_resume', session_id: 'ambient-live' });
        for (let index = 0; index < 250; index += 1) {
            bridge.enqueue({ action: 'add', request: { id: `request-${index}` } });
        }
        expect(bridge.queue).toHaveLength(200);
        expect(bridge.queue[0]).toEqual({ action: 'ambient_resume', session_id: 'ambient-live' });
        expect(bridge.queue.at(-1).request.id).toBe('request-249');
    });

    it('runs reconnect recovery before flushing queued requests', () => {
        const sent = [];
        const port = {
            onMessage: eventHook(),
            onDisconnect: eventHook(),
            postMessage(message) { sent.push(message); },
        };
        const chromeApi = {
            runtime: {
                id: 'a'.repeat(32),
                getManifest: () => ({ version: '1.0.0' }),
                connectNative: () => port,
                lastError: null,
            },
        };
        let bridge;
        bridge = new NativeBridge({
            chromeApi,
            onConnected: () => bridge.send({ action: 'ambient_resume', session_id: 'ambient-live' }),
        });
        bridge.enqueue({ action: 'add', request: { id: 'queued-request' } });
        bridge.start();

        expect(sent.map((message) => message.action)).toEqual(['hello', 'ambient_resume', 'add']);
        bridge.stop();
    });
});
