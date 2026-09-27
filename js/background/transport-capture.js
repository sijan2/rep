import { buildStableRequestId } from '../core/utils/hash.js';
import { transportObserverSource } from './transport-observer.js';

const MAX_CONTEXTS = 128;
const MAX_BINDING_BYTES = 16 * 1024 * 1024;
const API_LIMITATIONS = [
    'page_controlled_observer', 'objects_created_before_installation',
    'cached_native_methods_and_transferred_streams', 'unattached_shared_and_service_workers',
    'application_bytes_only_no_wire_packets_or_media',
];
const MEDIA_LIMITATIONS = [
    'page_controlled_observer', 'objects_created_before_installation',
    'reencoded_media_not_original_rtp_frames', 'recorded_interval_not_entire_call',
    'cloned_existing_tracks_only', 'native_encoder_cpu_and_buffers_outside_byte_limits',
];

// One observer per explicit capture. All identifiers are scoped by target and
// execution context; URLs are never used to guess API/CDP connection identity.
export class TransportCapture {
    constructor(controller, session, enabled, mediaEnabled = false) {
        this.controller = controller;
        this.session = session;
        this.protocolPayloads = enabled;
        this.mediaEnabled = mediaEnabled;
        this.enabled = enabled || mediaEnabled;
        this.targets = new Map();
        this.records = new Map();
        this.contextSequence = 0;
        this.pendingCleanup = new Set();
        this.mediaExportTail = Promise.resolve();
        this.mediaExports = new WeakSet();
        this.observerStats = { protocol_observer_reported_contexts: 0, protocol_observer_destroyed_contexts: 0, protocol_observer_dropped_events: 0, protocol_observer_observed_bytes: 0, protocol_observer_captured_bytes: 0 };
        this.stopping = false;
        const nonce = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}${Math.random().toString(16).slice(2)}`;
        this.bindingName = `__rep_transport_${nonce}`;
        this.controlName = `__rep_transport_control_${nonce}`;
        this.token = nonce;
        this.source = this.enabled ? transportObserverSource({
            bindingName: this.bindingName, controlName: this.controlName, token: this.token,
            maxEvents: session.limits.max_events,
            maxBytes: session.limits.max_total_body_bytes,
            maxMessageBytes: session.maxBodyBytes,
            protocolPayloads: enabled, webrtcMedia: mediaEnabled,
        }) : '';
    }

    async enableTarget(debuggee, type = 'page') {
        if (!this.enabled || this.stopping) return;
        const key = debuggee.sessionId || '';
        if (this.targets.has(key)) return;
        const target = { debuggee, type, contexts: new Map(), ready: false, scriptId: '' };
        this.targets.set(key, target);
        target.setup = this.setupTarget(target);
        return target.setup;
    }

    async setupTarget(target) {
        const { debuggee, type } = target;
        try {
            await this.controller.sendDebugCommand(debuggee, 'Runtime.addBinding', { name: this.bindingName });
            if (this.stopping || target.disabled) return this.cleanupTarget(target);
            await this.controller.sendDebugCommand(debuggee, 'Runtime.enable');
            if (this.stopping || target.disabled) return this.cleanupTarget(target);
            if (type !== 'worker') {
                const result = await this.controller.sendDebugCommand(debuggee, 'Page.addScriptToEvaluateOnNewDocument', { source: this.source });
                if (!result?.identifier) throw new Error('browser did not register the protocol observer startup script');
                target.scriptId = result.identifier;
            }
            if (this.stopping || target.disabled) return this.cleanupTarget(target);
            target.ready = true;
            await Promise.all([...target.contexts.values()].map((context) => this.installContext(target, context)));
        } catch (error) {
            this.session.warnings.add('protocol_observer_setup_failed');
            throw error;
        }
    }

    installContext(target, context) {
        if (context.installing) return context.installing;
        if (this.stopping) return Promise.resolve();
        const pending = this.controller.sendDebugCommand(target.debuggee, 'Runtime.evaluate', {
            expression: this.source, ...evaluationContext(context), returnByValue: true,
        }).then((result) => {
            if (result?.exceptionDetails || result?.result?.value?.installed !== true) {
                throw new Error('protocol observer could not be installed in this context');
            }
            context.installed = true;
            context.info = result.result.value;
            if (this.stopping) return this.stopContext(target, context);
        }).catch(() => {
            if (target.contexts.get(context.id) === context) this.markGap('protocol_observer_context_unavailable', target.debuggee.sessionId || '', context.id);
        }).finally(() => this.session.bodyPromises.delete(pending));
        context.installing = pending;
        this.session.bodyPromises.add(pending);
        return pending;
    }

    handle(source, method, params) {
        const targetKey = source.sessionId || '';
        const target = this.targets.get(targetKey);
        if (method === 'Runtime.executionContextCreated' && this.enabled && target) {
            const context = params.context;
            // Main-world pages and worker contexts only. Extension and isolated
            // worlds must not become an extra source of application evidence.
            if (!context || context.auxData?.isDefault === false) return true;
            const existing = target.contexts.get(context.id);
            if (existing && existing.uniqueId === (context.uniqueId || '')) return true;
            if (existing) {
                this.endContext(targetKey, context.id, 'execution_context_replaced');
                target.contexts.delete(context.id);
            }
            const contexts = [...this.targets.values()].reduce((count, item) => count + item.contexts.size, 0);
            if (contexts >= MAX_CONTEXTS || target.disabled) {
                // Startup scripts also run in overflow realms. Remove the
                // registration, then stop that realm by its unique identity.
                // Never leave an untracked observer mutating page APIs.
                target.disabled = true;
                this.markGap('protocol_observer_context_limit');
                const cleanup = this.removeStartup(target).then(() => this.stopContext(target, { id: context.id, uniqueId: context.uniqueId || '' }));
                this.pendingCleanup.add(cleanup);
                cleanup.finally(() => this.pendingCleanup.delete(cleanup));
                return true;
            }
            target.contexts.set(context.id, { id: context.id, uniqueId: context.uniqueId || '', generation: ++this.contextSequence, nextBatch: 1, gaps: new Set(), frameId: context.auxData?.frameId || '', installed: false });
            if (this.stopping) this.stopContext(target, target.contexts.get(context.id));
            else if (target.ready) this.installContext(target, target.contexts.get(context.id));
            return true;
        }
        if (method === 'Runtime.executionContextDestroyed' && target) {
            this.endContext(targetKey, params.executionContextId, 'execution_context_destroyed');
            this.session.bodyPromises.delete(target.contexts.get(params.executionContextId)?.installing);
            target.contexts.delete(params.executionContextId);
            return true;
        }
        if (method === 'Runtime.executionContextsCleared' && target) {
            for (const [id, context] of target.contexts) {
                this.endContext(targetKey, id, 'execution_context_destroyed');
                this.session.bodyPromises.delete(context.installing);
            }
            target.contexts.clear();
            return true;
        }
        if (method === 'Target.detachedFromTarget') {
            const detached = this.targets.get(params.sessionId);
            if (detached) {
                for (const id of detached.contexts.keys()) this.endContext(params.sessionId, id, 'target_detached');
                this.targets.delete(params.sessionId);
            }
        }
        if (method === 'Runtime.bindingCalled' && this.enabled && params.name === this.bindingName) {
            this.onBinding(source, params, target);
            return true;
        }
        if (method.startsWith('Network.webTransport')) {
            this.onLifecycle(source, method, params);
            return true;
        }
        return false;
    }

    onBinding(source, params, target) {
        if (!target?.contexts.has(params.executionContextId)) { this.session.warnings.add('protocol_observer_unknown_context'); return; }
        const gap = (reason) => this.markGap(reason, source.sessionId || '', params.executionContextId);
        // The page can invoke a Runtime binding. Treat its data as instrumented
        // API evidence, never as authenticated CDP bytes or executable code.
        if (typeof params.payload !== 'string' || params.payload.length > MAX_BINDING_BYTES) { gap('protocol_observer_binding_limit'); return; }
        let packet;
        try { packet = JSON.parse(params.payload); } catch (_) { gap('protocol_observer_invalid_batch'); return; }
        if (packet?.token !== this.token || !Array.isArray(packet.events) || packet.events.length > 128) { gap('protocol_observer_invalid_batch'); return; }
        const context = target.contexts.get(params.executionContextId);
        if (!Number.isSafeInteger(packet.batch_sequence) || packet.batch_sequence !== context.nextBatch) gap('protocol_observer_batch_gap');
        if (Number.isSafeInteger(packet.batch_sequence) && packet.batch_sequence >= context.nextBatch) context.nextBatch = packet.batch_sequence + 1;
        for (const item of packet.events) this.onAPIEvent(source, params.executionContextId, item, target);
    }

    onAPIEvent(source, contextId, item, target) {
        if (!item || !['webtransport', 'webrtc', 'webrtc_media'].includes(item.protocol) || typeof item.connection_id !== 'string' || item.connection_id.length > 256 ||
            (item.protocol === 'webrtc_media' ? !this.mediaEnabled : !this.protocolPayloads)) {
            this.markGap('protocol_observer_invalid_event', source.sessionId || '', contextId); return;
        }
        const context = target.contexts.get(contextId);
        const key = `${source.sessionId || ''}:${contextId}:${context.generation}:${item.protocol}:${item.connection_id}`;
        let record = this.records.get(key);
        if (!record) {
            record = this.createRecord(key, item.protocol, item.protocol === 'webrtc_media' ? 'browser_media_recorder' : 'page_api', item.metadata?.url || '', source, contextId, item.kind === 'created');
            if (!record) return;
            record.stream.metadata = {
                ...boundedMetadata(item.metadata), execution_context_id: contextId, execution_context_generation: context.generation,
                observer_trust: 'page_controlled',
            };
            const declared = item.metadata?.observer_limitations || context.info?.limitations;
            if (Array.isArray(declared)) {
                record.stream.capture.limitations = [...new Set([...(item.protocol === 'webrtc_media' ? MEDIA_LIMITATIONS : API_LIMITATIONS), ...declared.slice(0, 32).filter((value) => typeof value === 'string').map((value) => value.slice(0, 256))])];
            }
            if (!record.stream.metadata.observer_limits && context.info?.limits) record.stream.metadata.observer_limits = boundedMetadata(context.info.limits);
            delete record.stream.metadata.observer_limitations;
            record.frame_id = target.contexts.get(contextId)?.frameId || '';
            if (context.gaps.size) record.stream.capture.reason ||= [...context.gaps][0];
        }
        if (record.complete || record.exportQueued) { this.session.warnings.add('protocol_event_after_close'); this.session.observedEvents += 1; this.session.droppedEvents += 1; return; }
        const event = { sequence: ++record.streamSequence, kind: shortString(item.kind, 64) || 'unknown' };
        if (Number.isFinite(item.timestamp) && item.timestamp >= 0) event.timestamp = item.timestamp;
        if (['sent', 'received'].includes(item.direction)) event.direction = item.direction;
        if (typeof item.channel_id === 'string') event.channel_id = shortString(item.channel_id, 256);
        if (item.metadata) {
            event.metadata = { ...boundedMetadata(item.metadata) };
            if (item.protocol === 'webrtc_media' && typeof item.metadata.mime_type === 'string' && item.metadata.mime_type) {
                record.stream.metadata.mime_type = shortString(item.metadata.mime_type, 256);
            }
            if (item.kind === 'created') {
                delete event.metadata.observer_limits;
                delete event.metadata.observer_limitations;
            }
        }
        if (typeof item.reason === 'string') event.reason = shortString(item.reason, 256);
        if (typeof item.error === 'string') event.error = shortString(item.error, 1024);
        if (item.kind === 'gap' || item.truncated || item.metadata?.truncated || item.kind === 'error') {
            record.stream.capture.reason ||= event.reason || 'protocol_observer_gap';
            if (item.truncated || item.metadata?.truncated) event.truncated = true;
            this.session.warnings.add(record.stream.capture.reason);
        }
        let payload;
        if (typeof item.payload === 'string') {
            if (!['utf-8', 'base64'].includes(item.payload_encoding)) {
                record.stream.capture.reason ||= 'protocol_observer_invalid_encoding'; event.truncated = true;
            } else payload = item.payload;
        }
        const beforeObserved = record.stream.capture.observed_bytes;
        this.controller.appendStreamEvent(this.session, record, event, payload, item.payload_encoding === 'base64');
        // The observer may have bounded a payload before crossing the binding.
        // Preserve its full observed length separately from archived bytes.
        const observed = Number.isSafeInteger(item.observed_bytes) ? item.observed_bytes : item.bytes;
        const receivedBytes = record.stream.capture.observed_bytes - beforeObserved;
        if (Number.isSafeInteger(observed) && observed > receivedBytes) {
            record.stream.capture.observed_bytes += observed - receivedBytes;
            record.stream.capture.reason ||= 'protocol_observer_payload_partial';
            event.truncated = true;
        }
        if (item.kind === 'open') record.stream.state = 'open';
        if (item.kind === 'closed') {
            if (item.protocol === 'webrtc_media') {
                const reason = mediaCoverageReason(record, item.metadata);
                if (reason) {
                    record.stream.capture.reason ||= reason;
                    this.session.warnings.add(reason);
                }
            }
            this.controller.finishStreamRecord(this.session, record);
            this.queueRecord(record);
        }
        this.session.cancelIdle();
        this.session.checkIdle();
    }

    onLifecycle(source, method, params) {
        if (!params.transportId) return;
        const key = `cdp:${source.sessionId || ''}:${params.transportId}`;
        const created = method === 'Network.webTransportCreated';
        let record = this.records.get(key);
        if (!record) record = this.createRecord(key, 'webtransport', 'cdp_lifecycle', params.url || '', source, null, created);
        if (!record || record.complete) return;
        record.stream.capture.reason = 'payload_capture_unavailable';
        const kind = created ? 'created' : method === 'Network.webTransportClosed' ? 'closed' : 'open';
        const event = { sequence: ++record.streamSequence, kind };
        if (Number.isFinite(params.timestamp)) event.timestamp = params.timestamp;
        this.controller.appendStreamEvent(this.session, record, event);
        if (kind === 'open') record.stream.state = 'open';
        if (kind === 'closed') {
            this.controller.finishStreamRecord(this.session, record);
            this.controller.queueCompletedRecord(this.session, record);
        }
        this.session.cancelIdle();
        this.session.checkIdle();
    }

    createRecord(key, protocol, source, url, debuggee, contextId, created) {
        const session = this.session;
        if (session.requests.size >= session.limits.max_requests) {
            if (created) session.droppedRequests += 1;
            session.observedEvents += 1; session.droppedEvents += 1;
            session.warnings.add('request_limit'); return null;
        }
        const timestamp = Date.now();
        const media = source === 'browser_media_recorder';
        const api = source === 'page_api' || media;
        const record = {
            id: buildStableRequestId({ requestId: key, tabId: session.tabId, timestamp, method: '', url: shortString(url, 8192) }),
            original_id: key, key: `transport:${key}`, record_kind: protocol, method: '',
            url: shortString(url, 8192), page_url: session.finalURL || session.url,
            resource_type: protocol, headers: {}, body: '', timestamp, tab_id: session.tabId,
            capture_source: media ? 'browser-media-recorder' : api ? 'page-api' : 'cdp', source_session_id: debuggee.sessionId || '',
            debuggee: { tabId: session.tabId, ...(debuggee.sessionId ? { sessionId: debuggee.sessionId } : {}) },
            protocolContextID: contextId, complete: false, streamSequence: 0, network_state: 'pending',
            request_body_capture: { state: 'not_applicable', source, captured_bytes: 0 },
            response_body_capture: { state: 'not_applicable', source, captured_bytes: 0 },
            stream: {
                version: 1, protocol, source, connection_id: `${session.id}:${key}`,
                clock: api ? 'performance_now_seconds' : 'cdp_monotonic_seconds',
                payload_semantics: media ? 'reencoded_media' : api ? protocol === 'webrtc' ? 'application_messages' : 'application_chunks' : 'unavailable',
                state: created ? 'connecting' : 'open', events: [],
                capture: {
                    state: 'pending', scope: media ? 'recorded_media_interval' : api ? 'instrumented_api_calls' : 'connection_lifecycle',
                    ...(created ? {} : { reason: 'connection_started_before_capture' }),
                    limitations: media ? [...MEDIA_LIMITATIONS] : api ? [...API_LIMITATIONS] : ['cdp_lifecycle_only', 'separate_from_api_observer_records'],
                    captured_events: 0, observed_events: 0, captured_bytes: 0, observed_bytes: 0, dropped_events: 0,
                },
            },
        };
        this.records.set(key, record);
        session.requests.set(record.key, record);
        const sourceKey = debuggee.sessionId || '';
        if (!session.sourceRecords.has(sourceKey)) session.sourceRecords.set(sourceKey, new Set());
        session.sourceRecords.get(sourceKey).add(record);
        return record;
    }

    markGap(reason, targetKey, contextId) {
        this.session.warnings.add(reason);
        for (const [key, target] of this.targets) {
            if (targetKey != null && key !== targetKey) continue;
            for (const [id, context] of target.contexts) {
                if (contextId != null && id !== contextId) continue;
                context.gaps.add(reason);
            }
        }
        for (const record of this.records.values()) {
            if (record.complete || !['page_api', 'browser_media_recorder'].includes(record.stream.source)) continue;
            if (targetKey != null && record.source_session_id !== targetKey) continue;
            if (contextId != null && record.protocolContextID !== contextId) continue;
            record.stream.capture.reason ||= reason;
        }
    }

    endContext(targetKey, contextId, reason) {
        const context = this.targets.get(targetKey)?.contexts.get(contextId);
        if (context && !context.stopConfirmed) this.observerStats.protocol_observer_destroyed_contexts += 1;
        for (const record of this.records.values()) {
            if (record.complete || record.source_session_id !== targetKey || record.protocolContextID !== contextId) continue;
            this.controller.finishStreamRecord(this.session, record, reason);
            this.queueRecord(record);
        }
    }

    async stop() {
        this.stopping = true;
        if (!this.enabled) return;
        const tasks = [...this.targets.values()].map(async (target) => {
            await target.setup?.catch(() => {});
            await Promise.allSettled([...target.contexts.values()].map((context) => context.installing));
            await this.cleanupTarget(target);
        });
        let timer;
        await Promise.race([
            (async () => {
                await Promise.allSettled(tasks);
                while (this.pendingCleanup.size) await Promise.allSettled([...this.pendingCleanup]);
            })(),
            new Promise((resolve) => { timer = setTimeout(() => { this.markGap('protocol_observer_cleanup_timeout'); resolve(); }, 2500); }),
        ]);
        clearTimeout(timer);
        await this.mediaExportTail;
    }

    queueRecord(record) {
        if (record.record_kind !== 'webrtc_media') return this.controller.queueCompletedRecord(this.session, record);
        if (this.mediaExports.has(record)) return;
        this.mediaExports.add(record);
        // MediaRecorder often finalizes every track together. Keep their bounded
        // records in the existing aggregate capture budget and publish one at a
        // time, rather than bursting all base64 copies into the native backlog.
        this.mediaExportTail = this.mediaExportTail.then(async () => {
            await this.session.exportTail;
            this.controller.queueCompletedRecord(this.session, record);
            await this.session.exportTail;
        });
    }

    async cleanupTarget(target) {
        await this.removeStartup(target);
        await Promise.all([...target.contexts.values()].map((context) => this.stopContext(target, context)));
        await this.controller.sendDebugCommand(target.debuggee, 'Runtime.removeBinding', { name: this.bindingName }).catch(() => this.markGap('protocol_observer_cleanup_failed', target.debuggee.sessionId || ''));
    }

    removeStartup(target) {
        const identifier = target.scriptId;
        if (!identifier) return Promise.resolve();
        if (target.removal?.identifier === identifier) return target.removal.promise;
        const promise = this.controller.sendDebugCommand(target.debuggee, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
            .then(() => { if (target.scriptId === identifier) target.scriptId = ''; })
            .catch(() => this.markGap('protocol_observer_cleanup_failed', target.debuggee.sessionId || ''));
        target.removal = { identifier, promise };
        return promise;
    }

    stopContext(target, context) {
        if (!context.stopPromise) context.stopPromise = this.stopContextOnce(target, context).finally(() => {
            if (!context.stopConfirmed) context.stopPromise = null;
        });
        return context.stopPromise;
    }

    async stopContextOnce(target, context) {
        try {
            const result = await this.controller.sendDebugCommand(target.debuggee, 'Runtime.evaluate', {
                expression: `globalThis[${JSON.stringify(this.controlName)}]?.stop() ?? {stopped:true,observer_missing:true}`, ...evaluationContext(context),
                awaitPromise: true, returnByValue: true, timeout: 2000,
            });
            const info = result?.result?.value;
            context.stopConfirmed = info?.stopped === true && !info.observer_missing;
            if (context.stopConfirmed && !context.statsReported) {
                context.statsReported = true;
                this.observerStats.protocol_observer_reported_contexts += 1;
                for (const key of ['dropped_events', 'observed_bytes', 'captured_bytes']) {
                    if (Number.isSafeInteger(info[key]) && info[key] >= 0) {
                        const name = `protocol_observer_${key}`;
                        this.observerStats[name] = Math.min(Number.MAX_SAFE_INTEGER, this.observerStats[name] + info[key]);
                    }
                }
            }
            if (result?.exceptionDetails || !info || (context.installed && info.observer_missing) || info.pending > 0 || info.dropped_events > 0) {
                this.markGap('protocol_observer_incomplete', target.debuggee.sessionId || '', context.id);
            }
            for (const reason of info?.reasons || []) this.markGap(shortString(reason, 256), target.debuggee.sessionId || '', context.id);
        } catch (_) {
            if (target.contexts.get(context.id) === context) this.markGap('protocol_observer_cleanup_failed', target.debuggee.sessionId || '', context.id);
        }
    }

    statistics() { return this.enabled ? { protocol_payloads: this.protocolPayloads ? 1 : 0, webrtc_media: this.mediaEnabled ? 1 : 0, ...this.observerStats } : {}; }
}

function mediaCoverageReason(record, final) {
    // Finalization is a separate claim from receiving a closed event. Reconcile
    // it with retained chunks so a lost tail cannot become a complete interval.
    if (final?.recorder_finalized !== true) return 'media_recorder_not_finalized';
    const capture = record.stream.capture;
    const chunks = record.stream.events.filter(event => event.kind === 'chunk');
    if (!Number.isSafeInteger(final.chunk_count) || final.chunk_count < 0 || final.chunk_count !== chunks.length ||
        chunks.some((event, index) => event.metadata?.chunk_index !== index + 1 || event.payload_encoding !== 'base64')) {
        return 'media_chunk_sequence_mismatch';
    }
    if (!Number.isSafeInteger(final.observed_media_bytes) || final.observed_media_bytes < 0 ||
        final.observed_media_bytes !== capture.observed_bytes || capture.captured_bytes !== capture.observed_bytes) {
        return 'media_byte_count_mismatch';
    }
    if (!chunks.length || !capture.captured_bytes) return 'media_no_data';
    return '';
}

function shortString(value, length) { return typeof value === 'string' ? value.slice(0, length) : ''; }
function evaluationContext(context) { return context.uniqueId ? { uniqueContextId: context.uniqueId } : { contextId: context.id }; }
function boundedMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try {
        const text = JSON.stringify(value);
        return text.length <= 16384 ? value : { omitted: true, reason: 'metadata_limit' };
    } catch (_) { return { omitted: true, reason: 'invalid_metadata' }; }
}
