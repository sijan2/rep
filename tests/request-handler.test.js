// Tests for Send: edits to headers fetch() cannot send must refuse instead of silently diverging
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSendRequest } from '../js/network/handler.js';
import { elements } from '../js/ui/main-ui.js';
import { state } from '../js/core/state.js';

const el = (tag) => document.createElement(tag);

function capturedRequest(headers) {
  return {
    request: {
      method: 'POST',
      url: 'https://example.com/api/items',
      httpVersion: 'HTTP/1.1',
      headers,
      postData: { text: '{"id":1}' }
    }
  };
}

const CAPTURED_HEADERS = [
  { name: 'Host', value: 'example.com' },
  { name: 'Cookie', value: 'session=original' },
  { name: 'Referer', value: 'https://example.com/page' },
  { name: 'Content-Type', value: 'application/json' }
];

function editorText(lines) {
  return ['POST /api/items HTTP/1.1', 'Host: example.com', ...lines, 'Content-Type: application/json', '', '{"id":1}'].join('\n');
}

describe('handleSendRequest and browser-controlled headers', () => {
  let fetchMock;

  beforeEach(() => {
    // The JSON response view toggles the panel's warning bar (#res-view-json .json-warning-bar)
    document.body.innerHTML = '<div id="res-view-json"><div class="json-warning-bar"></div></div>';
    elements.rawRequestInput = { innerText: '' };
    elements.useHttpsCheckbox = { checked: true };
    elements.resStatus = el('span');
    elements.resTime = el('span');
    elements.resSize = el('span');
    elements.rawResponseDisplay = el('pre');
    elements.rawResponseText = el('pre');
    elements.hexResponseDisplay = el('pre');
    elements.jsonResponseDisplay = el('div');
    elements.diffToggle = el('div');
    elements.showDiffCheckbox = { checked: false };

    state.requests = [];
    state.selectedRequest = null;
    state.regularRequestBaseline = null;
    state.currentResponse = null;

    fetchMock = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers([['content-type', 'text/plain']]),
      text: async () => 'ok'
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses an edited Cookie and explains that the browser sends its own jar', async () => {
    state.selectedRequest = capturedRequest(CAPTURED_HEADERS);
    elements.rawRequestInput.innerText = editorText(['Cookie: session=edited', 'Referer: https://example.com/page']);

    await handleSendRequest();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.resStatus.textContent).toBe('Not sent');
    expect(elements.resStatus.className).toContain('status-4xx');
    const text = elements.rawResponseDisplay.textContent;
    expect(text).toContain('Cookie');
    expect(text).toContain('changed');
    expect(text).toContain('session=original');
    expect(text).toMatch(/cookie jar/i);
    expect(elements.rawResponseDisplay.style.display).toBe('block');
  });

  it('refuses a removed Cookie line, because the jar is still sent', async () => {
    state.selectedRequest = capturedRequest(CAPTURED_HEADERS);
    elements.rawRequestInput.innerText = editorText(['Referer: https://example.com/page']);

    await handleSendRequest();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.rawResponseDisplay.textContent).toContain('removed');
  });

  it('refuses Origin or Referer that differ from the capture', async () => {
    state.selectedRequest = capturedRequest(CAPTURED_HEADERS);
    elements.rawRequestInput.innerText = editorText([
      'Cookie: session=original',
      'Referer: https://attacker.example/',
      'Origin: https://attacker.example'
    ]);

    await handleSendRequest();

    expect(fetchMock).not.toHaveBeenCalled();
    const text = elements.rawResponseDisplay.textContent;
    expect(text).toContain('Referer');
    expect(text).toContain('Origin');
    expect(text).toContain('added');
    expect(text).toContain('chrome-extension://');
  });

  it('refuses a hand-written Cookie when no request was captured', async () => {
    state.selectedRequest = null;
    elements.rawRequestInput.innerText = editorText(['Cookie: session=typed']);

    await handleSendRequest();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.resStatus.textContent).toBe('Not sent');
  });

  it('sends when the browser-controlled headers match the capture, without forwarding them to fetch()', async () => {
    state.selectedRequest = capturedRequest(CAPTURED_HEADERS);
    elements.rawRequestInput.innerText = editorText(['cookie:  session=original', 'Referer: https://example.com/page']);

    await handleSendRequest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/api/items');
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"id":1}');
    expect(options.credentials).toBe('include');
    expect(Object.keys(options.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(options.headers).map((k) => k.toLowerCase())).not.toContain('referer');
    expect(elements.resStatus.textContent).toBe('200 OK');
    expect(state.currentResponse).toContain('ok');
  });

  it('sends a request that never had browser-controlled headers', async () => {
    state.selectedRequest = capturedRequest([{ name: 'Host', value: 'example.com' }]);
    elements.rawRequestInput.innerText = editorText([]);

    await handleSendRequest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elements.resStatus.textContent).toBe('200 OK');
  });
});
