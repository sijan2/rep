const DEFAULT_HOST = 'com.repplus.host';
const MAX_QUEUE_MESSAGES = 200;
const MAX_RECONNECT_MS = 15000;
const CAPTURE_ACK_TIMEOUT_MS = 10000;
const MAX_CAPTURE_PENDING_BYTES = 16 * 1024 * 1024;

export class NativeBridge {
    constructor({ chromeApi = globalThis.chrome, hostName = DEFAULT_HOST, onRPC, onHostMessage, onConnected } = {}) {
        this.chrome = chromeApi;
        this.hostName = hostName;
        this.onRPC = onRPC || (async () => {
            throw Object.assign(new Error('RPC handler is unavailable'), { code: 'rpc_unavailable' });
        });
        this.onHostMessage = onHostMessage || (() => {});
        this.onConnected = onConnected || (() => {});
        this.port = null;
        this.queue = [];
        this.reconnectTimer = null;
        this.reconnectDelay = 250;
        this.started = false;
        this.connectedAt = 0;
        this.lastError = '';
        this.droppedMessages = 0;
        this.captureConnection = null;
        this.failedCaptureConnection = null;
        this.captureAcks = new Map();
        this.capturePendingBytes = 0;
        this.captureAckSupported = false;
        this.incrementalCaptureSupported = false;
        this.captureHelloReceived = false;
        this.captureHelloWaiters = new Set();
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.connect();
    }

    stop() {
        this.started = false;
        this.failCapture('capture_transport_disconnected', 'native bridge stopped before capture acknowledgement');
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.port) {
            try { this.port.disconnect(); } catch (_) { /* already gone */ }
            this.port = null;
        }
    }

    isConnected() {
        return Boolean(this.port);
    }

    status() {
        return {
            connected: this.isConnected(),
            connected_at: this.connectedAt || null,
            queued_messages: this.queue.length,
            dropped_messages: this.droppedMessages,
            last_error: this.lastError || null,
            capture_ack: this.captureAckSupported,
            capture_pending_bytes: this.capturePendingBytes,
        };
    }

    connect() {
        if (!this.started || this.port) return;
        try {
            const port = this.chrome.runtime.connectNative(this.hostName);
            this.port = port;
            this.captureAckSupported = false;
            this.incrementalCaptureSupported = false;
            this.captureHelloReceived = false;
            this.connectedAt = Date.now();
            this.lastError = '';
            port.onMessage.addListener((message) => { if (this.port === port) this.handleMessage(message); });
            port.onDisconnect.addListener(() => {
                const message = this.chrome.runtime.lastError?.message || 'native host disconnected';
                if (this.port === port) {
                    this.port = null;
                    this.failCapture('capture_transport_disconnected', 'native host disconnected before capture acknowledgement');
                }
                this.lastError = message;
                this.scheduleReconnect();
            });
            this.postNow(this.helloMessage());
            try {
                this.onConnected();
            } catch (error) {
                this.lastError = error?.message || String(error);
            }
            this.flushQueue();
            this.reconnectDelay = 250;
        } catch (error) {
            this.port = null;
            this.lastError = error?.message || String(error);
            this.scheduleReconnect();
        }
    }

    helloMessage() {
        const manifest = this.chrome.runtime.getManifest();
        return {
            action: 'hello',
            client: 'background',
            extension_id: this.chrome.runtime.id,
            extension_version: manifest.version,
            user_agent: globalThis.navigator?.userAgent || '',
        };
    }

    send(message, { queue = true } = {}) {
        if (this.port && this.postNow(message)) return true;
        if (queue) this.enqueue(message);
        this.scheduleReconnect();
        return false;
    }

    sendCapture(message) {
        // Explicit capture records belong to one host connection. Replaying a
        // partial session after reconnect would acknowledge incomplete evidence.
        const begin = message?.action === 'session_begin';
        const abort = message?.action === 'session_abort';
        if (begin) {
            if (this.captureConnection || this.failedCaptureConnection?.port === this.port) throw Object.assign(new Error('another capture is awaiting completion or abort'), { code: 'capture_busy' });
            this.captureConnection = { sessionID: message.session_id, port: this.port, nextSequence: 0,
                byteLimit: message.capture_limits?.max_native_backlog_bytes || MAX_CAPTURE_PENDING_BYTES };
        }
        if (abort && !this.captureConnection && this.failedCaptureConnection?.sessionID === message.session_id && this.failedCaptureConnection.port === this.port) this.captureConnection = this.failedCaptureConnection;
        const sameConnection = this.captureConnection?.sessionID === message?.session_id
            && this.captureConnection?.port === this.port;
        if (this.port && sameConnection) {
            const sequence = this.captureConnection.nextSequence++;
            const outgoing = { ...message, capture_sequence: sequence };
            const bytes = new TextEncoder().encode(JSON.stringify(outgoing)).byteLength;
            if (this.capturePendingBytes + bytes > this.captureConnection.byteLimit) {
                this.failCapture('capture_backlog_limit', 'native capture acknowledgement backlog exceeded its byte budget');
                throw Object.assign(new Error('native capture backlog exceeded its byte budget'), { code: 'capture_backlog_limit' });
            }
            const key = `${message.session_id}:${sequence}`;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.failCapture('capture_ack_timeout', 'native host did not acknowledge capture data within 10 seconds');
                }, CAPTURE_ACK_TIMEOUT_MS);
                this.captureAcks.set(key, { resolve, reject, timeout, bytes, end: message.action === 'session_end' || abort });
                this.capturePendingBytes += bytes;
                if (!this.postNow(outgoing)) this.failCapture('capture_transport_disconnected', 'native host disconnected during capture');
            });
        }
        this.failCapture('capture_transport_disconnected', 'native host disconnected during capture');
        this.scheduleReconnect();
        throw Object.assign(new Error('native host disconnected during capture; the capture was not sealed'), {
            code: 'capture_transport_disconnected',
            data: { session_id: message?.session_id, action: message?.action },
        });
    }

    async assertCaptureReady() {
        const port = this.port;
        if (!port) throw Object.assign(new Error('native host is disconnected'), { code: 'capture_transport_disconnected' });
        if (!this.captureHelloReceived) await new Promise((resolve) => {
            const finish = () => { clearTimeout(timeout); this.captureHelloWaiters.delete(finish); resolve(); };
            const timeout = setTimeout(finish, 1000);
            this.captureHelloWaiters.add(finish);
        });
        if (this.port !== port) throw Object.assign(new Error('native host changed during capture preflight'), { code: 'capture_transport_disconnected' });
        if (!this.captureHelloReceived) throw Object.assign(new Error('native host capability handshake did not complete; no browser action was executed'), { code: 'capture_host_unready' });
        if (!this.captureAckSupported || !this.incrementalCaptureSupported) throw Object.assign(new Error('installed native host does not support acknowledged incremental capture; update rep host before recording'), { code: 'unsupported_capture_host' });
        return true;
    }

    failCapture(code, message) {
        if (this.captureConnection) this.failedCaptureConnection = this.captureConnection;
        this.captureConnection = null;
        for (const pending of this.captureAcks.values()) {
            clearTimeout(pending.timeout);
            pending.reject(Object.assign(new Error(message), { code }));
        }
        this.captureAcks.clear();
        this.capturePendingBytes = 0;
    }

    acknowledgeCapture(message) {
        const key = `${message.session_id}:${message.capture_sequence}`;
        const pending = this.captureAcks.get(key);
        if (!pending) return;
        if (message.error || message.success === false) {
            this.failCapture(message.error?.code || 'capture_rejected', message.error?.message || 'native host rejected capture data');
            return;
        }
        this.captureAcks.delete(key);
        this.capturePendingBytes -= pending.bytes;
        clearTimeout(pending.timeout);
        if (pending.end) { this.captureConnection = null; this.failedCaptureConnection = null; }
        pending.resolve(true);
    }

    postNow(message) {
        if (!this.port) return false;
        try {
            this.port.postMessage(message);
            return true;
        } catch (error) {
            this.lastError = error?.message || String(error);
            this.port = null;
            return false;
        }
    }

    enqueue(message) {
        // A newer full sync supersedes all queued incremental export messages.
        if (['sync', 'session_begin', 'ambient_begin'].includes(message?.action)) {
            this.queue = this.queue.filter((item) => !['add', 'add_many', 'sync'].includes(item?.action));
        }
        this.queue.push(message);
        while (this.queue.length > MAX_QUEUE_MESSAGES) {
            const incremental = this.queue.findIndex((item) => ['add', 'add_many', 'sync'].includes(item?.action));
            this.queue.splice(incremental >= 0 ? incremental : 0, 1);
            this.droppedMessages += 1;
            this.lastError = 'ambient reconnect backlog exceeded; dropped messages are reported';
        }
    }

    flushQueue() {
        if (!this.port || this.queue.length === 0) return;
        const pending = this.queue;
        this.queue = [];
        for (let index = 0; index < pending.length; index += 1) {
            if (!this.postNow(pending[index])) {
                this.queue = pending.slice(index).concat(this.queue);
                this.scheduleReconnect();
                break;
            }
        }
    }

    scheduleReconnect() {
        if (!this.started || this.reconnectTimer || this.port) return;
        const jitter = Math.floor(Math.random() * Math.min(250, this.reconnectDelay));
        const delay = this.reconnectDelay + jitter;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectDelay = Math.min(MAX_RECONNECT_MS, Math.max(500, this.reconnectDelay * 2));
    }

    async handleMessage(message) {
        if (message?.action === 'capture_ack') {
            this.acknowledgeCapture(message);
            return;
        }
        if (message?.action === 'hello') {
            this.captureHelloReceived = true;
            this.captureAckSupported = message.capture_ack === true;
            this.incrementalCaptureSupported = message.incremental_capture === true;
            for (const finish of [...this.captureHelloWaiters]) finish();
        }
        if (message?.action !== 'rpc') {
            this.onHostMessage(message);
            return;
        }
        const id = message.id;
        try {
            const result = await this.onRPC(message.method, message.params || {});
            this.send({ action: 'rpc_result', id, result }, { queue: false });
        } catch (error) {
            this.send({
                action: 'rpc_result',
                id,
                error: normalizeRPCError(error),
            }, { queue: false });
        }
    }
}

export function normalizeRPCError(error) {
    return {
        code: error?.code || 'browser_error',
        message: error?.message || String(error || 'Unknown browser error'),
        data: error?.data,
    };
}
