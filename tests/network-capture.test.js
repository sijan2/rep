import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupNetworkListener } from '../js/network/capture.js';

function eventHook() {
    const listeners = [];
    return {
        addListener: vi.fn((listener) => listeners.push(listener)),
        emit: (...args) => listeners.forEach((listener) => listener(...args)),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DevTools network capture', () => {
    it.each([undefined, {}, { devtools: {} }, { devtools: { network: {} } }])(
        'does not throw when the panel has no DevTools network API (%j)', (chromeApi) => {
            vi.stubGlobal('chrome', chromeApi);
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(setupNetworkListener(vi.fn())).toBe(false);
        },
    );

    it('does not leave a partial listener when only navigation is exposed', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const onNavigated = eventHook();
        expect(setupNetworkListener(vi.fn(), { devtools: { network: { onNavigated } } })).toBe(false);
        expect(onNavigated.addListener).not.toHaveBeenCalled();
    });

    it('still captures response bodies and tracks the inspected tab across navigation', () => {
        const onNavigated = eventHook();
        const onRequestFinished = eventHook();
        const captured = vi.fn();
        const chromeApi = { devtools: {
            inspectedWindow: {
                tabId: 7,
                eval: (_expression, callback) => callback('https://example.com/first', false),
            },
            network: { onNavigated, onRequestFinished },
        } };
        const request = () => ({
            request: { url: 'https://example.com/api/data', headers: [] },
            response: { status: 200, statusText: 'OK', headers: [] },
            getContent: (callback) => callback('{"ok":true}', ''),
        });

        expect(setupNetworkListener(captured, chromeApi)).toBe(true);
        onRequestFinished.emit(request());
        expect(captured).toHaveBeenLastCalledWith(expect.objectContaining({
            tabId: 7, pageUrl: 'https://example.com/first', responseBody: '{"ok":true}', responseStatus: 200,
        }));
        onNavigated.emit('https://example.com/second');
        onRequestFinished.emit(request());
        expect(captured).toHaveBeenLastCalledWith(expect.objectContaining({ pageUrl: 'https://example.com/second' }));
    });
});
