import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../js/core/state.js';
import {
    buildTrafficMetadata,
    classifySelectedTraffic,
    renderClassification,
    setupJevClassification,
} from '../js/features/jev/index.js';

function selectedRequest() {
    return {
        request: {
            method: 'POST',
            url: 'https://user:password@example.test/api/users/123?token=private#secret',
            headers: [{ name: 'Authorization', value: 'private-request-header' }],
            postData: { text: 'private-request-body' },
        },
        resourceType: 'Fetch',
        responseStatus: 200,
        responseHeaders: [
            { name: 'Content-Type', value: 'application/json; boundary=private-boundary' },
            { name: 'Set-Cookie', value: 'private-cookie' },
        ],
        responseBody: 'private-response-body',
    };
}

function eventHook() {
    const listeners = new Set();
    return {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
        emit(message) { for (const fn of [...listeners]) fn(message); },
        size() { return listeners.size; },
    };
}

function bridge() {
    const port = {
        onMessage: eventHook(),
        onDisconnect: eventHook(),
        postMessage: vi.fn(),
        disconnect: vi.fn(),
    };
    return { port, chromeApi: { runtime: { connect: vi.fn(() => port) } } };
}

const result = {
    category: 'api', confidence: 0.81, needs_review: false,
    probabilities: { api: 0.88, document: 0.04, static: 0.03, analytics: 0.02, other: 0.03 },
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    state.selectedRequest = null;
});

describe('Jev metadata boundary', () => {
    it('sends only minimized selected-request metadata without secrets or response data', () => {
        const metadata = buildTrafficMetadata(selectedRequest());
        expect(metadata).toEqual({
            method: 'POST', url: 'https://example.test/api/users/:redacted',
            resource_type: 'fetch', status: 200, content_type: 'application/json',
        });
        expect(JSON.stringify(metadata)).not.toMatch(/private|password|token|secret/);
    });

    it('redacts token values and email, encoded, and long path segments', () => {
        const selected = selectedRequest();
        selected.request.url = 'https://example.test/token/secretvalue/person%40mail.test/abcdefghijklmnopqrstuvwxyzaaaaaaaa/asset.js';
        expect(buildTrafficMetadata(selected).url).toBe('https://example.test/token/:redacted/:redacted/:redacted/asset.js');
    });

    it('validates request presence and protocol before contacting the bridge', async () => {
        const { chromeApi } = bridge();
        await expect(classifySelectedTraffic(null, { chromeApi })).rejects.toThrow('Select a captured request');
        const selected = selectedRequest();
        selected.request.url = 'data:text/plain,secret';
        await expect(classifySelectedTraffic(selected, { chromeApi })).rejects.toThrow('HTTP and HTTPS');
        expect(chromeApi.runtime.connect).not.toHaveBeenCalled();
    });
});

describe('Jev native bridge', () => {
    beforeEach(() => vi.useFakeTimers());

    it('ignores uncorrelated acknowledgements and other responses, then cleans up after the matching response', async () => {
        const { port, chromeApi } = bridge();
        const pending = classifySelectedTraffic(selectedRequest(), { chromeApi });
        const settled = vi.fn();
        pending.then(settled);
        const request = port.postMessage.mock.calls[0][0];
        expect(request).toMatchObject({ action: 'jev_classify', params: buildTrafficMetadata(selectedRequest()) });
        port.onMessage.emit({ action: 'jev_classify', success: true, queued: false });
        port.onMessage.emit({ action: 'jev_classify', id: 'someone-else', success: true, result });
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        port.onMessage.emit({ action: 'jev_classify', id: request.id, success: true, result });
        await expect(pending).resolves.toEqual(result);
        expect(port.disconnect).toHaveBeenCalledOnce();
        expect(port.onMessage.size()).toBe(0);
        expect(port.onDisconnect.size()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('times out and releases listeners even when the host never replies', async () => {
        const { port, chromeApi } = bridge();
        const pending = classifySelectedTraffic(selectedRequest(), { chromeApi });
        const rejection = expect(pending).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(35000);
        await rejection;
        expect(port.disconnect).toHaveBeenCalledOnce();
        expect(port.onMessage.size()).toBe(0);
    });

    it('rejects a disconnected port and clears the timeout', async () => {
        const { port, chromeApi } = bridge();
        const pending = classifySelectedTraffic(selectedRequest(), { chromeApi });
        port.onDisconnect.emit();
        await expect(pending).rejects.toThrow('disconnected');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns a native error without treating it as successful classification', async () => {
        const { port, chromeApi } = bridge();
        const pending = classifySelectedTraffic(selectedRequest(), { chromeApi });
        const { id } = port.postMessage.mock.calls[0][0];
        port.onMessage.emit({ action: 'jev_classify', id, success: false, error: 'Configure Jev first.' });
        await expect(pending).rejects.toThrow('Configure Jev first.');
    });

    it.each([
        ['unknown category', { category: '<img src=x>' }],
        ['invalid confidence', { confidence: 2 }],
        ['missing probabilities', { probabilities: undefined }],
        ['array probabilities', { probabilities: [0.88, 0.04, 0.03, 0.02, 0.03] }],
        ['missing category probability', { probabilities: { api: 0.88, document: 0.04, static: 0.03, analytics: 0.05 } }],
        ['extra category probability', { probabilities: { ...result.probabilities, unknown: 0 } }],
        ['nonfinite probability', { probabilities: { ...result.probabilities, api: NaN } }],
        ['nonnumeric probability', { probabilities: { ...result.probabilities, api: '0.88' } }],
        ['negative probability', { probabilities: { ...result.probabilities, other: -0.03 } }],
        ['oversized probability', { probabilities: { ...result.probabilities, api: 1.1 } }],
        ['unnormalized distribution', { probabilities: { ...result.probabilities, api: 0.5 } }],
        ['selected category is not a maximum', { category: 'document' }],
        ['missing review flag', { needs_review: undefined }],
        ['nonboolean review flag', { needs_review: 'false' }],
    ])('rejects %s and releases the port', async (_, invalid) => {
        const { port, chromeApi } = bridge();
        const pending = classifySelectedTraffic(selectedRequest(), { chromeApi });
        const { id } = port.postMessage.mock.calls[0][0];
        port.onMessage.emit({ action: 'jev_classify', id, success: true, result: { ...result, ...invalid } });
        await expect(pending).rejects.toThrow('invalid Jev classification');
        expect(port.disconnect).toHaveBeenCalledOnce();
        expect(port.onMessage.size()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports missing native messaging without leaking raw exception details', async () => {
        const chromeApi = { runtime: { connect() { throw new Error('private-key-value'); } } };
        await expect(classifySelectedTraffic(selectedRequest(), { chromeApi })).rejects.toThrow('Unable to connect');
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Jev classification UI', () => {
    it('keeps provider confidence separate from category probability and flags low confidence', () => {
        const container = document.createElement('div');
        renderClassification(container, { ...result, confidence: 0.79, needs_review: false });
        expect(container.textContent).toContain('Category: api');
        expect(container.textContent).toContain('Confidence: 79.0%');
        expect(container.textContent).toContain('api: 88.0%');
        expect(container.textContent).toContain('Needs review: Yes');
    });

    it('classifies the captured selection and renders native errors as text', async () => {
        document.body.innerHTML = '<button id="jev-classify-btn"></button><div id="ai-menu-dropdown" class="show"></div><div id="jev-classification-modal"><p id="jev-classification-request"></p><div id="jev-classification-content"></div></div>';
        const { port, chromeApi } = bridge();
        vi.stubGlobal('chrome', chromeApi);
        state.selectedRequest = selectedRequest();
        setupJevClassification();
        const button = document.getElementById('jev-classify-btn');
        button.click();
        expect(button.disabled).toBe(true);
        expect(document.getElementById('jev-classification-request').textContent).toBe('POST https://example.test/api/users/:redacted');
        const { id } = port.postMessage.mock.calls[0][0];
        port.onMessage.emit({ action: 'jev_classify', id, success: false, error: '<img src=x onerror="alert(1)">' });
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        const content = document.getElementById('jev-classification-content');
        expect(content.textContent).toBe('<img src=x onerror="alert(1)">');
        expect(content.querySelector('img')).toBeNull();
    });
});
