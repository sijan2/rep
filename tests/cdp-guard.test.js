import { describe, expect, it, vi } from 'vitest';
import { CDPCaptureController } from '../js/background/cdp-capture.js';

const OWNER = 'workspace/task';

function fixture() {
    const tabs = new Map([[4, { id: 4, windowId: 1, active: false, status: 'complete', url: 'https://www.reddit.com/r/test/' }]]);
    const chromeApi = {
        runtime: { lastError: null, id: 'ext-id', getURL: (path) => `chrome-extension://ext-id/${path}` },
        storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }, local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
        tabs: {
            onRemoved: { addListener() {} },
            onUpdated: { addListener() {}, removeListener() {} },
            create: vi.fn((options, done) => done({ id: 100, windowId: 1, active: false, status: 'complete', url: options.url })),
            get: vi.fn((id, done) => done(tabs.get(id))),
            remove: vi.fn((id, done) => done()),
            query: vi.fn((_query, done) => done([...tabs.values()])),
        },
        debugger: {
            onDetach: { addListener() {} },
            onEvent: { addListener() {} },
            getTargets: vi.fn((done) => done([])),
            attach: vi.fn((_target, _version, done) => done()),
            detach: vi.fn((_target, done) => done()),
            sendCommand: vi.fn((_target, _method, _params, done) => done({})),
        },
    };
    return { chromeApi };
}

describe('browser.cdp guards', () => {
    it('refuses raw target control on both CDP paths', async () => {
        const controller = new CDPCaptureController(fixture());
        for (const method of ['Target.attachToTarget', 'Target.createTarget', 'Target.setAutoAttach', 'Target.exposeDevToolsProtocol']) {
            await expect(controller.sendCDP({ tab_id: 4, method, command_params: {} })).rejects.toMatchObject({ code: 'method_refused', data: { method } });
            await expect(controller.sendCDP({ tab_id: 4, owner: OWNER, lease_id: 'lease', method, command_params: {} })).rejects.toMatchObject({ code: 'method_refused' });
        }
        await expect(controller.sendCDP({ tab_id: 4, method: 'Target.getTargets' })).resolves.toMatchObject({ method: 'Target.getTargets' });
    });

    it('never navigates a controlled tab into the extension itself', async () => {
        const controller = new CDPCaptureController(fixture());
        await expect(controller.sendCDP({ tab_id: 4, method: 'Page.navigate', command_params: { url: 'chrome-extension://ext-id/panel.html' } })).rejects.toMatchObject({ code: 'own_page_refused' });
        await expect(controller.navigate({ tab_id: 4, url: 'chrome-extension://ext-id/panel.html' })).rejects.toMatchObject({ code: 'own_page_refused' });
    });

    it('drives every site without a consent step', async () => {
        const controller = new CDPCaptureController(fixture());
        await expect(controller.attachControl({ tab_id: 4 })).resolves.toMatchObject({ attached: true });
        await expect(controller.sendCDP({ tab_id: 4, method: 'Page.navigate', command_params: { url: 'https://x.com/home' } })).resolves.toMatchObject({ method: 'Page.navigate' });
        await expect(controller.createTab({ url: 'https://www.reddit.com/r/test/' })).resolves.toMatchObject({ created: true });
    });
});
