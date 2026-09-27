import { describe, expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../js/background/browser-runtime.js';
import { CDPCaptureController } from '../js/background/cdp-capture.js';

// A fake debugger whose Page.navigate schedules the lifecycle events a real
// navigation would emit for the root frame.
function fixture({ lifecycle = ['DOMContentLoaded', 'load', 'networkIdle'], navigateResult = { frameId: 'root', loaderId: 'L2' }, pageState = { url: 'https://example.com/next', title: 'Next', ready_state: 'complete', http_status: 200 } } = {}) {
    const eventListeners = [];
    const detachListeners = [];
    const calls = [];
    const chromeApi = {
        runtime: { lastError: null },
        tabs: {
            create: vi.fn((options, done) => done({ id: 42, windowId: 1, active: false, status: 'loading', url: options.url })),
            remove: vi.fn((_id, done) => done()),
        },
        debugger: {
            onDetach: { addListener(fn) { detachListeners.push(fn); } },
            onEvent: { addListener(fn) { eventListeners.push(fn); } },
            attach: vi.fn((_target, _version, done) => done()),
            detach: vi.fn((_target, done) => done()),
            sendCommand: vi.fn((target, method, params, done) => {
                calls.push(method);
                let result = {};
                if (method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'root', loaderId: 'L1', url: 'about:blank' } } };
                if (method === 'Page.navigate') {
                    result = navigateResult;
                    // Include an event from the previous document; it must be ignored.
                    setTimeout(() => {
                        for (const fn of eventListeners) fn({ tabId: target.tabId }, 'Page.lifecycleEvent', { frameId: 'root', loaderId: 'L1', name: 'load' });
                        for (const [index, name] of lifecycle.entries()) {
                            setTimeout(() => { for (const fn of eventListeners) fn({ tabId: target.tabId }, 'Page.lifecycleEvent', { frameId: 'root', loaderId: navigateResult.loaderId, name }); }, 2 * (index + 1));
                        }
                    }, 1);
                }
                if (method === 'Runtime.evaluate') {
                    result = params.awaitPromise ? { result: { value: { quiet: true, waited_ms: 200 } } } : { result: { value: pageState } };
                }
                if (method === 'Page.getLayoutMetrics') result = { cssLayoutViewport: { pageX: 0, pageY: 100 }, cssContentSize: { width: 800, height: 2400 } };
                if (method === 'Page.captureScreenshot') result = { data: 'aW1hZ2U=' };
                done(result);
            }),
        },
    };
    return { chromeApi, calls };
}

describe('lifecycle navigation', () => {
    it('waits for the new document load event, not an older document event', async () => {
        const { chromeApi, calls } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const result = await runtime.navigate({ tab_id: 7, url: 'https://example.com/next' });
        expect(result).toMatchObject({ tab_id: 7, reached: 'load', timed_out: false, url: 'https://example.com/next', title: 'Next', http_status: 200, loader_id: 'L2', same_document: false });
        expect(result.lifecycle.load_ms).toBeGreaterThanOrEqual(result.lifecycle.domcontentloaded_ms);
        expect(calls.indexOf('Page.setLifecycleEventsEnabled')).toBeLessThan(calls.indexOf('Page.navigate'));
        // A temporary attachment is released; no listener leaks after completion.
        expect(chromeApi.debugger.detach).toHaveBeenCalledOnce();
        expect(runtime.debuggerEventListeners.size).toBe(0);
    });

    it('reports a timeout with the reached stage and keeps the tab identity', async () => {
        const { chromeApi } = fixture({ lifecycle: ['DOMContentLoaded'] });
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com/slow', timeout_ms: 100 })).rejects.toMatchObject({
            code: 'navigation_timeout', data: { tab_id: 7, reached: 'domcontentloaded', timed_out: true },
        });
        expect(runtime.debuggerEventListeners.size).toBe(0);
    });

    it('supports settled readiness and network idle', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com/', wait: 'settled' })).resolves.toMatchObject({ reached: 'settled', dom_quiet: true });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com/', wait: 'networkidle' })).resolves.toMatchObject({ reached: 'networkidle' });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com/', wait: 'commit' })).resolves.toMatchObject({ reached: 'commit' });
    });

    it('treats a same-document navigation as committed', async () => {
        const { chromeApi } = fixture({ navigateResult: { frameId: 'root' } });
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com/#part' })).resolves.toMatchObject({ same_document: true, reached: 'commit', timed_out: false });
    });

    it('creates a background tab when none is given and closes it on hard failure', async () => {
        const { chromeApi } = fixture({ navigateResult: { frameId: 'root', loaderId: 'L2', errorText: 'net::ERR_NAME_NOT_RESOLVED' } });
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.navigate({ url: 'https://missing.invalid/' })).rejects.toMatchObject({ code: 'navigation_failed' });
        expect(chromeApi.tabs.create).toHaveBeenCalledOnce();
        expect(chromeApi.tabs.remove).toHaveBeenCalledWith(42, expect.any(Function));
        const ok = fixture();
        const created = await new BrowserRuntime({ chromeApi: ok.chromeApi }).navigate({ url: 'example.com' });
        expect(created).toMatchObject({ tab_id: 42, created_tab: true, requested_url: 'https://example.com/' });
        expect(ok.chromeApi.tabs.remove).not.toHaveBeenCalled();
    });

    it('rejects invalid input and tabs owned by captures or executors', async () => {
        const { chromeApi } = fixture();
        const runtime = new CDPCaptureController({ chromeApi });
        await expect(runtime.navigate({ tab_id: 7, url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'invalid_url' });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com', wait: 'forever' })).rejects.toMatchObject({ code: 'invalid_argument' });
        runtime.sessions.set(7, { attached: true });
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com' })).rejects.toMatchObject({ code: 'tab_busy' });
        runtime.sessions.clear();
        runtime.semantic.activeExecution = () => true;
        await expect(runtime.navigate({ tab_id: 7, url: 'https://example.com' })).rejects.toMatchObject({ code: 'tab_busy' });
        expect(chromeApi.debugger.attach).not.toHaveBeenCalled();
    });

    it('reuses an existing attachment without detaching it', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        await runtime.attachControl({ tab_id: 7 });
        await runtime.navigate({ tab_id: 7, url: 'https://example.com/next' });
        expect(chromeApi.debugger.attach).toHaveBeenCalledOnce();
        expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
    });
});

describe('page screenshots', () => {
    it('captures the viewport quickly and returns image data', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const result = await runtime.screenshot({ tab_id: 7, format: 'jpeg', quality: 70 });
        expect(result).toMatchObject({ tab_id: 7, format: 'jpeg', quality: 70, full_page: false, data: 'aW1hZ2U=' });
        const command = chromeApi.debugger.sendCommand.mock.calls.find(call => call[1] === 'Page.captureScreenshot')[2];
        expect(command).toMatchObject({ format: 'jpeg', quality: 70, optimizeForSpeed: true });
        expect(command.clip).toBeUndefined();
    });

    it('clips full pages and selected elements in page coordinates', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const full = await runtime.screenshot({ tab_id: 7, full_page: true });
        expect(full.clip).toEqual({ x: 0, y: 0, width: 800, height: 2400, scale: 1 });
        chromeApi.debugger.sendCommand.mockImplementation((_target, method, _params, done) => {
            if (method === 'Page.getLayoutMetrics') return done({ cssLayoutViewport: { pageX: 5, pageY: 100 } });
            if (method === 'Runtime.evaluate') return done({ result: { value: { x: 10, y: 20, width: 30, height: 40 } } });
            if (method === 'Page.captureScreenshot') return done({ data: 'eA==' });
            return done({});
        });
        const element = await runtime.screenshot({ tab_id: 7, selector: '#save' });
        expect(element.clip).toEqual({ x: 15, y: 120, width: 30, height: 40, scale: 1 });
        const command = chromeApi.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Page.captureScreenshot').at(-1)[2];
        expect(command.captureBeyondViewport).toBe(true);
    });

    it('reports missing elements and oversized images explicitly', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        chromeApi.debugger.sendCommand.mockImplementation((_target, method, _params, done) => {
            if (method === 'Runtime.evaluate') return done({ result: { value: null } });
            if (method === 'Page.captureScreenshot') return done({ data: 'x'.repeat(24 * 1024 * 1024 + 1) });
            return done({});
        });
        await expect(runtime.screenshot({ tab_id: 7, selector: '#missing' })).rejects.toMatchObject({ code: 'element_not_found' });
        await expect(runtime.screenshot({ tab_id: 7 })).rejects.toMatchObject({ code: 'screenshot_too_large' });
        await expect(runtime.screenshot({ tab_id: 7, format: 'gif' })).rejects.toMatchObject({ code: 'invalid_argument' });
        await expect(runtime.screenshot({ tab_id: 7, full_page: true, selector: '#x' })).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    it('serializes operations on one tab but not across tabs', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const order = [];
        const first = runtime.navigate({ tab_id: 7, url: 'https://example.com/a' }).then(() => order.push('navigate'));
        const second = runtime.screenshot({ tab_id: 7 }).then(() => order.push('screenshot'));
        await Promise.all([first, second]);
        expect(order).toEqual(['navigate', 'screenshot']);
    });
});
