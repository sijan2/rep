// This source runs in an explicitly selected page/worker realm. It observes API
// data already used by the application; it never reads ahead or changes streams.
export function transportObserverSource(config = {}) {
    return `(${installTransportObserver.toString()})(${JSON.stringify(config)})`;
}

function installTransportObserver(config) {
    const root = globalThis;
    const bindingName = config.bindingName;
    const controlName = config.controlName;
    if (typeof bindingName !== 'string' || typeof controlName !== 'string' || !controlName ||
        bindingName.length > 256 || controlName.length > 256 ||
        typeof config.token !== 'string' || config.token.length > 256 || typeof root[bindingName] !== 'function') {
        return { installed: false, reason: 'invalid_observer_config' };
    }
    if (Object.prototype.hasOwnProperty.call(root, controlName)) {
        if (root[controlName]?.token === config.token && typeof root[controlName]?.info === 'function') return root[controlName].info();
        return { installed: false, reason: 'observer_control_exists' };
    }
    const finiteLimit = (value, fallback, maximum, minimum = 0) => Number.isFinite(value)
        ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
    const protocolPayloads = config.protocolPayloads !== false;
    const mediaEnabled = config.webrtcMedia === true;
    const limits = {
        maxEvents: finiteLimit(config.maxEvents, 10000, 100000, 1),
        maxBytes: finiteLimit(config.maxBytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
        maxMessageBytes: finiteLimit(config.maxMessageBytes, 8 * 1024 * 1024, 8 * 1024 * 1024),
        maxPendingBytes: 16 * 1024 * 1024,
        maxPendingEvents: 256,
        maxBatchBytes: 256 * 1024,
        maxEnvelopeBytes: 16 * 1024 * 1024,
        maxMediaTracks: finiteLimit(config.maxMediaTracks, 8, 8, 1),
        maxMediaDurationMs: finiteLimit(config.maxMediaDurationMs, 60000, 60000, 100),
        maxMediaBytes: finiteLimit(config.maxMediaBytes, 4 * 1024 * 1024, 4 * 1024 * 1024),
        mediaTimesliceMs: 250,
        mediaStopTimeoutMs: 750,
    };
    limits.maxPendingBytes = Math.min(limits.maxBytes, limits.maxPendingBytes);
    const limitations = [
        'application_api_observation_not_wire_packets',
        'preexisting_objects_and_uninstrumented_realms_not_observed',
        'cached_native_methods_and_page_code_can_bypass_or_forge_observation',
        'token_is_correlation_not_authentication',
        ...(mediaEnabled ? [
            'media_recorder_reencodes_existing_tracks_not_original_rtp_frames',
            'media_scope_is_recorded_interval_not_entire_call',
            'media_encoders_can_add_cpu_cost_and_native_buffers_are_not_byte_bounded',
            'media_timers_and_timeslices_can_be_delayed_by_browser_scheduling',
            'media_cleanup_requires_a_responsive_execution_context',
        ] : ['media_payloads_not_observed']),
        'stream_piping_tee_async_iteration_and_transfer_may_bypass_payload_capture',
        'pipeThrough_accessor_destinations_can_bypass_gap_detection',
        'native_buffers_and_page_allocations_are_outside_observer_limits',
        'promise_observation_can_affect_unhandled_rejection_reporting',
        'accepted_send_does_not_prove_remote_delivery',
        'write_argument_snapshots_precede_async_acceptance_and_can_differ_if_callers_mutate_buffers',
        'observed_byte_count_is_a_lower_bound_after_events_are_dropped',
    ];
    const binding = root[bindingName];
    const stringify = JSON.stringify;
    const apply = Reflect.apply;
    const then = Promise.prototype.then;
    const encode = new TextEncoder();
    const decode = new TextDecoder('utf-8', { ignoreBOM: true });
    const encodeBase64 = root.btoa.bind(root);
    const nativeBase64 = Uint8Array.prototype.toBase64;
    const schedule = typeof root.queueMicrotask === 'function'
        ? root.queueMicrotask.bind(root) : fn => Promise.resolve().then(fn);
    const timer = root.setTimeout.bind(root);
    const clearTimer = root.clearTimeout.bind(root);
    const now = () => root.performance.now() / 1000;
    const timeOrigin = Number.isFinite(root.performance.timeOrigin) ? root.performance.timeOrigin : undefined;
    const channels = new WeakMap();
    const peers = new WeakMap();
    const transports = new WeakMap();
    const datagrams = new WeakMap();
    const streamPairs = new WeakMap();
    const streams = new WeakMap();
    const readers = new WeakMap();
    const writers = new WeakMap();
    const active = new Set();
    const peerStates = new Set();
    const restores = [];
    const reasons = new Set();
    const pendingTasks = new Set();
    const mediaRecordings = new Set();
    const senderMedia = new WeakMap();
    const originalMedia = new WeakMap();
    const nativeRecorder = root.MediaRecorder;
    const nativeMediaStream = root.MediaStream;
    const mediaAvailable = typeof nativeRecorder === 'function' && typeof nativeMediaStream === 'function';
    let mediaEnabledHookAvailable = false;
    let mediaEnabledDescriptor;
    let mediaStopping = false;
    let mediaCreated = 0;
    let mediaClosed = 0;
    let observing = true;
    let stopped = false;
    let failed = false;
    let stopPromise;
    let nextID = 0;
    let scheduledEvents = 0;
    let emittedEvents = 0;
    let droppedEvents = 0;
    let observedBytes = 0;
    let capturedBytes = 0;
    let reservedBytes = 0;
    let pendingBytes = 0;
    let pendingEvents = 0;
    let peakPendingBytes = 0;
    let peakPendingEvents = 0;
    let batch = [];
    let batchBytes = 0;
    let peakBatchBytes = 0;
    let flushScheduled = false;
    let batchSequence = 0;
    let eventLimitReported = false;
    const envelopePrefix = `{"token":${stringify(config.token)},"events":[`;
    const utf8Length = value => {
        let size = 0;
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code < 0x80) size++;
            else if (code < 0x800) size += 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
                value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
            else size += 3;
        }
        return size;
    };
    const envelopeOverhead = utf8Length(envelopePrefix) + 64;
    const short = (value, maximum = 256) => typeof value === 'string' ? value.slice(0, maximum) : undefined;
    const errorName = error => short(error?.name) || 'Error';
    const safely = fn => { try { return fn(); } catch (_) { reasons.add('observer_error'); return undefined; } };
    const onPromise = (promise, success, failure = () => {}) => {
        try {
            apply(then, promise, [value => safely(() => success(value)), error => safely(() => failure(error))]);
        } catch (_) { reasons.add('non_native_promise'); }
        return promise;
    };
    function flush() {
        flushScheduled = false;
        if (!batch.length) return;
        const message = `${envelopePrefix}${batch.join(',')}],"batch_sequence":${++batchSequence}}`;
        const count = batch.length;
        batch = [];
        batchBytes = 0;
        if (failed) { droppedEvents += count; return; }
        try { binding(message); emittedEvents += count; }
        catch (_) { failed = true; droppedEvents += count; reasons.add('binding_failed'); }
    }
    function publish(event) {
        if (failed) { droppedEvents++; return; }
        const serialized = stringify(event);
        const size = utf8Length(serialized);
        if (size + envelopeOverhead > limits.maxEnvelopeBytes) {
            droppedEvents++;
            reasons.add('binding_message_limit');
            return;
        }
        if (batch.length && (batch.length >= 32 || batchBytes + size + envelopeOverhead + 1 > limits.maxBatchBytes)) flush();
        batch.push(serialized);
        batchBytes += size + 1;
        peakBatchBytes = Math.max(peakBatchBytes, batchBytes + envelopeOverhead);
        if (batchBytes + envelopeOverhead >= limits.maxBatchBytes) flush();
        else if (!flushScheduled) { flushScheduled = true; schedule(flush); }
    }
    function cleanListeners(state) {
        for (const remove of state.listeners) safely(remove);
        state.listeners.length = 0;
    }
    function drain(state) {
        while (state.head < state.queue.length && state.queue[state.head].ready) {
            const slot = state.queue[state.head++];
            pendingEvents--;
            pendingBytes -= slot.heldBytes || 0;
            if (slot.event.payload !== undefined) capturedBytes += slot.event.bytes || 0;
            publish(slot.event);
            if (slot.event.kind === 'closed') {
                state.closed = true;
                active.delete(state);
                state.peer?.channels.delete(state);
                cleanListeners(state);
            }
        }
        if (state.head === state.queue.length) { state.queue = []; state.head = 0; }
    }
    function slotFor(state, kind, fields = {}, terminal = false) {
        if (failed || stopped || (!observing && !terminal) || (state.ended && !terminal)) return null;
        if (scheduledEvents >= limits.maxEvents - 1) {
            droppedEvents++;
            reasons.add('event_limit');
            if (!eventLimitReported && scheduledEvents < limits.maxEvents) {
                eventLimitReported = true;
                scheduledEvents++;
                // This final slot follows any earlier Blob data from this connection.
                state.queue.push({ ready: true, event: {
                    connection_id: state.id, protocol: state.protocol, kind: 'gap', timestamp: now(), reason: 'event_limit',
                } });
                pendingEvents++;
                drain(state);
            }
            return null;
        }
        if (pendingEvents >= limits.maxPendingEvents) {
            droppedEvents++;
            reasons.add('pending_event_limit');
            state.pendingGap = 'pending_event_limit';
            return null;
        }
        scheduledEvents++;
        pendingEvents++;
        peakPendingEvents = Math.max(peakPendingEvents, pendingEvents);
        const slot = { ready: false, heldBytes: 0, event: {
            connection_id: state.id, protocol: state.protocol, kind, timestamp: now(), ...fields,
        } };
        state.queue.push(slot);
        return slot;
    }
    function emit(state, kind, fields = {}, terminal = false) {
        const slot = slotFor(state, kind, fields, terminal);
        if (!slot) return;
        slot.ready = true;
        drain(state);
    }
    function gap(state, reason, fields = {}) {
        reasons.add(reason);
        if (state.gaps.has(reason)) return;
        state.gaps.add(reason);
        emit(state, 'gap', { ...fields, reason }, !observing);
    }
    function listen(object, type, listener, state) {
        object.addEventListener(type, listener);
        state.listeners.push(() => object.removeEventListener(type, listener));
    }
    function newState(protocol, metadata) {
        if (!observing || failed) return null;
        if (active.size >= limits.maxEvents || scheduledEvents >= limits.maxEvents - 1) {
            reasons.add('event_limit'); droppedEvents++; return null;
        }
        const state = {
            id: `${protocol}-${++nextID}`, protocol, queue: [], head: 0,
            listeners: [], gaps: new Set(), ended: false, closed: false, nextStream: 0,
        };
        active.add(state);
        emit(state, 'created', { metadata: {
            ...metadata, time_origin_ms: timeOrigin, source: metadata.source || 'page_api_observer',
            observer_limits: { ...limits }, observer_limitations: [...limitations],
        } });
        return state;
    }
    function base64(bytes) {
        if (typeof nativeBase64 === 'function') return apply(nativeBase64, bytes, []);
        let value = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
            value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return encodeBase64(value);
    }
    function snapshot(value, extraLimit = Infinity, extraReason = 'message_byte_limit') {
        let length;
        let type;
        let bytes;
        if (typeof value === 'string') { length = utf8Length(value); type = 'string'; }
        else if (ArrayBuffer.isView(value)) { length = value.byteLength; type = 'binary'; }
        else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') { length = value.byteLength; type = 'binary'; }
        else if (typeof root.Blob === 'function' && value instanceof root.Blob) { length = value.size; type = 'blob'; }
        else return { length: 0, kept: 0, reason: 'unsupported_payload_type' };
        const kept = Math.min(length, limits.maxMessageBytes, extraLimit, Math.max(0, limits.maxBytes - reservedBytes), Math.max(0, limits.maxPendingBytes - pendingBytes));
        const reason = kept < length
            ? (limits.maxBytes - reservedBytes <= kept ? 'total_byte_limit'
                : limits.maxPendingBytes - pendingBytes <= kept ? 'pending_byte_limit'
                    : extraLimit <= kept ? extraReason : 'message_byte_limit') : '';
        if (type === 'string') {
            bytes = new Uint8Array(kept);
            const result = encode.encodeInto(value, bytes);
            bytes = bytes.subarray(0, result.written);
        } else if (type === 'binary') {
            const source = ArrayBuffer.isView(value)
                ? new Uint8Array(value.buffer, value.byteOffset, kept) : new Uint8Array(value, 0, kept);
            bytes = source.slice();
        }
        const actual = bytes ? bytes.byteLength : kept;
        let payload;
        if (type === 'blob') {
            const piece = value.slice(0, kept);
            payload = piece.arrayBuffer().then(buffer => ({ payload: base64(new Uint8Array(buffer)), payload_encoding: 'base64', bytes: buffer.byteLength }));
        } else {
            const useText = type === 'string' && actual <= 16 * 1024;
            payload = { payload: useText ? decode.decode(bytes) : base64(bytes), payload_encoding: useText ? 'utf-8' : 'base64', bytes: actual };
        }
        reservedBytes += actual;
        pendingBytes += actual;
        peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
        return { length, kept: actual, payload, reason: reason || (actual < length ? 'message_byte_limit' : ''), type };
    }
    function observeData(state, kind, direction, value, channelID, acceptance, details = {}) {
        const slot = slotFor(state, kind, { direction, ...(channelID ? { channel_id: channelID } : {}) }, details.terminal === true);
        if (!slot) return { accepted: false, bytes: 0, reason: 'event_limit' };
        let snap;
        try { snap = snapshot(value, details.maxBytes, details.limitReason); }
        catch (_) { snap = { length: 0, kept: 0, reason: 'payload_read_failed' }; }
        slot.heldBytes = snap.kept;
        if (snap.reason) gap(state, snap.reason, { ...(channelID ? { channel_id: channelID } : {}) });
        const finish = (payload, failureReason = '') => {
            if (slot.ready) return;
            if (failureReason) {
                reservedBytes -= snap.kept;
                slot.event = { ...slot.event, kind: failureReason === 'native_write_rejected' ? 'error' : 'gap', reason: failureReason };
                reasons.add(failureReason);
            } else {
                observedBytes += snap.length;
                if (payload) Object.assign(slot.event, payload);
                slot.event.observed_bytes = snap.length;
                slot.event.metadata = {
                    ...details.metadata,
                    original_type: snap.type, observed_bytes: snap.length,
                    payload_stage: details.payloadStage || (acceptance ? 'write_argument_snapshot' : direction === 'sent' ? 'accepted_send_argument' : 'delivered_value'),
                };
                if (snap.reason) {
                    reasons.add(snap.reason);
                    slot.event.reason = snap.reason;
                    slot.event.truncated = true;
                    slot.event.metadata.truncated = true;
                }
            }
            slot.payload = undefined;
            slot.ready = true;
            drain(state);
            if (state.pendingGap) { const reason = state.pendingGap; state.pendingGap = ''; gap(state, reason); }
        };
        // A synchronous snapshot prevents callers mutating their buffer before a
        // writer promise settles. Only a fulfilled native write becomes sent data.
        if (acceptance || typeof snap.payload?.then === 'function') {
            let resolveTask;
            const task = new Promise(resolve => { resolveTask = resolve; });
            pendingTasks.add(task);
            const complete = () => {
                if (!slot.ready && slot.accepted && slot.payloadReady) finish(slot.payload);
                if (slot.ready) { pendingTasks.delete(task); resolveTask(); }
            };
            const fail = reason => { finish(undefined, reason); complete(); };
            slot.accepted = !acceptance;
            if (typeof snap.payload?.then === 'function') onPromise(snap.payload, payload => {
                if (!slot.ready) { slot.payload = payload; slot.payloadReady = true; }
                complete();
            }, () => fail('payload_read_failed'));
            else { slot.payload = snap.payload; slot.payloadReady = true; }
            snap.payload = undefined;
            if (acceptance) onPromise(acceptance, () => { slot.accepted = true; complete(); }, () => fail('native_write_rejected'));
            slot.cancel = () => {
                if (slot.ready) return;
                reservedBytes -= snap.kept;
                slot.event = { ...slot.event, kind: 'gap', reason: 'pending_payload_timeout' };
                slot.payload = undefined;
                reasons.add('pending_payload_timeout');
                droppedEvents++;
                slot.ready = true;
                complete();
            };
        } else finish(snap.payload);
        return { accepted: true, bytes: snap.kept, reason: snap.reason };
    }
    function closeState(state, fields = {}, terminal = false) {
        if (!state || state.ended || (!observing && !terminal)) return;
        emit(state, 'closed', fields, terminal);
        state.ended = true;
    }
    function patch(object, key, build) {
        if (!object) return false;
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || typeof descriptor.value !== 'function') return false;
        try {
            const wrapper = build(descriptor.value);
            Object.defineProperty(object, key, { ...descriptor, value: wrapper });
            restores.push(() => {
                if (Object.getOwnPropertyDescriptor(object, key)?.value === wrapper) Object.defineProperty(object, key, descriptor);
            });
            return true;
        } catch (_) { reasons.add('hook_unavailable'); return false; }
    }
    function constructor(name, observe) {
        return patch(root, name, Native => new Proxy(Native, {
            construct(target, args, newTarget) {
                const object = Reflect.construct(target, args, newTarget);
                if (observing) safely(() => observe(object, args));
                return object;
            },
        }));
    }
    const channelMetadata = channel => ({
        label: short(channel.label, 1024), id: Number.isFinite(channel.id) ? channel.id : undefined,
        ordered: typeof channel.ordered === 'boolean' ? channel.ordered : undefined,
        negotiated: typeof channel.negotiated === 'boolean' ? channel.negotiated : undefined,
        protocol: short(channel.protocol), max_retransmits: channel.maxRetransmits ?? null,
        max_packet_life_time: channel.maxPacketLifeTime ?? null,
    });
    function trackChannel(channel, peer, origin) {
        if (!protocolPayloads || !channel || channels.has(channel) || !peer) return;
        const state = newState('webrtc', { ...channelMetadata(channel), parent_peer_id: peer.id, origin });
        if (!state) return;
        state.peer = peer;
        peer.channels.add(state);
        channels.set(channel, state);
        listen(channel, 'open', () => safely(() => emit(state, 'open', { metadata: channelMetadata(channel) })), state);
        listen(channel, 'message', event => safely(() => observeData(state, 'message', 'received', event.data)), state);
        listen(channel, 'error', event => safely(() => emit(state, 'error', { reason: 'data_channel_error', metadata: { error_name: errorName(event.error) } })), state);
        listen(channel, 'close', () => safely(() => closeState(state)), state);
        if (channel.readyState === 'open') emit(state, 'open', { metadata: channelMetadata(channel) });
    }
    function trackPeer(peer) {
        if (peers.has(peer) || peerStates.size >= limits.maxEvents || !observing) return;
        const state = { id: `peer-${++nextID}`, listeners: [], channels: new Set(), mediaTracks: new Map() };
        peers.set(peer, state);
        peerStates.add(state);
        listen(peer, 'datachannel', event => safely(() => trackChannel(event.channel, state, 'remote')), state);
        for (const name of ['connectionstatechange', 'iceconnectionstatechange', 'signalingstatechange']) {
            listen(peer, name, () => safely(() => {
                for (const channel of state.channels) emit(channel, 'stats', { metadata: {
                    peer_connection_state: short(peer.connectionState), ice_connection_state: short(peer.iceConnectionState),
                    signaling_state: short(peer.signalingState), event: name,
                } });
                if (peer.connectionState === 'closed') { stopPeerMedia(state, 'peer_closed'); cleanListeners(state); peerStates.delete(state); }
            }), state);
        }
        if (mediaEnabled) {
            listen(peer, 'track', event => safely(() => startMedia(state, event.track, 'received', event.receiver || event.track)), state);
            for (const receiver of safely(() => peer.getReceivers()) || []) startMedia(state, receiver.track, 'received', receiver);
            for (const sender of safely(() => peer.getSenders()) || []) trackSender(state, sender);
        }
    }
    function mediaSettings(track) {
        const settings = safely(() => track.getSettings()) || {};
        const result = {};
        for (const key of ['width', 'height', 'frameRate', 'aspectRatio', 'sampleRate', 'sampleSize', 'channelCount', 'latency']) {
            if (Number.isFinite(settings[key])) result[key] = settings[key];
        }
        for (const key of ['echoCancellation', 'autoGainControl', 'noiseSuppression']) {
            if (typeof settings[key] === 'boolean') result[key] = settings[key];
        }
        return result;
    }
    function mediaMIME(kind) {
        const candidates = kind === 'audio' ? ['audio/webm;codecs=opus', 'audio/webm'] : ['video/webm;codecs=vp8', 'video/webm'];
        return candidates.find(value => safely(() => nativeRecorder.isTypeSupported(value))) || '';
    }
    function mirrorMediaState(state) {
        const media = state.media;
        if (!media?.clone || media.finalized) return null;
        try {
            const enabled = apply(mediaEnabledDescriptor.get, media.original, []);
            const muted = Boolean(media.original.muted);
            // Muted is read-only and its source defines propagation to clones.
            // Gate our clone explicitly so it follows the original's silence.
            apply(mediaEnabledDescriptor.set, media.clone, [enabled && !muted]);
            return { enabled, muted };
        } catch (_) { stopMedia(state, 'media_enabled_sync_failed', true); return null; }
    }
    function finishMedia(state, failureReason = '') {
        const media = state.media;
        if (!media || media.finalized) return;
        media.finalized = true;
        clearTimer(media.durationTimer);
        clearTimer(media.stopTimer);
        if (failureReason) gap(state, failureReason);
        if (!media.observedBytes && !media.failed) gap(state, 'media_no_data');
        closeState(state, { metadata: {
            stop_reason: media.stopReason || 'track_ended', recorder_finalized: !failureReason,
            chunk_count: media.chunkIndex, observed_media_bytes: media.observedBytes,
        } }, mediaStopping);
        // MediaRecorder fires its final dataavailable before stop. The observer
        // queue keeps that Blob ahead of closed while its bytes are read.
        cleanListeners(state);
        safely(() => media.clone?.stop());
        const tracked = media.peer.mediaTracks.get(media.original);
        if (tracked?.get(media.direction) === state) {
            tracked.delete(media.direction);
            if (!tracked.size) media.peer.mediaTracks.delete(media.original);
        }
        originalMedia.get(media.original)?.delete(state);
        mediaRecordings.delete(state);
        mediaClosed++;
        media.resolveStopped();
        media.clone = null;
        media.recorder = null;
        media.original = null;
        media.peer = null;
        media.owners.clear();
    }
    function stopMedia(state, reason = 'capture_ended', partial = false) {
        const media = state?.media;
        if (!media || media.finalized) return;
        if (partial) gap(state, reason);
        if (media.stopRequested) return;
        media.stopRequested = true;
        media.stopReason = reason;
        clearTimer(media.durationTimer);
        // Every recorder has a cleanup deadline, including one stopped by a
        // byte limit, track replacement or encoder error during a long capture.
        media.stopTimer = timer(() => finishMedia(state, 'media_stop_timeout'), limits.mediaStopTimeoutMs);
        try {
            // An inactive recorder can still have its final data/stop tasks
            // queued. Wait for stop instead of closing the evidence early.
            if (media.recorder.state !== 'inactive') media.recorder.stop();
        } catch (error) {
            media.failed = true;
            emit(state, 'error', { reason: 'media_stop_failed', metadata: { error_name: errorName(error) } }, mediaStopping);
        }
    }
    function stopPeerMedia(peer, reason) {
        if (!mediaEnabled || !peer) return;
        for (const recordings of peer.mediaTracks.values()) {
            for (const state of recordings.values()) stopMedia(state, reason);
        }
    }
    function startMedia(peer, track, direction, owner) {
        if (!mediaEnabled || !observing || !peer || !track || !['audio', 'video'].includes(track.kind) || track.readyState === 'ended') return null;
        const existing = peer.mediaTracks.get(track)?.get(direction);
        if (existing && !existing.media.stopRequested && !existing.media.finalized) {
            existing.media.owners.add(owner);
            return existing;
        }
        const metadata = {
            semantics: 'reencoded_media', source: 'browser_media_recorder', scope: 'recorded_media_interval',
            media_kind: track.kind, direction, track_id: short(track.id, 256), parent_peer_id: peer.id,
            settings: mediaSettings(track), enabled: Boolean(track.enabled), muted: Boolean(track.muted),
            mime_type: mediaAvailable ? mediaMIME(track.kind) : '',
        };
        const state = newState('webrtc_media', metadata);
        if (!state) return null;
        if (!mediaAvailable || !mediaEnabledHookAvailable || mediaRecordings.size >= limits.maxMediaTracks) {
            gap(state, !mediaAvailable ? 'media_recorder_unavailable' : !mediaEnabledHookAvailable ? 'media_enabled_hook_unavailable' : 'media_track_limit');
            closeState(state);
            return null;
        }
        let clone;
        let recorder;
        try {
            clone = track.clone();
            if (clone === track) throw new Error('media clone must be distinct');
            apply(mediaEnabledDescriptor.set, clone, [apply(mediaEnabledDescriptor.get, track, []) && !track.muted]);
            const stream = new nativeMediaStream([clone]);
            recorder = new nativeRecorder(stream, metadata.mime_type ? { mimeType: metadata.mime_type } : {});
        } catch (error) {
            if (clone && clone !== track) safely(() => clone.stop());
            emit(state, 'error', { reason: 'media_recorder_setup_failed', metadata: { error_name: errorName(error) } });
            closeState(state);
            return null;
        }
        let resolveStopped;
        const media = {
            original: track, clone, recorder, peer, direction, owners: new Set([owner]),
            bytes: 0, observedBytes: 0, chunkIndex: 0, stopRequested: false, finalized: false, failed: false,
            mime: short(recorder.mimeType, 256) || metadata.mime_type,
            stopped: new Promise(resolve => { resolveStopped = resolve; }), resolveStopped: () => resolveStopped(),
        };
        state.media = media;
        mediaRecordings.add(state);
        mediaCreated++;
        if (!peer.mediaTracks.has(track)) peer.mediaTracks.set(track, new Map());
        peer.mediaTracks.get(track).set(direction, state);
        if (!originalMedia.has(track)) originalMedia.set(track, new Set());
        originalMedia.get(track).add(state);
        listen(recorder, 'start', () => safely(() => {
            media.mime = short(recorder.mimeType, 256) || media.mime;
            emit(state, 'open', { direction, metadata: { mime_type: media.mime } }, mediaStopping);
        }), state);
        listen(recorder, 'dataavailable', event => safely(() => {
            if (media.finalized || stopped || !event.data?.size) return;
            media.observedBytes += event.data.size;
            const captured = observeData(state, 'chunk', direction, event.data, undefined, undefined, {
                terminal: mediaStopping, maxBytes: Math.max(0, limits.maxMediaBytes - media.bytes), limitReason: 'media_byte_limit',
                payloadStage: 'reencoded_media_blob', metadata: {
                    mime_type: short(event.data.type, 256) || media.mime, chunk_index: ++media.chunkIndex,
                    ...(Number.isFinite(event.timecode) ? { timecode_ms: event.timecode } : {}),
                },
            });
            media.bytes += captured.bytes;
            if (!captured.accepted || captured.reason) stopMedia(state, captured.reason || 'media_event_limit', true);
            else if (media.bytes >= limits.maxMediaBytes) stopMedia(state, 'media_byte_limit', true);
        }), state);
        listen(recorder, 'error', event => safely(() => {
            media.failed = true;
            emit(state, 'error', { reason: 'media_recorder_error', metadata: { error_name: errorName(event.error) } }, mediaStopping);
            stopMedia(state, 'media_recorder_error', true);
        }), state);
        listen(recorder, 'stop', () => safely(() => finishMedia(state)), state);
        listen(track, 'ended', () => safely(() => stopMedia(state, 'track_ended')), state);
        for (const type of ['mute', 'unmute']) listen(track, type, () => safely(() => {
            const flow = mirrorMediaState(state);
            if (flow) emit(state, 'stats', { metadata: { track_event: type, ...flow } }, mediaStopping);
        }), state);
        try {
            recorder.start(limits.mediaTimesliceMs);
            media.durationTimer = timer(() => stopMedia(state, 'media_duration_limit', true), limits.maxMediaDurationMs);
        } catch (error) {
            media.failed = true;
            media.stopReason = 'media_recorder_start_failed';
            emit(state, 'error', { reason: 'media_recorder_start_failed', metadata: { error_name: errorName(error) } });
            finishMedia(state, 'media_recorder_start_failed');
        }
        return state;
    }
    function trackSender(peer, sender) {
        if (!peer || !sender || !observing) return;
        let entry = senderMedia.get(sender);
        if (!entry) { entry = { peer, recording: null }; senderMedia.set(sender, entry); }
        const previous = entry.recording;
        if (previous?.media?.original === sender.track && !previous.media.stopRequested) return;
        if (previous?.media && !previous.media.finalized) {
            previous.media.owners.delete(sender);
            if (!previous.media.owners.size) stopMedia(previous, 'track_replaced');
        }
        entry.recording = startMedia(peer, sender.track, 'sent', sender);
    }
    async function stopAllMedia() {
        if (!mediaEnabled || !mediaRecordings.size) return;
        mediaStopping = true;
        const pending = [...mediaRecordings];
        for (const state of pending) stopMedia(state);
        let timeout;
        await Promise.race([
            Promise.allSettled(pending.map(state => state.media.stopped)),
            new Promise(resolve => { timeout = timer(resolve, limits.mediaStopTimeoutMs); }),
        ]);
        clearTimer(timeout);
        for (const state of pending) if (!state.media.finalized) finishMedia(state, 'media_stop_timeout');
    }
    function tagStream(stream, state, channelID, role, type = 'bytes') {
        if (!stream || !state || !observing) return;
        streams.set(stream, { state, channelID, role, type });
    }
    function trackPair(pair, state, origin) {
        if (!pair || !state || !observing) return;
        const channelID = `bidi-${++state.nextStream}`;
        tagStream(pair.readable, state, channelID, 'received');
        tagStream(pair.writable, state, channelID, 'sent');
        streamPairs.set(pair, { state, channelID });
        emit(state, 'stats', { channel_id: channelID, metadata: { stream_type: 'bidirectional', origin } });
    }
    function trackUni(stream, state, origin) {
        if (!stream || !state || !observing) return;
        const channelID = `uni-${++state.nextStream}`;
        tagStream(stream, state, channelID, origin === 'remote' ? 'received' : 'sent');
        emit(state, 'stats', { channel_id: channelID, metadata: { stream_type: 'unidirectional', origin } });
    }
    function trackTransport(transport, args) {
        const state = newState('webtransport', { url: short(args[0], 4096) });
        if (!state) return;
        transports.set(transport, state);
        const duplex = transport.datagrams;
        if (duplex) {
            datagrams.set(duplex, state);
            tagStream(duplex.readable, state, 'datagrams', 'received', 'datagrams');
            tagStream(duplex.writable, state, 'datagrams', 'sent', 'datagrams');
        }
        tagStream(transport.incomingUnidirectionalStreams, state, 'incoming_uni', 'received', 'incoming_uni');
        tagStream(transport.incomingBidirectionalStreams, state, 'incoming_bidi', 'received', 'incoming_bidi');
        onPromise(transport.ready,
            () => emit(state, 'open', { metadata: { reliability: short(transport.reliability), congestion_control: short(transport.congestionControl) } }),
            error => emit(state, 'error', { reason: 'transport_ready_rejected', metadata: { error_name: errorName(error) } }));
        onPromise(transport.closed,
            info => closeState(state, { metadata: { close_code: Number.isFinite(info?.closeCode) ? info.closeCode : undefined, reason: short(info?.reason, 1024) } }),
            error => { emit(state, 'error', { reason: 'transport_closed_rejected', metadata: { error_name: errorName(error) } }); closeState(state, { reason: 'transport_closed_rejected' }); });
    }
    function readDelivered(tag, result) {
        if (!observing || tag.state.ended) return;
        if (result.done) {
            emit(tag.state, 'stats', { channel_id: tag.channelID, direction: 'received', metadata: { stream_state: 'read_closed' } });
            return;
        }
        if (tag.type === 'incoming_uni') trackUni(result.value, tag.state, 'remote');
        else if (tag.type === 'incoming_bidi') trackPair(result.value, tag.state, 'remote');
        else observeData(tag.state, tag.type === 'datagrams' ? 'message' : 'chunk', 'received', result.value, tag.channelID);
    }
    const nativePeer = root.RTCPeerConnection;
    const nativeTransport = root.WebTransport;
    const rtcInstalled = (protocolPayloads || mediaEnabled) && constructor('RTCPeerConnection', trackPeer);
    if (protocolPayloads) patch(nativePeer?.prototype, 'createDataChannel', Native => function (...args) {
        const channel = apply(Native, this, args);
        if (observing) safely(() => trackChannel(channel, peers.get(this), 'local'));
        return channel;
    });
    if (protocolPayloads) patch(root.RTCDataChannel?.prototype, 'send', Native => function (...args) {
        const result = apply(Native, this, args);
        if (observing) safely(() => { const state = channels.get(this); if (state) observeData(state, 'message', 'sent', args[0]); });
        return result;
    });
    if (mediaEnabled) {
        const trackPrototype = root.MediaStreamTrack?.prototype;
        const enabledDescriptor = trackPrototype && Object.getOwnPropertyDescriptor(trackPrototype, 'enabled');
        if (enabledDescriptor?.get && enabledDescriptor?.set && enabledDescriptor.configurable) {
            const enabledSetter = function (value) {
                apply(enabledDescriptor.set, this, [value]);
                const recordings = originalMedia.get(this);
                if ((!observing && !mediaStopping) || !recordings?.size) return;
                for (const state of recordings) {
                    const flow = mirrorMediaState(state);
                    if (flow) emit(state, 'stats', { metadata: { track_event: 'enabled_changed', ...flow } }, mediaStopping);
                }
            };
            safely(() => {
                Object.defineProperty(trackPrototype, 'enabled', { ...enabledDescriptor, set: enabledSetter });
                mediaEnabledDescriptor = enabledDescriptor;
                mediaEnabledHookAvailable = true;
                restores.push(() => {
                    const current = Object.getOwnPropertyDescriptor(trackPrototype, 'enabled');
                    if (current?.set === enabledSetter && current?.get === enabledDescriptor.get) Object.defineProperty(trackPrototype, 'enabled', enabledDescriptor);
                });
            });
        }
        for (const operation of ['addTrack', 'addTransceiver']) patch(nativePeer?.prototype, operation, Native => function (...args) {
            const result = apply(Native, this, args);
            if (observing) safely(() => trackSender(peers.get(this), operation === 'addTrack' ? result : result.sender));
            return result;
        });
        patch(root.RTCRtpSender?.prototype, 'replaceTrack', Native => function (...args) {
            const result = apply(Native, this, args);
            const entry = senderMedia.get(this);
            if (observing && entry) onPromise(result, () => trackSender(entry.peer, this));
            return result;
        });
        patch(nativePeer?.prototype, 'removeTrack', Native => function (...args) {
            const result = apply(Native, this, args);
            if (observing) safely(() => {
                const entry = senderMedia.get(args[0]);
                const recording = entry?.recording;
                if (recording?.media && !recording.media.finalized) {
                    recording.media.owners.delete(args[0]);
                    if (!recording.media.owners.size) stopMedia(recording, 'track_removed');
                }
                if (entry) entry.recording = null;
            });
            return result;
        });
        patch(nativePeer?.prototype, 'close', Native => function (...args) {
            const result = apply(Native, this, args);
            if (observing) safely(() => stopPeerMedia(peers.get(this), 'peer_closed'));
            return result;
        });
        patch(root.MediaStreamTrack?.prototype, 'stop', Native => function (...args) {
            const result = apply(Native, this, args);
            if (observing) safely(() => { for (const state of originalMedia.get(this) || []) stopMedia(state, 'track_ended'); });
            return result;
        });
        if (typeof root.addEventListener === 'function') {
            const unload = () => safely(() => { for (const state of mediaRecordings) stopMedia(state, 'media_context_unload', true); });
            root.addEventListener('pagehide', unload);
            restores.push(() => root.removeEventListener('pagehide', unload));
        }
        if (rtcInstalled && !mediaAvailable) reasons.add('media_recorder_unavailable');
        else if (rtcInstalled && !mediaEnabledHookAvailable) reasons.add('media_enabled_hook_unavailable');
    }
    let wtInstalled = false;
    if (protocolPayloads) {
    wtInstalled = constructor('WebTransport', trackTransport);
    for (const [name, track] of [['createUnidirectionalStream', trackUni], ['createBidirectionalStream', trackPair]]) {
        patch(nativeTransport?.prototype, name, Native => function (...args) {
            const result = apply(Native, this, args);
            const state = transports.get(this);
            if (observing && state) onPromise(result, stream => track(stream, state, 'local'),
                error => emit(state, 'error', { reason: 'stream_creation_failed', metadata: { error_name: errorName(error) } }));
            return result;
        });
    }
    patch(root.WebTransportDatagramDuplexStream?.prototype, 'createWritable', Native => function (...args) {
        const result = apply(Native, this, args);
        const state = datagrams.get(this);
        if (observing && state) safely(() => tagStream(result, state, 'datagrams', 'sent', 'datagrams'));
        return result;
    });
    for (const name of ['ReadableStream', 'WebTransportReceiveStream']) {
        patch(root[name]?.prototype, 'getReader', Native => function (...args) {
            const reader = apply(Native, this, args);
            const tag = streams.get(this);
            if (observing && tag) readers.set(reader, tag);
            return reader;
        });
    }
    for (const name of ['WritableStream', 'WebTransportSendStream', 'WebTransportDatagramsWritable']) {
        patch(root[name]?.prototype, 'getWriter', Native => function (...args) {
            const writer = apply(Native, this, args);
            const tag = streams.get(this);
            if (observing && tag) writers.set(writer, tag);
            return writer;
        });
    }
    for (const name of ['ReadableStreamDefaultReader', 'ReadableStreamBYOBReader']) {
        constructor(name, (reader, args) => { const tag = streams.get(args[0]); if (tag) readers.set(reader, tag); });
        patch(root[name]?.prototype, 'read', Native => function (...args) {
            const result = apply(Native, this, args);
            const tag = readers.get(this);
            if (observing && tag) onPromise(result, value => readDelivered(tag, value),
                error => emit(tag.state, 'error', { channel_id: tag.channelID, reason: 'native_read_rejected', metadata: { error_name: errorName(error) } }));
            return result;
        });
    }
    constructor('WritableStreamDefaultWriter', (writer, args) => { const tag = streams.get(args[0]); if (tag) writers.set(writer, tag); });
    for (const name of ['WritableStreamDefaultWriter', 'WebTransportWriter']) {
        for (const operation of ['write', 'atomicWrite']) {
            patch(root[name]?.prototype, operation, Native => function (...args) {
                const result = apply(Native, this, args);
                const tag = writers.get(this);
                if (observing && tag) safely(() => observeData(tag.state, tag.type === 'datagrams' ? 'message' : 'chunk', 'sent', args[0], tag.channelID, result));
                return result;
            });
        }
        for (const operation of ['close', 'abort']) {
            patch(root[name]?.prototype, operation, Native => function (...args) {
                const result = apply(Native, this, args);
                const tag = writers.get(this);
                if (observing && tag) onPromise(result, () => emit(tag.state, 'stats', { channel_id: tag.channelID, direction: 'sent', metadata: { stream_state: operation === 'close' ? 'write_closed' : 'write_aborted' } }),
                    error => emit(tag.state, 'error', { channel_id: tag.channelID, reason: `native_${operation}_rejected`, metadata: { error_name: errorName(error) } }));
                return result;
            });
        }
    }
    for (const operation of ['pipeTo', 'pipeThrough', 'tee', 'values', Symbol.asyncIterator]) {
        patch(root.ReadableStream?.prototype, operation, Native => function (...args) {
            const result = apply(Native, this, args);
            if (observing) safely(() => {
                const tag = streams.get(this);
                const reason = typeof operation === 'symbol' || operation === 'values' ? 'async_iterator_bypass' : `${operation}_bypass`;
                if (tag) gap(tag.state, reason, { channel_id: tag.channelID });
                let destination;
                if (operation === 'pipeTo') destination = streams.get(args[0]);
                else if (operation === 'pipeThrough') {
                    destination = streamPairs.get(args[0]);
                    if (!destination) {
                        // Native pipeThrough has already read writable. Do not
                        // invoke application accessors a second time to inspect it.
                        const descriptor = Object.getOwnPropertyDescriptor(args[0], 'writable');
                        if (descriptor && 'value' in descriptor) destination = streams.get(descriptor.value);
                    }
                }
                if (destination && destination.state !== tag?.state) gap(destination.state, reason, { channel_id: destination.channelID });
            });
            return result;
        });
    }
    }
    function info() {
        return {
            installed: true, version: 1, stopped, capabilities: { webrtc: protocolPayloads && rtcInstalled, webtransport: wtInstalled, webrtc_media: mediaEnabled && rtcInstalled && mediaAvailable && mediaEnabledHookAvailable },
            limits: { ...limits }, limitations: [...limitations], reasons: [...reasons],
            scheduled_events: scheduledEvents, emitted_events: emittedEvents, dropped_events: droppedEvents,
            observed_bytes: observedBytes, captured_bytes: capturedBytes, pending_bytes: pendingBytes,
            pending: pendingEvents, pending_events: pendingEvents, peak_pending_bytes: peakPendingBytes, peak_pending_events: peakPendingEvents,
            peak_batch_bytes: peakBatchBytes,
            media_recordings_created: mediaCreated, media_recordings_closed: mediaClosed, media_active: mediaRecordings.size,
        };
    }
    async function stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
            observing = false;
            // Keep enabled-state mirroring installed while native recorders
            // drain their final tasks. Only owned clones are stopped below.
            await stopAllMedia();
            for (let i = restores.length - 1; i >= 0; i--) safely(restores[i]);
            restores.length = 0;
            for (const peer of peerStates) cleanListeners(peer);
            peerStates.clear();
            for (const state of active) cleanListeners(state);
            let timeout;
            await Promise.race([
                Promise.allSettled([...pendingTasks]),
                new Promise(resolve => { timeout = timer(resolve, 1000); }),
            ]);
            clearTimer(timeout);
            for (const state of active) {
                for (let i = state.head; i < state.queue.length; i++) state.queue[i].cancel?.();
                drain(state);
                if (!state.closed) gap(state, 'capture_ended');
            }
            active.clear();
            flush();
            stopped = true;
            const result = info();
            if (root[controlName] === control) safely(() => { delete root[controlName]; });
            if (root[bindingName] === binding) safely(() => { delete root[bindingName]; });
            return result;
        })();
        return stopPromise;
    }
    const control = { stop, info, token: config.token };
    try { Object.defineProperty(root, controlName, { configurable: true, value: control }); }
    catch (_) {
        for (let i = restores.length - 1; i >= 0; i--) safely(restores[i]);
        return { installed: false, reason: 'observer_control_unavailable' };
    }
    return info();
}
