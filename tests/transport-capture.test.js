import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CDPCaptureController } from '../js/background/cdp-capture.js';

function harness({ maxBodyBytes = 8 * 1024 * 1024, limits = {}, failedSetup = false, command, emit } = {}) {
    let listener;
    const sent = [], commands = [];
    const chromeApi = {
        runtime: { lastError: null },
        debugger: {
            onEvent: { addListener(fn) { listener = fn; } }, onDetach: { addListener() {} },
            attach(target, version, callback) { callback(); }, detach(target, callback) { callback(); },
            sendCommand(target, method, params, callback) {
                commands.push({ target, method, params });
                if (command?.({ target, method, params, callback }) === true) return;
                if (method === 'Runtime.enable') listener(target, 'Runtime.executionContextCreated', { context: { id: 3, auxData: { isDefault: true, frameId: 'frame-3' } } });
                if (method === 'Page.addScriptToEvaluateOnNewDocument') callback(failedSetup ? {} : { identifier: 'startup-script' });
                else if (method === 'Runtime.evaluate') callback({ result: { value: params.expression.startsWith('globalThis[') ? { stopped: true, reasons: [], pending: 0, dropped_events: 0 } : { installed: true } } });
                else callback({});
            },
        },
    };
    const controller = new CDPCaptureController({ chromeApi, emit(message) { sent.push(message); return emit ? emit(message) : true; } });
    return {
        controller, sent, commands,
        start(protocolPayloads = false, webrtcMedia = false) { return controller.startSession(7, { url: 'https://fixture.test', captureMode: 'action', maxBodyBytes, limits, protocolPayloads, webrtcMedia, timeoutMs: 30000, idleMs: 100 }); },
        event(method, params, child) { listener({ tabId: 7, ...(child ? { sessionId: child } : {}) }, method, params); },
        bind(session, events, context = 3, child) { this.event('Runtime.bindingCalled', { name: session.transports.bindingName, executionContextId: context, payload: JSON.stringify({ token: session.transports.token, batch_sequence: session.transports.targets.get(child || '').contexts.get(context)?.nextBatch, events }) }, child); },
        records() {
            const records = sent.filter(({ action }) => action === 'add_many').flatMap(({ requests }) => requests);
            const transfers = new Map();
            for (const message of sent) {
                if (message.action === 'request_chunk') {
                    if (!transfers.has(message.transfer_id)) transfers.set(message.transfer_id, []);
                    transfers.get(message.transfer_id).push(Buffer.from(message.data, 'base64'));
                }
                if (message.action === 'request_end') records.push(JSON.parse(Buffer.concat(transfers.get(message.transfer_id)).toString()));
            }
            return records;
        },
    };
}

const rtc = (kind, fields = {}) => ({ protocol: 'webrtc', connection_id: 'dc1', kind, timestamp: 1.5, ...fields });
const media = (kind, fields = {}) => ({ protocol: 'webrtc_media', connection_id: 'media1', kind, timestamp: 2.5, ...fields });
afterEach(() => vi.unstubAllGlobals());

describe('transport capture integration', () => {
    it('captures passive WebTransport lifecycle with explicit unavailable payload coverage', async () => {
        const h = harness(), session = await h.start();
        for (const [method, timestamp] of [['webTransportCreated', 2], ['webTransportConnectionEstablished', 3], ['webTransportClosed', 4]]) {
            h.event(`Network.${method}`, { transportId: '1', timestamp, url: 'https://fixture.test/transport' });
        }
        await h.controller.finishSession(session, {});
        expect(h.commands.some(({ method }) => method === 'Runtime.addBinding')).toBe(false);
        expect(h.records()).toHaveLength(1);
        expect(h.records()[0].stream).toMatchObject({ protocol: 'webtransport', source: 'cdp_lifecycle', state: 'closed', payload_semantics: 'unavailable', capture: { state: 'partial', reason: 'payload_capture_unavailable', captured_events: 3, observed_events: 3 } });
    });

    it('installs before capture and exports exact scoped data-channel bytes with metadata', async () => {
        const h = harness(), session = await h.start(true);
        h.bind(session, [rtc('created', { metadata: { label: 'fixture', parent_peer_id: 'pc1', time_origin_ms: 5 } }), rtc('open'), rtc('message', { direction: 'sent', payload: 'AP8=', payload_encoding: 'base64', bytes: 2 }), rtc('closed')]);
        await h.controller.finishSession(session, {});
        const [record] = h.records();
        expect(record).toMatchObject({ record_kind: 'webrtc', frame_id: 'frame-3', stream: { source: 'page_api', clock: 'performance_now_seconds', metadata: { label: 'fixture', observer_trust: 'page_controlled', execution_context_id: 3 }, capture: { state: 'complete', scope: 'instrumented_api_calls', captured_bytes: 2, observed_bytes: 2 } } });
        expect(record.stream.events[2]).toMatchObject({ payload: 'AP8=', bytes: 2, payload_encoding: 'base64', direction: 'sent' });
        expect(record.protocolContextID).toBeUndefined();
        const names = h.commands.map(({ method }) => method);
        expect(names).toContain('Page.removeScriptToEvaluateOnNewDocument');
        expect(names).toContain('Runtime.removeBinding');
        expect(h.sent.at(-1)).toMatchObject({ action: 'session_end', expected_requests: 1 });
    });

    it('does not double count bytes truncated by the background or observer', async () => {
        const h = harness({ maxBodyBytes: 2 }), session = await h.start(true);
        h.bind(session, [rtc('created'), rtc('message', { payload: 'abcdef', payload_encoding: 'utf-8', bytes: 6, observed_bytes: 8, truncated: true, reason: 'message_limit' }), rtc('closed')]);
        await h.controller.finishSession(session, {});
        expect(h.records()[0].stream.capture).toMatchObject({ state: 'partial', captured_bytes: 2, observed_bytes: 8 });
    });

    it('keeps identical connection IDs from separate realms separate and marks destroyed realms partial', async () => {
        const h = harness(), session = await h.start(true);
        h.event('Runtime.executionContextCreated', { context: { id: 4, auxData: { isDefault: true, frameId: 'frame-4' } } });
        h.bind(session, [rtc('created'), rtc('open')]);
        h.bind(session, [rtc('created'), rtc('closed')], 4);
        h.event('Runtime.executionContextDestroyed', { executionContextId: 3 });
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(2);
        const streams = h.records().map(({ stream }) => stream);
        expect(new Set(streams.map(({ connection_id }) => connection_id)).size).toBe(2);
        expect(streams.find(({ metadata }) => metadata.execution_context_id === 3).capture).toMatchObject({ state: 'partial', reason: 'execution_context_destroyed' });
        expect(streams.find(({ metadata }) => metadata.execution_context_id === 4).capture.state).toBe('complete');
    });

    it('shares the bounded event budget and preserves a gap after the budget ends', async () => {
        const h = harness({ limits: { max_events: 2 } }), session = await h.start(true);
        h.bind(session, [rtc('created'), rtc('open'), rtc('message', { payload: 'lost', payload_encoding: 'utf-8', bytes: 4 }), rtc('closed')]);
        await h.controller.finishSession(session, {});
        expect(h.records()[0].stream.capture).toMatchObject({ state: 'partial', reason: 'event_limit', captured_events: 2, observed_events: 4, dropped_events: 2, captured_bytes: 0, observed_bytes: 4 });
    });

    it('rejects unsupported setup before returning an active capture and aborts the native session', async () => {
        const h = harness({ failedSetup: true });
        await expect(h.start(true)).rejects.toThrow('startup script');
        expect(h.controller.sessions.size).toBe(0);
        expect(h.sent.at(-1).action).toBe('session_abort');
    });

    it('does not install late startup hooks after stopping a pending child setup', async () => {
        let release;
        const h = harness({ command({ target, method, callback }) {
            if (target.sessionId === 'child' && method === 'Runtime.addBinding') { release = callback; return true; }
        } });
        const session = await h.start(true);
        const setup = session.transports.enableTarget({ tabId: 7, sessionId: 'child' }, 'worker');
        const stop = session.transports.stop();
        release({});
        await Promise.all([setup, stop]);
        expect(h.commands.filter(({ target }) => target.sessionId === 'child').map(({ method }) => method)).not.toContain('Runtime.enable');
        await h.controller.finishSession(session, {});
    });

    it('scopes malformed bindings and records lost batches even before a first created event', async () => {
        const h = harness(), session = await h.start(true);
        h.event('Runtime.executionContextCreated', { context: { id: 4, auxData: { isDefault: true } } });
        h.bind(session, [rtc('created')], 4);
        h.event('Runtime.bindingCalled', { name: session.transports.bindingName, executionContextId: 3, payload: JSON.stringify({ token: session.transports.token, batch_sequence: 2, events: [rtc('created'), rtc('closed')] }) });
        h.bind(session, [rtc('closed')], 4);
        await h.controller.finishSession(session, {});
        const records = h.records();
        expect(records.find(({ stream }) => stream.metadata.execution_context_id === 3).stream.capture).toMatchObject({ state: 'partial', reason: 'protocol_observer_batch_gap' });
        expect(records.find(({ stream }) => stream.metadata.execution_context_id === 4).stream.capture.state).toBe('complete');
    });

    it('does not confuse a reused execution context ID with an old connection', async () => {
        const h = harness(), session = await h.start(true);
        h.bind(session, [rtc('created'), rtc('closed')]);
        h.event('Runtime.executionContextDestroyed', { executionContextId: 3 });
        h.event('Runtime.executionContextCreated', { context: { id: 3, uniqueId: 'second-realm', auxData: { isDefault: true } } });
        h.bind(session, [rtc('created'), rtc('closed')]);
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(2);
        expect(new Set(h.records().map(({ id }) => id)).size).toBe(2);
        expect(h.commands.some(({ params }) => params.uniqueContextId === 'second-realm')).toBe(true);
    });

    it('counts rejected transport connections and events separately', async () => {
        const h = harness({ limits: { max_requests: 0 } }), session = await h.start();
        for (const method of ['webTransportCreated', 'webTransportConnectionEstablished', 'webTransportClosed']) h.event(`Network.${method}`, { transportId: '1' });
        await h.controller.finishSession(session, {});
        expect(h.sent.at(-1).capture_stats).toMatchObject({ dropped_requests: 1, observed_events: 3, dropped_events: 3 });
    });

    it('cleans overflow contexts and removes their automatic startup registration', async () => {
        const h = harness(), session = await h.start(true);
        for (let id = 4; id <= 131; id++) h.event('Runtime.executionContextCreated', { context: { id, uniqueId: `realm-${id}`, auxData: { isDefault: true } } });
        await h.controller.finishSession(session, {});
        expect(h.commands.some(({ method, params }) => method === 'Runtime.evaluate' && params.uniqueContextId === 'realm-131' && params.expression.includes('?.stop()'))).toBe(true);
        expect(h.sent.at(-1).capture_warnings).toContain('protocol_observer_context_limit');
    });

    it('captures media independently with explicit reencoding and recorded-interval coverage', async () => {
        const h = harness(), session = await h.start(false, true);
        expect(session.transports.source).toContain('"protocolPayloads":false');
        expect(session.transports.source).toContain('"webrtcMedia":true');
        h.bind(session, [
            media('created', { metadata: { semantics: 'reencoded_media', mime_type: 'audio/webm', track_id: 'original-audio', direction: 'received', media_kind: 'audio' } }),
            media('open', { metadata: { mime_type: 'audio/webm;codecs=opus' } }),
            media('chunk', { direction: 'received', payload: 'AP8=', payload_encoding: 'base64', bytes: 2, metadata: { chunk_index: 1, mime_type: 'audio/webm;codecs=opus' } }),
            media('closed', { metadata: { recorder_finalized: true, stop_reason: 'capture_ended', chunk_count: 1, observed_media_bytes: 2 } }),
        ]);
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(1);
        expect(h.records()[0]).toMatchObject({ record_kind: 'webrtc_media', stream: {
            protocol: 'webrtc_media', source: 'browser_media_recorder', payload_semantics: 'reencoded_media',
            metadata: { track_id: 'original-audio', mime_type: 'audio/webm;codecs=opus', observer_trust: 'page_controlled' },
            capture: { state: 'complete', scope: 'recorded_media_interval', captured_bytes: 2 },
        } });
        expect(h.records()[0].stream.events[2]).toMatchObject({ kind: 'chunk', payload: 'AP8=', metadata: { chunk_index: 1 } });
        expect(h.sent.at(-1).capture_stats).toMatchObject({ protocol_payloads: 0, webrtc_media: 1, exported_records: 1 });
    });

    it.each([
        [{ recorder_finalized: false, chunk_count: 1, observed_media_bytes: 2 }, 1, 'media_recorder_not_finalized'],
        [{ recorder_finalized: true, chunk_count: 2, observed_media_bytes: 2 }, 1, 'media_chunk_sequence_mismatch'],
        [{ recorder_finalized: true, chunk_count: 1, observed_media_bytes: 2 }, 2, 'media_chunk_sequence_mismatch'],
        [{ recorder_finalized: true, chunk_count: 1, observed_media_bytes: 3 }, 1, 'media_byte_count_mismatch'],
        [{ recorder_finalized: true }, 1, 'media_chunk_sequence_mismatch'],
    ])('refuses complete media coverage when final recorder counters disagree: %j', async (metadata, chunkIndex, reason) => {
        const h = harness(), session = await h.start(false, true);
        h.bind(session, [
            media('created'),
            media('chunk', { payload: 'AP8=', payload_encoding: 'base64', bytes: 2, metadata: { chunk_index: chunkIndex } }),
            media('closed', { metadata }),
        ]);
        await h.controller.finishSession(session, {});
        expect(h.records()[0].stream.capture).toMatchObject({ state: 'partial', reason, captured_bytes: 2 });
        expect(h.sent.at(-1).capture_warnings).toContain(reason);
    });

    it('preserves media gaps when an execution context disappears before recorder finalization', async () => {
        const h = harness(), session = await h.start(false, true);
        h.bind(session, [media('created'), media('chunk', { payload: 'aGVhZA==', payload_encoding: 'base64', bytes: 4, metadata: { chunk_index: 1 } })]);
        h.event('Runtime.executionContextDestroyed', { executionContextId: 3 });
        await h.controller.finishSession(session, {});
        expect(h.records()[0].stream.capture).toMatchObject({ state: 'partial', scope: 'recorded_media_interval', reason: 'execution_context_destroyed', captured_bytes: 4 });
    });

    it('serializes simultaneous media exports within the native backlog byte budget', async () => {
        vi.stubGlobal('crypto', webcrypto);
        let session;
        let peakBacklog = 0;
        const h = harness({ limits: { max_native_backlog_bytes: 1024 * 1024 }, emit(message) {
            if (message.action === 'request_chunk' || message.action === 'add_many') {
                peakBacklog = Math.max(peakBacklog, session.exportPendingBytes);
                return new Promise(resolve => setTimeout(resolve, 1));
            }
            return true;
        } });
        session = await h.start(false, true);
        const payload = Buffer.alloc(300 * 1024, 7).toString('base64');
        for (let i = 1; i <= 4; i++) h.bind(session, [
            media('created', { connection_id: `media${i}` }),
            media('chunk', { connection_id: `media${i}`, payload, payload_encoding: 'base64', bytes: 300 * 1024, metadata: { chunk_index: 1 } }),
            media('closed', { connection_id: `media${i}`, metadata: { recorder_finalized: true, chunk_count: 1, observed_media_bytes: 300 * 1024 } }),
        ]);
        await h.controller.finishSession(session, {});
        expect(h.records()).toHaveLength(4);
        expect(h.records().every(record => record.stream.capture.captured_bytes === 300 * 1024)).toBe(true);
        expect(peakBacklog).toBeGreaterThan(300 * 1024);
        expect(peakBacklog).toBeLessThan(1024 * 1024);
        expect(session.transportError).toBeFalsy();
        expect(h.sent.at(-1)).toMatchObject({ action: 'session_end', expected_requests: 4 });
    });
});
