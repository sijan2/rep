// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';
import { transportObserverSource } from '../js/background/transport-observer.js';

const fixtures = [];
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const payloadBytes = event => Buffer.from(event.payload || '', event.payload_encoding === 'base64' ? 'base64' : 'utf8');

function fixture(config = {}, extra = {}) {
    const batches = [];
    const messages = [];
    const context = createContext({
        TextEncoder, TextDecoder, Blob, performance, btoa, setTimeout, clearTimeout, queueMicrotask,
        ReadableStream, WritableStream, ReadableStreamDefaultReader, ReadableStreamBYOBReader, WritableStreamDefaultWriter,
        __binding(message) { messages.push(message); batches.push(JSON.parse(message)); },
        ...extra,
    });
    runInContext(`
        class Target {
            constructor() { this.listeners = new Map(); }
            addEventListener(type, fn) {
                if (!this.listeners.has(type)) this.listeners.set(type, new Set());
                this.listeners.get(type).add(fn);
            }
            removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
            dispatch(type, extra = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...extra }); }
            listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
        }
        globalThis.RTCDataChannel = class RTCDataChannel extends Target {
            constructor(label = 'diagnostics') {
                super(); this.label = label; this.id = 7; this.protocol = 'fixture';
                this.ordered = true; this.negotiated = false; this.maxRetransmits = null;
                this.maxPacketLifeTime = null; this.readyState = 'connecting'; this.binaryType = 'arraybuffer';
                this.sent = [];
            }
            send(value) { if (this.rejectSend) throw new Error('native send rejected'); this.sent.push(value); return undefined; }
            open() { this.readyState = 'open'; this.dispatch('open'); }
            receive(value) { this.dispatch('message', { data: value }); }
            close() { this.readyState = 'closed'; this.dispatch('close'); }
        };
        globalThis.RTCPeerConnection = class RTCPeerConnection extends Target {
            constructor() { super(); this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable'; }
            createDataChannel(label) { return new RTCDataChannel(label); }
            receiveChannel(channel) { this.dispatch('datachannel', { channel }); }
            close() { this.connectionState = 'closed'; this.dispatch('connectionstatechange'); }
        };
        globalThis.WebTransportDatagramDuplexStream = class WebTransportDatagramDuplexStream {
            constructor(owner) {
                this.owner = owner;
                this.readable = new ReadableStream({ type: 'bytes', start: controller => { owner.datagramInput = controller; } });
                this.writable = this.createWritable();
            }
            createWritable() { return this.owner.makeWritable('datagrams'); }
        };
        globalThis.WebTransport = class WebTransport {
            constructor(url) {
                this.url = url; this.writes = []; this.nativeCloseCalls = 0;
                this.reliability = 'supports-unreliable'; this.congestionControl = 'default';
                this.ready = Promise.resolve(); this.closed = new Promise(resolve => { this.end = resolve; });
                this.datagrams = new WebTransportDatagramDuplexStream(this);
                this.incomingUnidirectionalStreams = new ReadableStream({ start: controller => { this.uniInput = controller; } });
                this.incomingBidirectionalStreams = new ReadableStream({ start: controller => { this.bidiInput = controller; } });
            }
            makeWritable(type) { return new WritableStream({ write: value => { this.writes.push({ type, value }); return this.writeResult; } }); }
            createUnidirectionalStream() { this.lastCreate = Promise.resolve(this.makeWritable('uni')); return this.lastCreate; }
            createBidirectionalStream() {
                const pair = { writable: this.makeWritable('bidi'), readable: new ReadableStream({ start: controller => { this.bidiReply = controller; } }) };
                this.lastPair = pair; this.lastCreate = Promise.resolve(pair); return this.lastCreate;
            }
            close(info) { this.nativeCloseCalls++; this.end(info); }
        };
    `, context);
    const settings = { bindingName: '__binding', controlName: '__observer', token: 'fixture-token', maxEvents: 10000, maxBytes: 64 * 1024 * 1024, maxMessageBytes: 8 * 1024 * 1024, ...config };
    const original = {
        peer: context.RTCPeerConnection, transport: context.WebTransport,
        send: context.RTCDataChannel.prototype.send, read: ReadableStreamDefaultReader.prototype.read,
        writer: WritableStreamDefaultWriter.prototype.write,
    };
    const installed = runInContext(transportObserverSource(settings), context);
    const result = {
        context, settings, original, installed, batches, messages,
        control: context.__observer,
        events: () => batches.flatMap(batch => batch.events),
        rtc() { const peer = new context.RTCPeerConnection(); const channel = peer.createDataChannel('diagnostics'); return { peer, channel }; },
        wt() { return new context.WebTransport('https://loopback.test/diagnostics'); },
        stop() { return result.control.stop(); },
    };
    fixtures.push(result);
    return result;
}

afterEach(async () => {
    for (const h of fixtures.splice(0).reverse()) await h.stop();
});

describe('injected transport observer lifecycle', () => {
    it('installs idempotently with bounded limits and restores native hooks and globals', async () => {
        const h = fixture({ maxEvents: Infinity, maxBytes: NaN, maxMessageBytes: 100 * 1024 * 1024 });
        expect(h.installed).toMatchObject({ installed: true, version: 1, capabilities: { webrtc: true, webtransport: true }, limits: { maxEvents: 10000, maxBytes: 64 * 1024 * 1024, maxMessageBytes: 8 * 1024 * 1024 } });
        expect(runInContext(transportObserverSource(h.settings), h.context)).toMatchObject({ installed: true });
        const { peer, channel } = h.rtc();
        expect(channel.listenerCount()).toBe(4);
        const stopped = await h.stop();
        expect(stopped).toMatchObject({ stopped: true, pending: 0, reasons: ['capture_ended'] });
        expect(channel.listenerCount()).toBe(0);
        expect(peer.listenerCount()).toBe(0);
        expect(channel.readyState).toBe('connecting');
        expect(h.context.RTCPeerConnection).toBe(h.original.peer);
        expect(h.context.WebTransport).toBe(h.original.transport);
        expect(h.context.RTCDataChannel.prototype.send).toBe(h.original.send);
        expect(ReadableStreamDefaultReader.prototype.read).toBe(h.original.read);
        expect(WritableStreamDefaultWriter.prototype.write).toBe(h.original.writer);
        expect(h.context.__observer).toBeUndefined();
        expect(h.context.__binding).toBeUndefined();
        expect(await h.stop()).toEqual(stopped);
    });

    it('preserves page replacements when restoring hooks, binding and control', async () => {
        const h = fixture();
        const replacement = () => 'page replacement';
        h.context.RTCDataChannel.prototype.send = replacement;
        h.context.__binding = replacement;
        Object.defineProperty(h.context, '__observer', { configurable: true, value: replacement });
        await h.stop();
        expect(h.context.RTCDataChannel.prototype.send).toBe(replacement);
        expect(h.context.__binding).toBe(replacement);
        expect(h.context.__observer).toBe(replacement);
    });

    it('discloses unavailable APIs and rejects invalid or foreign control configurations', async () => {
        const h = fixture();
        expect(runInContext(transportObserverSource({ ...h.settings, token: 'other-token' }), h.context)).toMatchObject({ installed: false, reason: 'observer_control_exists' });
        expect(runInContext(transportObserverSource({ ...h.settings, token: 'x'.repeat(300) }), h.context)).toMatchObject({ installed: false, reason: 'invalid_observer_config' });
        expect(h.installed.limitations).toContain('cached_native_methods_and_page_code_can_bypass_or_forge_observation');
    });
});

describe('WebRTC application data evidence', () => {
    it('preserves text including BOM, byte views, remote channel identity and accepted native sends', async () => {
        const h = fixture();
        const { peer, channel } = h.rtc();
        channel.binaryType = 'blob';
        channel.open();
        const text = '\ufeffhello 😀';
        expect(channel.send(text)).toBeUndefined();
        const bytes = Uint8Array.from([99, 0, 255, 5, 88]);
        channel.send(new DataView(bytes.buffer, 1, 3));
        channel.receive(bytes.buffer.slice(1, 4));
        channel.rejectSend = true;
        expect(() => channel.send('rejected')).toThrow('native send rejected');
        const remote = new h.context.RTCDataChannel('remote');
        peer.receiveChannel(remote);
        remote.receive('incoming');
        channel.close();
        remote.close();
        await h.stop();
        const events = h.events();
        const data = events.filter(event => event.kind === 'message');
        expect(data).toHaveLength(4);
        expect(data[0]).toMatchObject({ protocol: 'webrtc', direction: 'sent', payload: text, payload_encoding: 'utf-8', bytes: Buffer.byteLength(text) });
        expect(payloadBytes(data[1])).toEqual(Buffer.from([0, 255, 5]));
        expect(payloadBytes(data[2])).toEqual(Buffer.from([0, 255, 5]));
        expect(channel.binaryType).toBe('blob');
        const created = events.filter(event => event.kind === 'created');
        expect(created).toHaveLength(2);
        expect(created[0].metadata).toMatchObject({ label: 'diagnostics', id: 7, parent_peer_id: expect.any(String), time_origin_ms: expect.any(Number), observer_limits: { maxMessageBytes: 8 * 1024 * 1024 } });
        expect(created[1].metadata.parent_peer_id).toBe(created[0].metadata.parent_peer_id);
        expect(created[1].connection_id).not.toBe(created[0].connection_id);
        expect(events.at(-1).kind).toBe('closed');
        expect(h.batches.map(batch => batch.batch_sequence)).toEqual(h.batches.map((_, i) => i + 1));
    });

    it('flushes a delayed Blob before later messages and the native closed event', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const pending = deferred();
        const blob = new Blob([Uint8Array.from([1, 0, 255])]);
        blob.slice = () => ({ arrayBuffer: () => pending.promise });
        channel.send(blob);
        channel.receive('after blob');
        channel.close();
        await tick();
        expect(h.events().filter(event => event.kind === 'closed')).toHaveLength(0);
        pending.resolve(Uint8Array.from([1, 0, 255]).buffer);
        await h.stop();
        expect(h.events().map(event => event.kind)).toEqual(['created', 'message', 'message', 'closed']);
        expect(payloadBytes(h.events()[1])).toEqual(Buffer.from([1, 0, 255]));
        expect(h.events()[2].payload).toBe('after blob');
        expect(h.control.info()).toMatchObject({ pending_events: 0, pending_bytes: 0, captured_bytes: 13 });
    });

    it('reports Blob read failure as a gap before closed', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const blob = new Blob(['bytes']);
        blob.slice = () => ({ arrayBuffer: () => Promise.reject(new Error('read failed')) });
        channel.receive(blob);
        channel.close();
        const result = await h.stop();
        expect(h.events().map(event => event.kind)).toEqual(['created', 'gap', 'closed']);
        expect(h.events()[1].reason).toBe('payload_read_failed');
        expect(result).toMatchObject({ captured_bytes: 0, pending_bytes: 0, reasons: ['payload_read_failed'] });
    });

    it('does not leak byte reservations when obtaining a Blob snapshot throws', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const blob = new Blob(['bytes']);
        blob.slice = () => { throw new Error('snapshot failure'); };
        channel.receive(blob);
        channel.close();
        const result = await h.stop();
        expect(result).toMatchObject({ captured_bytes: 0, pending_bytes: 0, reasons: ['payload_read_failed'] });
        expect(h.events().some(event => event.kind === 'gap' && event.reason === 'payload_read_failed')).toBe(true);
    });

    it('does not observe channels created before hook installation', async () => {
        const h = fixture();
        const peer = new h.original.peer();
        const channel = peer.createDataChannel('preexisting');
        channel.send('not attributable');
        await h.stop();
        expect(h.events()).toEqual([]);
    });
});

describe('WebTransport identity and normal stream use', () => {
    it('observes datagrams and outgoing bidi/uni without changing stream identities or reading ahead', async () => {
        const h = fixture();
        const transport = h.wt();
        const datagrams = transport.datagrams;
        expect(transport.datagrams).toBe(datagrams);
        await transport.ready;
        const output = datagrams.writable.getWriter();
        const input = datagrams.readable.getReader();
        await output.write(Uint8Array.from([0, 255]));
        transport.datagramInput.enqueue(Uint8Array.from([7, 8]));
        await tick();
        expect(h.events().filter(event => event.direction === 'received')).toHaveLength(0);
        const read = await input.read();
        expect(Array.from(read.value)).toEqual([7, 8]);
        const createBidi = transport.createBidirectionalStream();
        expect(createBidi).toBe(transport.lastCreate);
        const pair = await createBidi;
        expect(pair).toBe(transport.lastPair);
        const bidiWriter = pair.writable.getWriter();
        await bidiWriter.write(Uint8Array.from([1, 2]));
        transport.bidiReply.enqueue(Uint8Array.from([3, 4]));
        await pair.readable.getReader().read();
        const uni = await transport.createUnidirectionalStream();
        await new h.context.WritableStreamDefaultWriter(uni).write(Uint8Array.from([5, 6]));
        transport.close({ closeCode: 4, reason: 'done' });
        await tick();
        const result = await h.stop();
        const data = h.events().filter(event => ['message', 'chunk'].includes(event.kind));
        expect(data.map(event => [event.kind, event.direction, event.channel_id])).toEqual([
            ['message', 'sent', 'datagrams'], ['message', 'received', 'datagrams'],
            ['chunk', 'sent', 'bidi-1'], ['chunk', 'received', 'bidi-1'], ['chunk', 'sent', 'uni-2'],
        ]);
        expect(data.map(event => [...payloadBytes(event)])).toEqual([[0, 255], [7, 8], [1, 2], [3, 4], [5, 6]]);
        expect(result.reasons).toEqual([]);
        expect(h.events().at(-1)).toMatchObject({ kind: 'closed', metadata: { close_code: 4, reason: 'done' } });
        expect(transport.nativeCloseCalls).toBe(1);
    });

    it('tags incoming streams only when the application receives them', async () => {
        const h = fixture();
        const transport = h.wt();
        const incoming = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([1])); controller.close(); } });
        transport.uniInput.enqueue(incoming);
        const pair = { readable: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([2])); controller.close(); } }), writable: new WritableStream() };
        transport.bidiInput.enqueue(pair);
        await tick();
        expect(h.events().filter(event => event.kind === 'chunk')).toHaveLength(0);
        const uni = (await transport.incomingUnidirectionalStreams.getReader().read()).value;
        expect(uni).toBe(incoming);
        await new h.context.ReadableStreamDefaultReader(uni).read();
        const bidi = (await transport.incomingBidirectionalStreams.getReader().read()).value;
        expect(bidi).toBe(pair);
        await bidi.readable.getReader().read();
        await bidi.writable.getWriter().write(Uint8Array.from([3]));
        await h.stop();
        const data = h.events().filter(event => event.kind === 'chunk');
        expect(data.map(event => [event.direction, event.channel_id])).toEqual([['received', 'uni-1'], ['received', 'bidi-2'], ['sent', 'bidi-2']]);
        expect(data.map(event => [...payloadBytes(event)])).toEqual([[1], [2], [3]]);
        expect(transport.nativeCloseCalls).toBe(0);
    });

    it('records only delivered BYOB bytes and leaves native buffer transfer behavior intact', async () => {
        const h = fixture();
        const transport = h.wt();
        const reader = transport.datagrams.readable.getReader({ mode: 'byob' });
        const supplied = new Uint8Array(8);
        const read = reader.read(supplied);
        transport.datagramInput.enqueue(Uint8Array.from([0, 255, 5]));
        const result = await read;
        expect(supplied.byteLength).toBe(0);
        expect(Array.from(result.value)).toEqual([0, 255, 5]);
        result.value[0] = 88;
        await h.stop();
        const event = h.events().find(event => event.kind === 'message');
        expect(event).toMatchObject({ direction: 'received', channel_id: 'datagrams', bytes: 3 });
        expect(payloadBytes(event)).toEqual(Buffer.from([0, 255, 5]));
    });

    it('captures accepted write bytes before caller mutation and reports rejected writes without payload', async () => {
        const h = fixture();
        const transport = h.wt();
        const pending = deferred();
        transport.writeResult = pending.promise;
        const writer = transport.datagrams.writable.getWriter();
        const bytes = Uint8Array.from([3, 4]);
        const write = writer.write(bytes);
        bytes[0] = 99;
        await tick();
        expect(h.events().filter(event => event.kind === 'message')).toHaveLength(0);
        pending.resolve();
        await write;
        const rejected = deferred();
        transport.writeResult = rejected.promise;
        const badWrite = writer.write(Uint8Array.from([8]));
        rejected.reject(new Error('native sink rejected'));
        await expect(badWrite).rejects.toThrow('native sink rejected');
        await h.stop();
        const data = h.events().filter(event => event.kind === 'message');
        expect(data).toHaveLength(1);
        expect(payloadBytes(data[0])).toEqual(Buffer.from([3, 4]));
        expect(h.events().find(event => event.reason === 'native_write_rejected')).toMatchObject({ kind: 'error' });
        expect(h.events().find(event => event.reason === 'native_write_rejected').payload).toBeUndefined();
    });

    it('returns the exact native read and write promises without performing extra calls', async () => {
        const nativeRead = ReadableStreamDefaultReader.prototype.read;
        const nativeWrite = WritableStreamDefaultWriter.prototype.write;
        let lastRead;
        let lastWrite;
        let readCalls = 0;
        let writeCalls = 0;
        ReadableStreamDefaultReader.prototype.read = function (...args) { readCalls++; lastRead = nativeRead.apply(this, args); return lastRead; };
        WritableStreamDefaultWriter.prototype.write = function (...args) { writeCalls++; lastWrite = nativeWrite.apply(this, args); return lastWrite; };
        try {
            const h = fixture();
            const transport = h.wt();
            const writer = transport.datagrams.writable.getWriter();
            const write = writer.write(Uint8Array.from([1]));
            expect(write).toBe(lastWrite);
            await write;
            transport.datagramInput.enqueue(Uint8Array.from([2]));
            const reader = transport.datagrams.readable.getReader();
            const read = reader.read();
            expect(read).toBe(lastRead);
            await read;
            expect(writeCalls).toBe(1);
            expect(readCalls).toBe(1);
            await h.stop();
        } finally {
            ReadableStreamDefaultReader.prototype.read = nativeRead;
            WritableStreamDefaultWriter.prototype.write = nativeWrite;
        }
    });

    it('flags stream bypasses while preserving native pipe/tee/iterator behavior', async () => {
        const h = fixture();
        const transport = h.wt();
        const pipe = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([1])); controller.close(); } }).pipeTo(transport.datagrams.writable);
        await pipe;
        const pair = await transport.createBidirectionalStream();
        const branches = pair.readable.tee();
        transport.bidiReply.enqueue(Uint8Array.from([2]));
        transport.bidiReply.close();
        expect(Array.from((await branches[0].getReader().read()).value)).toEqual([2]);
        const iterator = transport.datagrams.readable[Symbol.asyncIterator]({ preventCancel: true });
        transport.datagramInput.enqueue(Uint8Array.from([3]));
        expect(Array.from((await iterator.next()).value)).toEqual([3]);
        await iterator.return();
        const throughPair = await transport.createBidirectionalStream();
        const through = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([4])); controller.close(); } }).pipeThrough(throughPair);
        expect(through).toBe(throughPair.readable);
        const stopped = await h.stop();
        expect(stopped.reasons).toEqual(expect.arrayContaining(['pipeTo_bypass', 'pipeThrough_bypass', 'tee_bypass', 'async_iterator_bypass']));
        expect(h.events().filter(event => event.kind === 'message' || event.kind === 'chunk')).toHaveLength(0);
    });

    it('does not invoke unrelated pipeThrough destination getters twice', async () => {
        const h = fixture();
        let getterCalls = 0;
        const writable = new WritableStream();
        const readable = new ReadableStream();
        const pair = { readable, get writable() { getterCalls++; return writable; } };
        const source = new ReadableStream({ start(controller) { controller.close(); } });
        expect(source.pipeThrough(pair)).toBe(readable);
        await tick();
        expect(getterCalls).toBe(1);
        await h.stop();
        expect(h.events()).toEqual([]);
    });
});

describe('observer capture and pending work limits', () => {
    it('keeps explicit byte-prefix gaps and original lengths across message and aggregate limits', async () => {
        const h = fixture({ maxMessageBytes: 3, maxBytes: 5 });
        const { channel } = h.rtc();
        channel.send('abcdef');
        channel.receive(Uint8Array.from([0, 1, 2, 3]));
        channel.close();
        const result = await h.stop();
        const data = h.events().filter(event => event.kind === 'message');
        expect(data[0]).toMatchObject({ payload: 'abc', bytes: 3, observed_bytes: 6, truncated: true, reason: 'message_byte_limit' });
        expect(data[1]).toMatchObject({ bytes: 2, observed_bytes: 4, truncated: true, reason: 'total_byte_limit' });
        expect(payloadBytes(data[1])).toEqual(Buffer.from([0, 1]));
        expect(result).toMatchObject({ captured_bytes: 5, observed_bytes: 10, pending_bytes: 0 });
        expect(h.events().filter(event => event.kind === 'gap').map(event => event.reason)).toEqual(['message_byte_limit', 'total_byte_limit']);
    });

    it('preserves large text as UTF-8 base64 and emits bounded envelopes', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const text = '\u0000😀'.repeat(300000);
        channel.send(text);
        channel.close();
        await h.stop();
        const message = h.events().find(event => event.kind === 'message');
        expect(message).toMatchObject({ payload_encoding: 'base64', metadata: { original_type: 'string' }, bytes: Buffer.byteLength(text) });
        expect(payloadBytes(message).toString()).toBe(text);
        expect(Math.max(...h.messages.map(message => Buffer.byteLength(message)))).toBeLessThan(16 * 1024 * 1024);
        expect(h.messages.length).toBeGreaterThan(1);
    });

    it('reserves an explicit event-limit gap and never exceeds its emission budget', async () => {
        const h = fixture({ maxEvents: 6 });
        const { channel } = h.rtc();
        for (let i = 0; i < 1000; i++) channel.send('message');
        channel.close();
        const result = await h.stop();
        expect(h.events()).toHaveLength(6);
        expect(h.events().at(-1)).toMatchObject({ kind: 'gap', reason: 'event_limit' });
        expect(result).toMatchObject({ scheduled_events: 6, emitted_events: 6, reasons: expect.arrayContaining(['event_limit']) });
        expect(result.dropped_events).toBeGreaterThan(990);
    });

    it('bounds queued payloads behind a Blob and releases them on timeout before reporting closed', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const blob = new Blob(['unresolved']);
        blob.slice = () => ({ arrayBuffer: () => new Promise(() => {}) });
        channel.send(blob);
        for (let i = 0; i < 1000; i++) channel.send('x'.repeat(1024));
        channel.close();
        const before = h.control.info();
        expect(before.pending_events).toBeLessThanOrEqual(256);
        expect(before.pending_bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        const started = performance.now();
        const result = await h.stop();
        expect(performance.now() - started).toBeLessThan(1500);
        expect(result).toMatchObject({ pending_events: 0, pending_bytes: 0, reasons: expect.arrayContaining(['pending_event_limit', 'pending_payload_timeout']) });
        expect(h.events()[1]).toMatchObject({ kind: 'gap', reason: 'pending_payload_timeout' });
        expect(h.events().some(event => event.kind === 'closed')).toBe(false);
    });

    it('stops publishing after binding failure without changing native send success', async () => {
        const h = fixture({}, { __binding() { throw new Error('binding unavailable'); } });
        const { channel } = h.rtc();
        channel.send('accepted');
        await tick();
        expect(() => channel.send('still accepted')).not.toThrow();
        const result = await h.stop();
        expect(channel.sent).toEqual(['accepted', 'still accepted']);
        expect(result.reasons).toContain('binding_failed');
        expect(result.emitted_events).toBe(0);
    });

    it('keeps observer buffers bounded across thousands of accepted messages', async () => {
        const h = fixture();
        const { channel } = h.rtc();
        const payload = 'x'.repeat(1024);
        const started = performance.now();
        for (let i = 0; i < 5000; i++) channel.send(payload);
        channel.close();
        const result = await h.stop();
        const elapsed = performance.now() - started;
        expect(result).toMatchObject({ emitted_events: 5002, captured_bytes: 5000 * 1024, pending_bytes: 0, pending_events: 0 });
        expect(result.peak_pending_bytes).toBe(1024);
        expect(result.peak_pending_events).toBe(1);
        expect(result.peak_batch_bytes).toBeLessThanOrEqual(256 * 1024);
        expect(h.batches.every(batch => batch.events.length <= 32)).toBe(true);
        console.log('transport observer stress fixture', JSON.stringify({ messages: 5000, elapsed_ms: Math.round(elapsed), messages_per_second: Math.round(5000000 / elapsed), peak_pending_payload_bytes: result.peak_pending_bytes, peak_batch_bytes: result.peak_batch_bytes }));
    });
});
