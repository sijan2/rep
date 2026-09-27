// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';
import { transportObserverSource } from '../js/background/transport-observer.js';

const active = [];
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const bytes = event => Buffer.from(event.payload || '', 'base64');
function mediaFixture(config = {}, recorderOptions = {}) {
    const packets = [];
    const context = createContext({ TextDecoder, TextEncoder, Blob, performance, btoa, queueMicrotask, setTimeout, clearTimeout,
        __binding: message => packets.push(JSON.parse(message)), recorderOptions,
    });
    runInContext(`
        class Target {
            constructor() { this.listeners = new Map(); }
            addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
            removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
            fire(type, fields = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...fields }); }
        }
        globalThis.MediaStreamTrack = class MediaStreamTrack extends Target {
            constructor(kind = 'audio', id = 'original') { super(); this.kind = kind; this.id = id; this.readyState = 'live'; this._enabled = true; this.muted = false; this.clones = []; this.stopCalls = 0; }
            get enabled() { return this._enabled; }
            set enabled(value) { this._enabled = Boolean(value); }
            getSettings() { return { width: 320, height: 180, frameRate: 15, sampleRate: 48000, channelCount: 1, deviceId: 'do not retain device identity' }; }
            clone() { if (this.rejectClone) throw new Error('clone rejected'); const copy = new MediaStreamTrack(this.kind, this.id + '-clone'); copy.enabled = this.enabled; this.clones.push(copy); return copy; }
            stop() { this.stopCalls++; this.readyState = 'ended'; }
            end() { this.readyState = 'ended'; this.fire('ended'); }
        };
        globalThis.MediaStream = class MediaStream { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };
        globalThis.MediaRecorder = class MediaRecorder extends Target {
            static instances = [];
            static isTypeSupported(type) { return type.includes('webm'); }
            constructor(stream, options) { super(); if (recorderOptions.rejectConstructor) throw new Error('constructor rejected'); this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive'; this.stopCalls = 0; this.options = { ...recorderOptions }; MediaRecorder.instances.push(this); }
            start(timeslice) { if (this.options.rejectStart) throw new Error('start rejected'); this.timeslice = timeslice; this.state = 'recording'; queueMicrotask(() => this.fire('start')); }
            chunk(value, timecode = 1) { this.fire('dataavailable', { data: value instanceof Blob ? value : new Blob([value], { type: this.mimeType }), timecode }); }
            stop() { this.stopCalls++; if (this.options.rejectStop) throw new Error('stop rejected'); this.state = 'inactive'; if (this.options.missingStop) return; queueMicrotask(() => { this.chunk(this.finalBlob || 'FINAL', 99); this.fire('stop'); }); }
        };
        globalThis.RTCRtpSender = class RTCRtpSender {
            constructor(track) { this.track = track; }
            replaceTrack(track) { this.lastPromise = this.rejectReplace ? Promise.reject(new Error('replace rejected')) : Promise.resolve().then(() => { this.track = track; }); return this.lastPromise; }
        };
        globalThis.RTCPeerConnection = class RTCPeerConnection extends Target {
            constructor(options = {}) { super(); this.senders = []; this.receivers = options.receivers || []; this.connectionState = 'new'; }
            addTrack(track) { const sender = new RTCRtpSender(track); this.senders.push(sender); return sender; }
            addTransceiver(track) { const sender = new RTCRtpSender(typeof track === 'string' ? null : track); this.senders.push(sender); return { sender }; }
            getSenders() { return this.senders; }
            getReceivers() { return this.receivers; }
            receive(track) { const receiver = { track }; this.receivers.push(receiver); this.fire('track', { track, receiver }); return receiver; }
            removeTrack(sender) { sender.track = null; }
            close() { this.connectionState = 'closed'; }
        };
        const target = new Target();
        globalThis.addEventListener = target.addEventListener.bind(target);
        globalThis.removeEventListener = target.removeEventListener.bind(target);
        globalThis.firePageEvent = target.fire.bind(target);
        if (recorderOptions.lockEnabled) Object.defineProperty(MediaStreamTrack.prototype, 'enabled', { ...Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled'), configurable: false });
        if (recorderOptions.unavailable) globalThis.MediaRecorder = undefined;
    `, context);
    const settings = { bindingName: '__binding', controlName: '__observer', token: 'media-test', protocolPayloads: false, webrtcMedia: true, ...config };
    const original = { addTrack: context.RTCPeerConnection.prototype.addTrack, replaceTrack: context.RTCRtpSender.prototype.replaceTrack,
        enabled: Object.getOwnPropertyDescriptor(context.MediaStreamTrack.prototype, 'enabled') };
    const installed = runInContext(transportObserverSource(settings), context);
    const h = { context, installed, original, packets, control: context.__observer,
        events: () => packets.flatMap(packet => packet.events),
        track: (kind = 'audio', id = 'original') => new context.MediaStreamTrack(kind, id),
        peer: options => new context.RTCPeerConnection(options),
        recorders: () => context.MediaRecorder.instances,
        stop: () => h.control.stop(),
    };
    active.push(h);
    return h;
}
afterEach(async () => {
    try { for (const h of active.splice(0).reverse()) await h.stop(); }
    finally { vi.useRealTimers(); }
});

describe('native WebRTC media recording', () => {
    it('records existing outgoing and incoming track clones and emits final data before closed', async () => {
        const h = mediaFixture();
        expect(h.installed.capabilities).toMatchObject({ webrtc: false, webtransport: false, webrtc_media: true });
        const outgoing = h.track('video', 'send-video'), incoming = h.track('audio', 'receive-audio');
        const peer = h.peer();
        peer.addTrack(outgoing);
        peer.receive(incoming);
        await tick();
        for (const recorder of h.recorders()) recorder.chunk('HEAD');
        const result = await h.stop();
        expect(result).toMatchObject({ media_recordings_created: 2, media_recordings_closed: 2, media_active: 0, pending: 0, reasons: [] });
        const created = h.events().filter(event => event.kind === 'created');
        expect(created.map(event => event.metadata.track_id)).toEqual(['send-video', 'receive-audio']);
        expect(created.map(event => event.metadata.direction)).toEqual(['sent', 'received']);
        expect(created[0]).toMatchObject({ protocol: 'webrtc_media', metadata: { semantics: 'reencoded_media', source: 'browser_media_recorder', scope: 'recorded_media_interval', mime_type: 'video/webm;codecs=vp8', time_origin_ms: expect.any(Number), observer_limits: { maxMediaTracks: 8, maxMediaBytes: 4 * 1024 * 1024 } } });
        expect(created[0].metadata.settings.deviceId).toBeUndefined();
        for (const start of created) {
            const events = h.events().filter(event => event.connection_id === start.connection_id);
            const chunks = events.filter(event => event.kind === 'chunk');
            expect(chunks.map(event => event.metadata.chunk_index)).toEqual([1, 2]);
            expect(Buffer.concat(chunks.map(bytes)).toString()).toBe('HEADFINAL');
            expect(events.at(-1)).toMatchObject({ kind: 'closed', metadata: { stop_reason: 'capture_ended', recorder_finalized: true, chunk_count: 2 } });
        }
        for (const original of [outgoing, incoming]) {
            expect(original.stopCalls).toBe(0);
            expect(original.readyState).toBe('live');
            expect(original.clones).toHaveLength(1);
            expect(original.clones[0].stopCalls).toBe(1);
        }
        expect(h.context.RTCPeerConnection.prototype.addTrack).toBe(h.original.addTrack);
        expect(h.context.RTCRtpSender.prototype.replaceTrack).toBe(h.original.replaceTrack);
    });

    it('mirrors original enabled changes to owned clones and restores the native descriptor', async () => {
        const h = mediaFixture();
        const track = h.track();
        h.peer().addTrack(track);
        const clone = track.clones[0];
        track.enabled = false;
        expect(track.enabled).toBe(false);
        expect(clone.enabled).toBe(false);
        track.enabled = true;
        expect(track.enabled).toBe(true);
        expect(clone.enabled).toBe(true);
        await h.stop();
        expect(Object.getOwnPropertyDescriptor(h.context.MediaStreamTrack.prototype, 'enabled')).toEqual(h.original.enabled);
        expect(h.events().filter(event => event.metadata?.track_event === 'enabled_changed').map(event => event.metadata.enabled)).toEqual([false, true]);
        expect(track.stopCalls).toBe(0);
    });

    it('preserves delayed final Blob reads before closing a track interval', async () => {
        const h = mediaFixture();
        h.peer().addTrack(h.track());
        let release;
        const blob = new Blob(['tail']);
        blob.slice = () => ({ arrayBuffer: () => new Promise(resolve => { release = resolve; }) });
        h.recorders()[0].finalBlob = blob;
        const stop = h.stop();
        await tick();
        expect(h.events().some(event => event.kind === 'closed')).toBe(false);
        release(Uint8Array.from([116, 97, 105, 108]).buffer);
        await stop;
        expect(bytes(h.events().find(event => event.kind === 'chunk')).toString()).toBe('tail');
        expect(h.events().at(-1).kind).toBe('closed');
    });

    it('gates a clone for initial mute and mute changes without overriding application disable', async () => {
        const h = mediaFixture();
        const track = h.track();
        track.muted = true;
        h.peer().addTrack(track);
        const clone = track.clones[0];
        expect(clone.enabled).toBe(false);
        track.muted = false;
        track.fire('unmute');
        expect(clone.enabled).toBe(true);
        track.muted = true;
        track.fire('mute');
        expect(clone.enabled).toBe(false);
        track.enabled = true;
        expect(clone.enabled).toBe(false);
        track.enabled = false;
        track.muted = false;
        track.fire('unmute');
        expect(clone.enabled).toBe(false);
        expect(track.enabled).toBe(false);
        await h.stop();
        expect(h.events().filter(event => ['mute', 'unmute'].includes(event.metadata?.track_event)).map(event => event.metadata.muted)).toEqual([false, true, false]);
        expect(track.stopCalls).toBe(0);
    });

    it('keeps enabled-state mirroring active until the native recorder has finalized', async () => {
        const h = mediaFixture({}, { missingStop: true });
        const track = h.track();
        h.peer().addTrack(track);
        await tick();
        const stopping = h.stop();
        track.enabled = false;
        expect(track.clones[0].enabled).toBe(false);
        h.recorders()[0].chunk('FINAL');
        h.recorders()[0].fire('stop');
        await stopping;
        expect(h.events().find(event => event.metadata?.track_event === 'enabled_changed').metadata.enabled).toBe(false);
        expect(Object.getOwnPropertyDescriptor(h.context.MediaStreamTrack.prototype, 'enabled')).toEqual(h.original.enabled);
        expect(track.stopCalls).toBe(0);
    });

    it('starts receivers already present on a newly observed peer and avoids duplicate incoming events', async () => {
        const h = mediaFixture();
        const track = h.track('audio', 'existing-receiver');
        const receiver = { track };
        const peer = h.peer({ receivers: [receiver] });
        peer.fire('track', { track, receiver });
        expect(h.recorders()).toHaveLength(1);
        await h.stop();
        expect(h.events().filter(event => event.kind === 'created')).toHaveLength(1);
    });

    it('ends prior outgoing intervals only after accepted replaceTrack and supports transceivers', async () => {
        const h = mediaFixture();
        const first = h.track('audio', 'first'), second = h.track('audio', 'second');
        const peer = h.peer();
        const { sender } = peer.addTransceiver(first);
        const replace = sender.replaceTrack(second);
        expect(replace).toBe(sender.lastPromise);
        await replace;
        await tick();
        expect(h.recorders()).toHaveLength(2);
        expect(first.clones[0].stopCalls).toBe(1);
        expect(first.stopCalls).toBe(0);
        sender.rejectReplace = true;
        await expect(sender.replaceTrack(first)).rejects.toThrow('replace rejected');
        expect(h.recorders()).toHaveLength(2);
        await h.stop();
        expect(h.events().filter(event => event.kind === 'closed').map(event => event.metadata.stop_reason)).toEqual(['track_replaced', 'capture_ended']);
    });

    it('deduplicates a track across senders and waits for the last owner to be removed', async () => {
        const h = mediaFixture();
        const peer = h.peer(), track = h.track();
        const one = peer.addTrack(track), two = peer.addTransceiver(track).sender;
        expect(h.recorders()).toHaveLength(1);
        peer.removeTrack(one);
        expect(h.recorders()[0].stopCalls).toBe(0);
        peer.removeTrack(two);
        await tick();
        expect(h.recorders()[0].stopCalls).toBe(1);
        expect(track.stopCalls).toBe(0);
        await h.stop();
        expect(h.events().at(-1).metadata.stop_reason).toBe('track_removed');
    });

    it('honors original end and native stop while never stopping original tracks itself', async () => {
        const h = mediaFixture();
        const peer = h.peer(), ended = h.track('audio', 'ended'), stopped = h.track('video', 'stopped');
        peer.addTrack(ended); peer.addTrack(stopped);
        ended.end();
        stopped.stop();
        await tick();
        await h.stop();
        expect(ended.stopCalls).toBe(0);
        expect(stopped.stopCalls).toBe(1);
        expect(ended.clones[0].stopCalls).toBe(1);
        expect(stopped.clones[0].stopCalls).toBe(1);
        expect(h.events().filter(event => event.kind === 'closed').every(event => event.metadata.stop_reason === 'track_ended')).toBe(true);
    });

    it('enforces active track and byte limits with explicit partial intervals', async () => {
        const h = mediaFixture({ maxMediaTracks: 1, maxMediaBytes: 3 });
        const peer = h.peer(), first = h.track('audio', 'first'), second = h.track('audio', 'second');
        peer.addTrack(first); peer.addTrack(second);
        expect(h.recorders()).toHaveLength(1);
        expect(second.clones).toHaveLength(0);
        h.recorders()[0].chunk('TOO LONG');
        await tick();
        const result = await h.stop();
        expect(result.reasons).toEqual(expect.arrayContaining(['media_track_limit', 'media_byte_limit']));
        const chunks = h.events().filter(event => event.kind === 'chunk');
        expect(chunks[0]).toMatchObject({ bytes: 3, observed_bytes: 8, truncated: true, reason: 'media_byte_limit' });
        expect(bytes(chunks[0]).toString()).toBe('TOO');
        expect(first.stopCalls).toBe(0);
    });

    it('bounds duration and permits a new track after a recorder has finalized', async () => {
        const h = mediaFixture({ maxMediaTracks: 1, maxMediaDurationMs: 100 });
        const peer = h.peer();
        peer.addTrack(h.track('audio', 'one'));
        await new Promise(resolve => setTimeout(resolve, 120));
        peer.addTrack(h.track('video', 'two'));
        expect(h.recorders()).toHaveLength(2);
        const result = await h.stop();
        expect(result.reasons).toContain('media_duration_limit');
        expect(h.events().some(event => event.kind === 'gap' && event.reason === 'media_duration_limit')).toBe(true);
    });

    it('reports recorder setup failures and cleans only successful clones', async () => {
        const h = mediaFixture({}, { rejectConstructor: true });
        const track = h.track();
        h.peer().addTrack(track);
        await h.stop();
        expect(h.events().find(event => event.kind === 'error').reason).toBe('media_recorder_setup_failed');
        expect(track.stopCalls).toBe(0);
        expect(track.clones[0].stopCalls).toBe(1);
    });

    it('refuses recording when track-enabled changes cannot be safely mirrored', async () => {
        const h = mediaFixture({}, { lockEnabled: true });
        const track = h.track();
        h.peer().addTrack(track);
        const result = await h.stop();
        expect(h.installed.capabilities.webrtc_media).toBe(false);
        expect(result.reasons).toContain('media_enabled_hook_unavailable');
        expect(track.clones).toHaveLength(0);
        expect(track.stopCalls).toBe(0);
    });

    it('reports unavailable native recording APIs without activating media', async () => {
        const h = mediaFixture({}, { unavailable: true });
        const track = h.track();
        h.peer().addTrack(track);
        const result = await h.stop();
        expect(h.installed.capabilities.webrtc_media).toBe(false);
        expect(result.reasons).toContain('media_recorder_unavailable');
        expect(track.clones).toHaveLength(0);
    });

    it('rejects an invalid clone identity without stopping the original', async () => {
        const h = mediaFixture();
        const track = h.track();
        track.clone = () => track;
        h.peer().addTrack(track);
        await h.stop();
        expect(track.stopCalls).toBe(0);
        expect(h.events().some(event => event.reason === 'media_recorder_setup_failed')).toBe(true);
    });

    it('finishes missing recorder stop events within the deadline with a gap', async () => {
        const h = mediaFixture({}, { missingStop: true });
        const track = h.track();
        h.peer().addTrack(track);
        const started = performance.now();
        const result = await h.stop();
        expect(performance.now() - started).toBeLessThan(1200);
        expect(result.reasons).toContain('media_stop_timeout');
        expect(h.events().at(-1)).toMatchObject({ kind: 'closed', metadata: { recorder_finalized: false } });
        expect(track.stopCalls).toBe(0);
        expect(track.clones[0].stopCalls).toBe(1);
    });

    it.each([{ missingStop: true }, { rejectStop: true }])('releases a bounded interval during an ongoing capture when native stop fails: %j', async recorderOptions => {
        vi.useFakeTimers();
        const h = mediaFixture({ maxMediaDurationMs: 100 }, recorderOptions);
        const track = h.track();
        h.peer().addTrack(track);
        await vi.advanceTimersByTimeAsync(100);
        expect(h.control.info().media_active).toBe(1);
        await vi.advanceTimersByTimeAsync(750);
        expect(h.control.info()).toMatchObject({ stopped: false, media_active: 0, media_recordings_closed: 1 });
        expect(h.events().at(-1)).toMatchObject({ kind: 'closed', metadata: { stop_reason: 'media_duration_limit', recorder_finalized: false } });
        expect(h.control.info().reasons).toContain('media_stop_timeout');
        expect(track.clones[0].stopCalls).toBe(1);
        expect(track.stopCalls).toBe(0);
    });

    it('distinguishes a synchronous recorder start failure from a stop timeout', async () => {
        const h = mediaFixture({}, { rejectStart: true });
        const track = h.track();
        h.peer().addTrack(track);
        const result = await h.stop();
        expect(result.reasons).toContain('media_recorder_start_failed');
        expect(result.reasons).not.toContain('media_stop_timeout');
        expect(h.events().at(-1)).toMatchObject({ kind: 'closed', metadata: { stop_reason: 'media_recorder_start_failed', recorder_finalized: false } });
        expect(track.clones[0].stopCalls).toBe(1);
        expect(track.stopCalls).toBe(0);
    });

    it('marks recorder errors and page unload as gaps while preserving final chunks', async () => {
        const h = mediaFixture();
        const peer = h.peer();
        peer.addTrack(h.track('audio', 'error'));
        peer.addTrack(h.track('video', 'unload'));
        h.recorders()[0].fire('error', { error: new Error('native encoder failed') });
        h.context.firePageEvent('pagehide');
        await tick();
        const result = await h.stop();
        expect(result.reasons).toEqual(expect.arrayContaining(['media_recorder_error', 'media_context_unload']));
        expect(h.events().filter(event => event.kind === 'chunk')).toHaveLength(2);
    });
});
