const DEFAULT_HOST = 'com.repplus.host';
const MAX_QUEUE_MESSAGES = 200;
const MAX_RECONNECT_MS = 15000;

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
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.connect();
    }

    stop() {
        this.started = false;
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
            last_error: this.lastError || null,
        };
    }

    connect() {
        if (!this.started || this.port) return;
        try {
            const port = this.chrome.runtime.connectNative(this.hostName);
            this.port = port;
            this.connectedAt = Date.now();
            this.lastError = '';
            port.onMessage.addListener((message) => this.handleMessage(message));
            port.onDisconnect.addListener(() => {
                const message = this.chrome.runtime.lastError?.message || 'native host disconnected';
                if (this.port === port) this.port = null;
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
