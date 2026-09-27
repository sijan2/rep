import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { buildFetchExpression, CDPCaptureController } from '../js/background/cdp-capture.js';
import { NativeBridge } from '../js/background/native-bridge.js';
import { ResponseBodyCollector, nativeRequestMessages } from '../js/background/body-capture.js';

function hook() {
    const listeners = [];
    return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const listener of listeners) listener(...args); } };
}
const b64 = (value) => Buffer.from(value).toString('base64');
function captureHarness({ command, emit } = {}) {
    const events = hook();
    const detached = hook();
    const sent = [];
    const commands = [];
    const chromeApi = {
        runtime: { lastError: null },
        debugger: {
            onEvent: events, onDetach: detached,
            attach(target, version, callback) { callback(); },
            detach(target, callback) { callback(); },
            sendCommand(target, method, params, callback) {
                commands.push({ target, method, params });
                if (command?.({ target, method, params, callback, chromeApi }) === true) return;
                callback({});
            },
        },
    };
    const controller = new CDPCaptureController({ chromeApi, emit: (message) => { sent.push(message); return emit ? emit(message) : true; } });
    return {
        controller, sent, commands,
        async start(limit = 8 * 1024 * 1024, limits = {}) {
            return controller.startSession(7, { url: 'https://fixture.test', captureMode: 'navigate', maxBodyBytes: limit, limits, timeoutMs: 30000, idleMs: 100 });
        },
        records() {
            const records = [];
            const fragments = new Map();
            for (const message of sent) {
                if (message.action === 'add_many') records.push(...message.requests);
                if (message.action === 'request_chunk') {
                    const chunks = fragments.get(message.transfer_id) || [];
                    chunks.push(Buffer.from(message.data, 'base64')); fragments.set(message.transfer_id, chunks);
                }
                if (message.action === 'request_end') records.push(JSON.parse(Buffer.concat(fragments.get(message.transfer_id)).toString('utf8')));
            }
            return records;
        },
        event(method, params, child) { events.emit({ tabId: 7, ...(child ? { sessionId: child } : {}) }, method, params); },
        request(id = 'r1', child) {
            events.emit({ tabId: 7, ...(child ? { sessionId: child } : {}) }, 'Network.requestWillBeSent', {
                requestId: id, type: 'Fetch', request: { url: 'https://fixture.test/data', method: 'GET', headers: {} },
            });
        },
        response(id = 'r1', headers = {}, child) {
            events.emit({ tabId: 7, ...(child ? { sessionId: child } : {}) }, 'Network.responseReceived', {
                requestId: id, type: 'Fetch', response: { status: 200, headers: { 'content-type': 'application/json', ...headers } },
            });
        },
    };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('lossless response streaming', () => {
    it('assembles compressed chunks in byte order when stream setup returns after data events', async () => {
        let enableStream;
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.streamResourceContent') { enableStream = callback; return true; }
        } });
        const session = await h.start();
        h.request(); h.response('r1', { 'content-encoding': 'gzip' });
        const bytes = new TextEncoder().encode('{"emoji":"😀","ok":true}');
        h.event('Network.dataReceived', { requestId: 'r1', dataLength: bytes.length - 12, data: b64(bytes.slice(12)) });
        h.event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 10 });
        enableStream({ bufferedData: b64(bytes.slice(0, 12)) });
        await h.controller.finishSession(session, {});
        const [record] = h.records();
        expect(record.response.body).toBe('{"emoji":"😀","ok":true}');
        expect(record.response_body_capture).toMatchObject({ state: 'complete', source: 'cdp-stream', captured_bytes: bytes.length, observed_bytes: bytes.length });
        expect(h.commands.some(({ method }) => method === 'Network.getResponseBody')).toBe(false);
        expect(h.sent.at(-1)).toMatchObject({ action: 'session_end', expected_requests: 1 });
    });

    it.each([0, 12])('retrieves compressed/cache bodies with encodedDataLength %i via fallback', async (encodedDataLength) => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: '{"saved":true}', base64Encoded: false }); return true; }
        } });
        const session = await h.start();
        h.request(); h.response('r1', { 'content-encoding': 'br' });
        h.event('Network.loadingFinished', { requestId: 'r1', encodedDataLength });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ response: { body: '{"saved":true}' }, response_body_capture: { state: 'complete', source: 'cdp-buffer' } });
    });

    it('retains a binary prefix exactly and reports observed bytes when its limit is reached', () => {
        const body = new ResponseBodyCollector(4);
        body.appendBase64(b64(Uint8Array.from([0, 255, 240, 159, 152, 128, 5])));
        expect(body.materialize('application/octet-stream')).toMatchObject({ encoding: 'base64', body: b64(Uint8Array.from([0, 255, 240, 159])), captured: 4, truncated: true });
        expect(body.observed).toBe(7);
    });

    it('retains an incomplete UTF-8 boundary as base64 instead of dropping or replacing bytes', () => {
        const body = new ResponseBodyCollector(3);
        const bytes = new TextEncoder().encode('A😀');
        body.appendBase64(b64(bytes));
        expect(body.materialize('text/plain')).toMatchObject({ encoding: 'base64', body: b64(bytes.slice(0, 3)), captured: 3, truncated: true });
    });

    it('retains an unfinished stream prefix with an explicit capture deadline', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.streamResourceContent') { callback({ bufferedData: '' }); return true; }
        } });
        const session = await h.start();
        h.request(); h.response('r1', { 'content-type': 'text/event-stream' });
        await Promise.resolve();
        h.event('Network.dataReceived', { requestId: 'r1', dataLength: 10, data: b64('data: hi\n\n') });
        await h.controller.finishSession(session, { timedOut: true });
        expect(h.records()[0]).toMatchObject({
            network_state: 'pending', response: { body: 'data: hi\n\n' },
            response_body_capture: { state: 'partial', reason: 'capture_deadline', captured_bytes: 10 },
        });
    });

    it('distinguishes a network failure after streamed bytes from a complete response', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.streamResourceContent') { callback({ bufferedData: b64('{"open":') }); return true; }
        } });
        const session = await h.start(); h.request(); h.response();
        await Promise.resolve();
        h.event('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_CONNECTION_RESET' });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ network_state: 'failed', response: { body: '{"open":' }, response_body_capture: { state: 'partial', reason: 'network_failed' } });
    });

    it('waits for a body read that starts during finalization instead of detaching early', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { setTimeout(() => callback({ body: 'late-body' }), 120); return true; }
        } });
        const session = await h.start(); h.request(); h.response('r1', { 'content-type': 'text/plain' });
        setTimeout(() => h.event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 9 }), 20);
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ response: { body: 'late-body' }, response_body_capture: { state: 'complete' } });
    });

    it('freezes unresolved body reads at the deadline and ignores late mutations', async () => {
        vi.useFakeTimers();
        let resolveBody;
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { resolveBody = callback; return true; }
        } });
        const session = await h.start(); h.request(); h.response();
        h.event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 9 });
        const finished = h.controller.finishSession(session, {});
        await vi.advanceTimersByTimeAsync(5100); await finished;
        const before = JSON.stringify(session.requestList());
        resolveBody({ body: 'too-late' }); await Promise.resolve(); await Promise.resolve();
        expect(JSON.stringify(session.requestList())).toBe(before);
        expect(session.requestList()[0].response_body_capture).toMatchObject({ state: 'unavailable', reason: 'capture_deadline' });
    });

    it('captures responses that began before attachment without inventing their request method', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: 'attached-late' }); return true; }
        } });
        const session = await h.start();
        h.event('Network.responseReceived', { requestId: 'orphan', type: 'Fetch', response: { url: 'https://fixture.test/in-flight', status: 200, headers: {} } });
        h.event('Network.loadingFinished', { requestId: 'orphan', encodedDataLength: 13 });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ method: 'UNKNOWN', response: { body: 'attached-late' }, request_body_capture: { state: 'unavailable', reason: 'request_started_before_capture' } });
    });

    it('recovers omitted POST text while disclosing multipart file bytes unavailable', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getRequestPostData') { callback({ postData: 'field=value' }); return true; }
        } });
        const session = await h.start();
        h.event('Network.requestWillBeSent', { requestId: 'post', type: 'Fetch', request: {
            url: 'https://fixture.test/upload', method: 'POST', hasPostData: true,
            headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
        } });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ body: 'field=value', request_body_capture: { state: 'partial', reason: 'multipart_file_bytes_unavailable' } });
    });

    it('preserves a UTF-8 BOM so declared byte counts match the saved body', () => {
        const body = new ResponseBodyCollector(64);
        const bytes = Buffer.from('\ufeff{"ok":true}', 'utf8');
        body.appendBase64(b64(bytes));
        const result = body.materialize('application/json');
        expect(result.encoding).toBe('');
        expect(Buffer.from(result.body, 'utf8')).toEqual(bytes);
        expect(result.captured).toBe(Buffer.byteLength(result.body));
    });

    it.each([-1, 256 * 1024 * 1024 + 1, 1.5, 'not-a-size'])('rejects invalid body limit %s before opening a tab', async (max_body_bytes) => {
        const h = captureHarness();
        await expect(h.controller.open({ url: 'https://fixture.test/', max_body_bytes })).rejects.toMatchObject({ code: 'invalid_argument' });
        expect(h.sent).toEqual([]);
    });

    it('retains non-UTF8 text as exact source bytes', () => {
        const body = new ResponseBodyCollector(32);
        body.appendBase64(b64(Uint8Array.from([99, 97, 102, 233])));
        expect(body.materialize('text/plain; charset=iso-8859-1')).toMatchObject({ encoding: 'base64', body: 'Y2Fm6Q==', captured: 4, truncated: false });
    });

    it('retains a detached child frame prefix with its actual stopping reason', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.streamResourceContent') { callback({ bufferedData: b64('partial-frame') }); return true; }
        } });
        const session = await h.start();
        h.request('child-read', 'child-one'); h.response('child-read', { 'content-type': 'text/plain' }, 'child-one');
        await Promise.resolve();
        h.event('Target.detachedFromTarget', { sessionId: 'child-one' });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({
            network_state: 'pending', response: { body: 'partial-frame' },
            response_body_capture: { state: 'partial', reason: 'target_detached', captured_bytes: 13 },
        });
    });

    it('routes equal CDP request IDs in different child frames to their own body source', async () => {
        const h = captureHarness({ command({ target, method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: target.sessionId || 'root' }); return true; }
        } });
        const session = await h.start();
        for (const child of ['frame-a', 'frame-b']) {
            h.event('Target.attachedToTarget', { sessionId: child, targetInfo: { type: 'iframe' } });
            h.request('same', child); h.response('same', {}, child);
            h.event('Network.loadingFinished', { requestId: 'same', encodedDataLength: 7 }, child);
        }
        await h.controller.finishSession(session, {});
        expect(h.records().map((record) => record.response.body)).toEqual(['frame-a', 'frame-b']);
        expect(new Set(session.requestList().map((record) => record.id)).size).toBe(2);
        expect(h.commands.filter(({ method }) => method === 'Network.getResponseBody').map(({ params }) => params.requestId)).toEqual(['same', 'same']);
    });
});

describe('out-of-process frame documents', () => {
    // Chromium's split, as observed on Chrome for Testing 153: the parent
    // session reports requestWillBeSent and responseReceived for an OOPIF
    // document; the child session reports its data and loadingFinished under
    // the same raw request ID.
    it('completes the parent record and reads the body from the child session', async () => {
        const h = captureHarness({ command({ target, method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: target.sessionId === 'child' ? '<h1>frame</h1>' : '', base64Encoded: false }); return true; }
        } });
        const session = await h.start();
        h.event('Network.requestWillBeSent', { requestId: 'DOC', type: 'Document', request: { url: 'https://other.test/frame', method: 'GET', headers: {} } });
        h.event('Network.responseReceived', { requestId: 'DOC', type: 'Document', response: { status: 200, url: 'https://other.test/frame', headers: { 'content-type': 'text/html' } } });
        h.event('Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
        h.event('Network.dataReceived', { requestId: 'DOC', dataLength: 14 }, 'child');
        h.event('Network.loadingFinished', { requestId: 'DOC', encodedDataLength: 14 }, 'child');
        await h.controller.finishSession(session, {});
        const records = h.records();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ network_state: 'complete', response: { status: 200, body: '<h1>frame</h1>' }, response_body_capture: { state: 'complete' } });
        expect(session.blocking.size).toBe(0);
        const read = h.commands.find(({ method }) => method === 'Network.getResponseBody');
        expect(read.target).toEqual({ tabId: 7, sessionId: 'child' });
    });

    it('never routes a child request that has its own record, or a non-document', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.request('FETCH');
        h.event('Network.loadingFinished', { requestId: 'FETCH', encodedDataLength: 3 }, 'child');
        await Promise.resolve();
        expect(session.current.get('FETCH').network_state).toBe('pending');
        h.event('Network.requestWillBeSent', { requestId: 'DOC', type: 'Document', request: { url: 'https://other.test/frame', method: 'GET', headers: {} } });
        h.request('DOC', 'child');
        h.event('Network.loadingFinished', { requestId: 'DOC', encodedDataLength: 3 }, 'child');
        await Promise.resolve();
        expect(session.current.get('DOC').network_state).toBe('pending');
        expect(session.current.get('child:DOC').network_state).toBe('complete');
        await h.controller.finishSession(session, {});
    });
});

describe('detaching related targets', () => {
    it('does not hold a capture open for a target that detached during setup', async () => {
        const h = captureHarness({ command({ target, method }) {
            // The previous document's frame detaches while its resume is in flight.
            if (target.sessionId === 'old-frame' && method === 'Runtime.runIfWaitingForDebugger') return true;
        } });
        const session = await h.start();
        h.event('Target.attachedToTarget', { sessionId: 'old-frame', targetInfo: { type: 'iframe' }, waitingForDebugger: false });
        await new Promise(resolve => setTimeout(resolve, 5));
        h.event('Target.detachedFromTarget', { sessionId: 'old-frame' });
        const started = Date.now();
        await h.controller.finishSession(session, {});
        expect(Date.now() - started).toBeLessThan(1000);
        expect(h.sent.at(-1)).toMatchObject({ action: 'session_end', capture_warnings: [] });
    });
});

describe('complete native request transport', () => {
    it('splits a multi-megabyte record into exact, hashed, ordered messages below the transport frame size', async () => {
        vi.stubGlobal('crypto', webcrypto);
        const record = { id: 'h_abcd', body: '\\"😀'.repeat(220000), response: { body: 'response' } };
        const messages = [];
        for await (const message of nativeRequestMessages([record], 'session-one')) messages.push(message);
        const chunks = messages.filter(({ action }) => action === 'request_chunk');
        const bytes = Buffer.concat(chunks.map(({ data }) => Buffer.from(data, 'base64')));
        expect(chunks.length).toBeGreaterThan(5);
        expect(JSON.parse(bytes.toString('utf8'))).toEqual(record);
        expect(chunks.map(({ sequence }) => sequence)).toEqual(chunks.map((_, index) => index));
        expect(messages.at(-1)).toMatchObject({ action: 'request_end', chunks: chunks.length, total_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        expect(Math.max(...messages.map((message) => Buffer.byteLength(JSON.stringify(message))))).toBeLessThan(300 * 1024);
    });

    it('rejects finishing an earlier capture on a newly connected host', async () => {
        const bridge = new NativeBridge({ chromeApi: {} });
        const first = { postMessage: vi.fn() };
        const second = { postMessage: vi.fn() };
        bridge.port = first;
        const start = bridge.sendCapture({ action: 'session_begin', session_id: 's1' });
        bridge.port = second;
        expect(() => bridge.sendCapture({ action: 'session_end', session_id: 's1' })).toThrow('not sealed');
        expect(second.postMessage).not.toHaveBeenCalled();
        await expect(start).rejects.toMatchObject({ code: 'capture_transport_disconnected' });
    });

    it('fails explicit capture transport immediately without silently queueing for another host', () => {
        const bridge = new NativeBridge({ chromeApi: {} });
        expect(() => bridge.sendCapture({ action: 'session_begin', session_id: 's1' })).toThrow('not sealed');
        expect(bridge.queue).toEqual([]);
        bridge.port = { postMessage() { throw new Error('pipe closed'); } };
        expect(() => bridge.sendCapture({ action: 'request_chunk', session_id: 's1' })).toThrow('not sealed');
        expect(bridge.queue).toEqual([]);
    });
});


describe('renderer fetch preserves response evidence', () => {
    it('preserves binary content exactly and retains bytes received before a stream error', async () => {
        const reader = {
            read: vi.fn().mockResolvedValueOnce({ done: false, value: Uint8Array.from([0, 255, 254, 1]) }).mockRejectedValue(new Error('connection closed')),
            cancel: vi.fn(), releaseLock: vi.fn(),
        };
        const fetch = vi.fn().mockResolvedValue({
            ok: true, status: 200, statusText: 'OK', url: 'https://fixture.test/binary',
            headers: new Map([['content-type', 'application/octet-stream']]),
            body: { getReader: () => reader },
        });
        const expression = buildFetchExpression({ url: 'https://fixture.test/binary', method: 'GET', maxBodyBytes: 1024 });
        const response = await new Function('fetch', 'TextDecoder', 'TextEncoder', `return ${expression};`)(fetch, TextDecoder, TextEncoder);
        expect(response).toMatchObject({ body: 'AP/+AQ==', body_encoding: 'base64', body_bytes: 4, body_error: 'connection closed', body_truncated: true });
        expect(reader.releaseLock).toHaveBeenCalledOnce();
    });
});

describe('bounded WebSocket observation', () => {
    it('retains ordered text, binary, handshake and close evidence as one connection', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.event('Network.webSocketCreated', { requestId: 'ws1', url: 'wss://fixture.test/socket' });
        h.event('Network.webSocketWillSendHandshakeRequest', { requestId: 'ws1', timestamp: 10, wallTime: 1000, request: { headers: { Upgrade: 'websocket' } } });
        h.event('Network.webSocketHandshakeResponseReceived', { requestId: 'ws1', timestamp: 11, response: { status: 101, headers: { Upgrade: 'websocket' } } });
        h.event('Network.webSocketFrameSent', { requestId: 'ws1', timestamp: 12, response: { opcode: 1, mask: true, payloadData: 'hello 😀' } });
        h.event('Network.webSocketFrameReceived', { requestId: 'ws1', timestamp: 13, response: { opcode: 2, mask: false, payloadData: b64([0, 255, 5]) } });
        h.event('Network.webSocketClosed', { requestId: 'ws1', timestamp: 14 });
        await session.exportTail;
        expect(h.records()).toHaveLength(1);
        const [record] = h.records();
        expect(record).toMatchObject({ record_kind: 'websocket', method: '', url: 'wss://fixture.test/socket', response: { status: 101 }, stream: { version: 1, protocol: 'websocket', state: 'closed', capture: { state: 'complete', captured_events: 6, observed_events: 6, captured_bytes: 13, observed_bytes: 13, dropped_events: 0 } } });
        expect(record.stream.events.map(({ kind }) => kind)).toEqual(['created', 'handshake_request', 'handshake_response', 'message', 'message', 'closed']);
        expect(record.stream.events[3]).toMatchObject({ direction: 'sent', sequence: 4, timestamp: 12, opcode: 1, mask: true, payload: 'hello 😀', payload_encoding: 'utf-8', bytes: 10 });
        expect(record.stream.events[4]).toMatchObject({ direction: 'received', opcode: 2, payload: 'AP8F', payload_encoding: 'base64', bytes: 3 });
        expect(session.requestList()[0].stream.events).toEqual([]);
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(1);
        expect(h.sent.at(-1)).toMatchObject({ action: 'session_end', expected_requests: 1 });
    });

    it('retains live connections as partial when the observation boundary ends', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.event('Network.webSocketCreated', { requestId: 'ws', url: 'ws://fixture.test/socket' });
        h.event('Network.webSocketFrameReceived', { requestId: 'ws', timestamp: 1, response: { opcode: 1, payloadData: 'live' } });
        await h.controller.finishSession(session, {});
        expect(h.records()[0].stream).toMatchObject({ state: 'interrupted', capture: { state: 'partial', reason: 'capture_ended' } });
        expect(h.records()[0].stream.events.at(-1).kind).toBe('capture_end');
        expect(h.sent.at(-1).timed_out).toBe(false);
    });

    it('reports the deadline only when an open connection capture times out', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.event('Network.webSocketCreated', { requestId: 'ws', url: 'ws://fixture.test/socket' });
        h.event('Network.webSocketFrameReceived', { requestId: 'ws', timestamp: 1, response: { opcode: 1, payloadData: 'live' } });
        await h.controller.finishSession(session, { timedOut: true });
        expect(h.records()[0].stream).toMatchObject({ state: 'interrupted', capture: { state: 'partial', reason: 'capture_deadline' } });
        expect(h.records()[0].stream.events.at(-1).kind).toBe('capture_end');
        expect(h.sent.at(-1).timed_out).toBe(true);
    });

    it('reports event loss and limits combined HTTP and WebSocket payload bytes', async () => {
        const h = captureHarness();
        const session = await h.start(20, { max_total_body_bytes: 6, max_events: 3 });
        h.event('Network.requestWillBeSent', { requestId: 'post', type: 'Fetch', request: { url: 'https://fixture.test/post', method: 'POST', postData: 'abc' } });
        h.event('Network.webSocketCreated', { requestId: 'ws', url: 'wss://fixture.test/socket' });
        h.event('Network.webSocketFrameReceived', { requestId: 'ws', response: { opcode: 2, payloadData: b64([0, 1, 2, 3, 4]) } });
        h.event('Network.webSocketFrameSent', { requestId: 'ws', response: { opcode: 1, payloadData: 'xy' } });
        h.event('Network.webSocketClosed', { requestId: 'ws' });
        await h.controller.finishSession(session, {});
        const stream = h.records().find(({ record_kind }) => record_kind === 'websocket').stream;
        expect(stream.capture).toMatchObject({ state: 'partial', reason: 'event_limit', captured_events: 3, observed_events: 4, captured_bytes: 3, observed_bytes: 7, dropped_events: 1 });
        expect(stream.events[1]).toMatchObject({ payload: 'AAEC', bytes: 3, truncated: true });
        expect(h.sent.at(-1)).toMatchObject({ capture_stats: { retained_body_bytes: 6, dropped_events: 1 }, capture_warnings: expect.arrayContaining(['total_body_limit', 'event_limit']) });
    });

    it('separates identical child-target IDs and records detachment gaps', async () => {
        const h = captureHarness();
        const session = await h.start();
        for (const child of ['child-a', 'child-b']) {
            h.event('Network.webSocketCreated', { requestId: 'same', url: 'wss://fixture.test/socket' }, child);
            h.event('Network.webSocketFrameReceived', { requestId: 'same', response: { opcode: 1, payloadData: child } }, child);
        }
        h.event('Target.detachedFromTarget', { sessionId: 'child-a' });
        h.event('Network.webSocketClosed', { requestId: 'same' }, 'child-b');
        await h.controller.finishSession(session, {});
        const records = h.records();
        expect(new Set(records.map(({ id }) => id)).size).toBe(2);
        expect(new Set(records.map(({ stream }) => stream.connection_id)).size).toBe(2);
        expect(records.find(({ source_session_id }) => source_session_id === 'child-a').stream.capture).toMatchObject({ state: 'partial', reason: 'target_detached' });
        expect(records.find(({ source_session_id }) => source_session_id === 'child-b').stream.capture.state).toBe('complete');
    });

    it('keeps unknown connection URLs and discloses a missing creation event', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.event('Network.webSocketFrameReceived', { requestId: 'old', response: { opcode: 1, payloadData: 'attached late' } });
        h.event('Network.webSocketFrameError', { requestId: 'old', errorMessage: 'connection reset' });
        h.event('Network.webSocketClosed', { requestId: 'old' });
        await h.controller.finishSession(session, {});
        expect(h.records()[0]).toMatchObject({ url: '', stream: { capture: { state: 'partial', reason: 'connection_started_before_capture' } } });
        expect(h.records()[0].stream.events[1]).toMatchObject({ kind: 'error', error: 'connection reset' });
    });
});

describe('incremental capture and aggregate bounds', () => {
    it('aborts a partially initialized capture and stops publishing later records', async () => {
        let h;
        h = captureHarness({ command({ method, callback, chromeApi }) {
            if (method === 'Page.enable') {
                h.request('during-setup'); h.response('during-setup'); h.event('Network.loadingFinished', { requestId: 'during-setup' });
                chromeApi.runtime.lastError = { message: 'page target gone' }; callback(); chromeApi.runtime.lastError = null;
                return true;
            }
            if (method === 'Network.getResponseBody') { callback({ body: 'setup data' }); return true; }
        } });
        await expect(h.start()).rejects.toThrow('page target gone');
        const published = h.sent.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.sent.length).toBe(published);
        expect(h.sent.at(-1).action).toBe('session_abort');
        expect(h.controller.sessions.size).toBe(0);
    });

    it('does not count discarded stream fragments as exported body bytes', async () => {
        const h = captureHarness({ command({ method, callback, chromeApi }) {
            if (method === 'Network.streamResourceContent') {
                setTimeout(() => { chromeApi.runtime.lastError = { message: 'stream unavailable' }; callback(); chromeApi.runtime.lastError = null; }, 0);
                return true;
            }
            if (method === 'Network.getResponseBody') { chromeApi.runtime.lastError = { message: 'buffer unavailable' }; callback(); chromeApi.runtime.lastError = null; return true; }
        } });
        const session = await h.start();
        h.request(); h.response();
        h.event('Network.dataReceived', { requestId: 'r1', dataLength: 4, data: 'dGFpbA==' });
        h.event('Network.loadingFinished', { requestId: 'r1' });
        await h.controller.finishSession(session, {});
        expect(h.records()[0].response_body_capture.state).toBe('unavailable');
        expect(h.sent.at(-1).capture_stats.retained_body_bytes).toBe(0);
    });

    it('honors nested limits negotiated by the CLI', async () => {
        const h = captureHarness();
        const session = await h.start(100, { capture_limits: { max_requests: 1, max_total_body_bytes: 2, max_events: 1 } });
        h.event('Network.webSocketCreated', { requestId: 'ws', url: 'wss://fixture.test/socket' });
        h.event('Network.webSocketFrameReceived', { requestId: 'ws', response: { opcode: 1, payloadData: 'abc' } });
        h.request('omitted');
        await h.controller.finishSession(session, {});
        expect(h.sent[0]).toMatchObject({ capture_limits: { max_requests: 1, max_total_body_bytes: 2, max_events: 1 } });
        expect(h.records()).toHaveLength(1);
        expect(h.records()[0].stream.capture).toMatchObject({ captured_events: 1, observed_events: 3, dropped_events: 2 });
        expect(h.sent.at(-1).capture_stats.dropped_requests).toBe(1);
    });

    it('exports completed HTTP records before sealing and retains transport provenance', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: 'saved bytes' }); return true; }
        } });
        const session = await h.start();
        h.event('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', timestamp: 20, frameId: 'frame', loaderId: 'loader', request: { url: 'https://fixture.test/data', method: 'GET' } }, 'child');
        h.event('Network.responseReceived', { requestId: 'r', timestamp: 21, response: { status: 200, protocol: 'h3', remoteIPAddress: '127.0.0.1', remotePort: 443, connectionId: 4, connectionReused: true, fromDiskCache: false, fromServiceWorker: true, timing: { requestTime: 20, receiveHeadersEnd: 15 }, securityDetails: { protocol: 'TLS 1.3' } } }, 'child');
        h.event('Network.loadingFinished', { requestId: 'r', timestamp: 22, encodedDataLength: 8 }, 'child');
        await Promise.allSettled([...session.bodyPromises]);
        await session.exportTail;
        expect(h.sent.some(({ action }) => action === 'session_end')).toBe(false);
        expect(h.records()[0]).toMatchObject({ source_session_id: 'child', frame_id: 'frame', loader_id: 'loader', monotonic_timestamp: 20, completion_monotonic_timestamp: 22, response: { body: 'saved bytes', protocol: 'h3', remote_ip_address: '127.0.0.1', remote_port: 443, connection_id: 4, connection_reused: true, from_disk_cache: false, from_service_worker: true, timing: { requestTime: 20 }, security_details: { protocol: 'TLS 1.3' }, encoded_data_length: 8 } });
        expect(session.requestList()[0].response.body).toBe('');
        h.event('Network.responseReceivedExtraInfo', { requestId: 'r', headers: { late: 'value' } }, 'child');
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(1);
        expect(h.sent.at(-1)).toMatchObject({ capture_warnings: ['late_metadata_after_export'], expected_requests: 1 });
    });

    it('does not reset the aggregate body limit after an exported record', async () => {
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: '123456' }); return true; }
        } });
        const session = await h.start(20, { max_total_body_bytes: 9, max_requests: 2 });
        for (const id of ['one', 'two', 'dropped']) {
            h.request(id); h.response(id);
            h.event('Network.loadingFinished', { requestId: id });
            await Promise.allSettled([...session.bodyPromises]); await session.exportTail;
        }
        await h.controller.finishSession(session, {});
        expect(h.records().map(({ response }) => response.body)).toEqual(['123456', '123']);
        expect(h.records()[1].response_body_capture).toMatchObject({ state: 'partial', reason: 'total_body_limit', captured_bytes: 3, observed_bytes: 6 });
        expect(h.sent.at(-1)).toMatchObject({ expected_requests: 2, capture_stats: { retained_body_bytes: 9, dropped_requests: 1 }, capture_warnings: expect.arrayContaining(['total_body_limit', 'request_limit']) });
    });

    it('serializes completed records behind acknowledgements and seals after the final one', async () => {
        const releases = [];
        const h = captureHarness({ emit(message) {
            if (message.action === 'add_many') return new Promise((resolve) => releases.push(resolve));
            return true;
        } });
        const session = await h.start();
        for (const id of ['one', 'two']) {
            h.request(id); h.event('Network.responseReceived', { requestId: id, response: { status: 204 } });
            h.event('Network.loadingFinished', { requestId: id });
        }
        await Promise.allSettled([...session.bodyPromises]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.records()).toHaveLength(1);
        const finishing = h.controller.finishSession(session, {});
        releases.shift()();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.records()).toHaveLength(2);
        expect(h.sent.some(({ action }) => action === 'session_end')).toBe(false);
        releases.shift()();
        await finishing;
        expect(h.sent.map(({ action }) => action)).toEqual(['session_begin', 'add_many', 'add_many', 'session_end']);
        await h.controller.finishSession(session, {});
        expect(h.sent.filter(({ action }) => action === 'session_end')).toHaveLength(1);
    });

    it('fails without sealing when the export backlog exceeds its explicit byte limit', async () => {
        let release;
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: 'a'.repeat(600 * 1024) }); return true; }
        }, emit(message) {
            if (message.action === 'add_many') return new Promise((resolve) => { release = resolve; });
            return true;
        } });
        const session = await h.start(1024 * 1024, { max_native_backlog_bytes: 1024 * 1024 });
        const rejected = expect(session.settled).rejects.toMatchObject({ code: 'capture_backlog_limit' });
        for (const id of ['one', 'two']) {
            h.request(id); h.response(id); h.event('Network.loadingFinished', { requestId: id });
            await Promise.allSettled([...session.bodyPromises]);
        }
        await rejected;
        release();
        await expect(h.controller.finishSession(session, {})).rejects.toMatchObject({ code: 'capture_backlog_limit' });
        expect(h.sent.some(({ action }) => action === 'session_end')).toBe(false);
        expect(h.sent.at(-1).action).toBe('session_abort');
    });

    it('discloses a download classification arriving after immutable export', async () => {
        const h = captureHarness();
        const session = await h.start();
        h.request('download');
        h.event('Network.loadingFailed', { requestId: 'download', canceled: true, errorText: 'net::ERR_ABORTED' });
        await session.exportTail;
        const saved = JSON.stringify(h.records()[0]);
        h.event('Page.downloadWillBegin', { url: 'https://fixture.test/data', frameId: 'frame' });
        await h.controller.finishSession(session, {});
        expect(JSON.stringify(h.records()[0])).toBe(saved);
        expect(session.requestList()[0].intentional_cancellation).toBeUndefined();
        expect(h.sent.at(-1).capture_warnings).toContain('late_download_after_export');
    });

    it('retains bounded payload buffers during 2500 sustained completed records', async () => {
        const count = 2500;
        const payload = 'x'.repeat(1024);
        let session;
        let currentID;
        let peakBodyBytes = 0;
        let peakBacklogBytes = 0;
        const h = captureHarness({ command({ method, callback }) {
            if (method === 'Network.getResponseBody') { callback({ body: payload }); return true; }
        }, emit(message) {
            if (message.action === 'add_many') {
                peakBodyBytes = Math.max(peakBodyBytes, session.current.get(currentID).response.body.length);
                peakBacklogBytes = Math.max(peakBacklogBytes, session.exportPendingBytes);
            }
            return true;
        } });
        session = await h.start();
        const fullList = vi.spyOn(session, 'requestList');
        const started = performance.now();
        for (let index = 0; index < count; index += 1) {
            currentID = `stress-${index}`;
            h.request(currentID); h.response(currentID); h.event('Network.loadingFinished', { requestId: currentID });
            await Promise.allSettled([...session.bodyPromises]); await session.exportTail;
        }
        const elapsed = performance.now() - started;
        await h.controller.finishSession(session, {});
        expect(fullList).not.toHaveBeenCalled();
        expect(h.records()).toHaveLength(count);
        expect(new Set(h.records().map(({ id }) => id)).size).toBe(count);
        expect(session.exportPendingBytes).toBe(0);
        expect([...session.requests.values()].every((record) => record.body === '' && record.response.body === '')).toBe(true);
        expect(peakBodyBytes).toBe(1024);
        expect(peakBacklogBytes).toBeLessThan(4096);
        expect(h.sent.at(-1)).toMatchObject({ expected_requests: count, capture_stats: { retained_body_bytes: count * 1024, exported_records: count } });
        console.log('capture stress fixture', JSON.stringify({ records: count, elapsed_ms: Math.round(elapsed), records_per_second: Math.round(count * 1000 / elapsed), peak_retained_payload_bytes: peakBodyBytes, peak_export_backlog_bytes: peakBacklogBytes }));
    });
});

describe('small-fragment memory bounds', () => {
    it('coalesces 131072 one-byte events into bounded pages and keeps drop accounting', () => {
        const collector = new ResponseBodyCollector(65536);
        for (let index = 0; index < 131072; index += 1) collector.appendBase64('YQ==');
        const backingBytes = [...new Set(collector.parts.map(({ buffer }) => buffer))].reduce((total, buffer) => total + buffer.byteLength, 0);
        expect(collector.parts.length).toBeLessThan(16);
        expect(backingBytes).toBeLessThanOrEqual(65536);
        expect(collector.materialize('text/plain')).toMatchObject({ body: 'a'.repeat(65536), captured: 65536, truncated: true });
        expect(collector.observed).toBe(131072);
        expect(collector.chunks).toBe(131072);
    });
});

describe('native capture acknowledgements', () => {
    it.each(['action', 'open', 'fetch'])('rejects an older host before %s performs browser work', async (operation) => {
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.port = { postMessage: vi.fn() };
        await bridge.handleMessage({ action: 'hello', success: true });
        const h = captureHarness();
        h.controller.capturePreflight = () => bridge.assertCaptureReady();
        await expect(h.controller[operation]({ url: 'https://fixture.test', expression: '1' })).rejects.toMatchObject({ code: 'unsupported_capture_host' });
        expect(h.commands).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(h.controller.sessions.size).toBe(0);
    });

    it('waits for the current host capability handshake and rejects a later legacy host', async () => {
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.port = { postMessage() {} };
        const ready = bridge.assertCaptureReady();
        await bridge.handleMessage({ action: 'hello', capture_ack: true, incremental_capture: true });
        await expect(ready).resolves.toBe(true);
        await bridge.handleMessage({ action: 'hello', success: true });
        await expect(bridge.assertCaptureReady()).rejects.toMatchObject({ code: 'unsupported_capture_host' });
    });

    it('binds acknowledgement to session and sequence and clears only after seal acceptance', async () => {
        const posted = [];
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.port = { postMessage(message) { posted.push(message); } };
        let resolved = false;
        const begin = bridge.sendCapture({ action: 'session_begin', session_id: 's' }).then(() => { resolved = true; });
        await bridge.handleMessage({ action: 'capture_ack', session_id: 'wrong', capture_sequence: 0, success: true });
        expect(resolved).toBe(false);
        await bridge.handleMessage({ action: 'capture_ack', session_id: 's', capture_sequence: 0, success: true }); await begin;
        const end = bridge.sendCapture({ action: 'session_end', session_id: 's' });
        expect(bridge.captureConnection.sessionID).toBe('s');
        await bridge.handleMessage({ action: 'capture_ack', session_id: 's', capture_sequence: 1, success: true }); await end;
        expect(posted.map(({ capture_sequence }) => capture_sequence)).toEqual([0, 1]);
        expect(bridge.capturePendingBytes).toBe(0);
        expect(bridge.captureConnection).toBeNull();
    });

    it('reports acknowledgement timeout and permits only abort before another capture', async () => {
        vi.useFakeTimers();
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.port = { postMessage() {} };
        const begin = bridge.sendCapture({ action: 'session_begin', session_id: 's' });
        const rejected = expect(begin).rejects.toMatchObject({ code: 'capture_ack_timeout' });
        await vi.advanceTimersByTimeAsync(10000); await rejected;
        expect(() => bridge.sendCapture({ action: 'session_begin', session_id: 'new' })).toThrow('awaiting completion or abort');
        const abort = bridge.sendCapture({ action: 'session_abort', session_id: 's', capture_error: 'timeout' });
        await bridge.handleMessage({ action: 'capture_ack', session_id: 's', capture_sequence: 1, success: true }); await abort;
        expect(bridge.captureConnection).toBeNull();
        expect(bridge.failedCaptureConnection).toBeNull();
    });

    it('propagates a host rejection and never puts explicit records in ambient reconnect queue', async () => {
        const bridge = new NativeBridge({ chromeApi: {} });
        bridge.port = { postMessage() {} };
        const begin = bridge.sendCapture({ action: 'session_begin', session_id: 's' });
        const rejected = expect(begin).rejects.toMatchObject({ code: 'capture_rejected', message: 'spool full' });
        await bridge.handleMessage({ action: 'capture_ack', session_id: 's', capture_sequence: 0, success: false, error: { code: 'capture_rejected', message: 'spool full' } });
        await rejected;
        expect(bridge.queue).toEqual([]);
        expect(bridge.capturePendingBytes).toBe(0);
    });
});
