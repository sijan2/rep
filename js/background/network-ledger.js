// Per-tab network ledger for rep-created tabs. It OBSERVES what the page's own
// client loads over the control attachment, keeps admitted response bodies in a
// bounded ring, and redacts credentials before anything leaves the extension.
// It never enables ExtraInfo events, so cookie values never enter it.
import { bytesToBase64 } from './body-capture.js';

export const OWNED_TABS_KEY = 'rep_owned_tabs';
export const LEDGER_TABS_KEY = 'rep_ledger_tabs';
const MiB = 1024 * 1024;
const MAX_BODY_BYTES = 8 * MiB;
const MAX_RING_BYTES = 64 * MiB;
const MAX_IDLE_MS = 600000;
const DEFAULT_IDLE_MS = 120000;
const MIN_IDLE_MS = 1000;
const MAX_WAIT_MS = 10000;
const MAX_READ_BYTES = 6 * MiB;
const DEFAULT_READ_BYTES = 1 * MiB;
const MAX_BODY_PAGE_BYTES = 6 * MiB;
const MAX_ENTRIES = 20000;
const MAX_POST_DATA_SIZE = 65536;
const NETWORK_ENABLE = Object.freeze({ maxTotalBufferSize: 64 * MiB, maxResourceBufferSize: 16 * MiB, maxPostDataSize: MAX_POST_DATA_SIZE });
const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Media', 'Manifest', 'Other']);
const PHASES = new Set(['start', 'end', 'any']);

const SENSITIVE_HEADER_NAMES = new Set([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'x-csrftoken', 'x-xsrf-token',
    'x-client-transaction-id', 'x-guest-token', 'x-api-key',
]);
const SENSITIVE_NAME_PATTERN = /token|secret|session|csrf|xsrf|password/i;
const SENSITIVE_KEYS = new Set(['access_token', 'token', 'key', 'api_key', 'sig', 'signature']);
export const RESPONSE_HEADER_ALLOWLIST = Object.freeze([
    'content-type', 'content-length', 'location', 'retry-after', 'ratelimit', 'ratelimit-policy', 'ratelimit-limit',
    'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used',
    'x-rate-limit-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset', 'cf-mitigated', 'www-authenticate', 'cache-control', 'date', 'server',
]);
const RESPONSE_ALLOWLIST = new Set(RESPONSE_HEADER_ALLOWLIST);

const failure = (code, message, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

export class NetworkLedger {
    constructor(runtime) {
        this.runtime = runtime;
        this.chrome = runtime.chrome;
        this.ledgers = new Map();
        this.ownedTabs = new Set();
        this.storageTail = Promise.resolve();
        this.removeListener = null;
        this.chrome.tabs?.onRemoved?.addListener?.((tabId) => { this.tabRemoved(Number(tabId)).catch(() => {}); });
    }

    // The debugger listener exists only while a ledger does, so an idle runtime
    // holds no event subscription.
    listen() {
        if (this.removeListener) return;
        this.removeListener = this.runtime.addDebuggerEventListener((source, method, params) => this.onDebuggerEvent(source, method, params || {}));
    }

    unlistenIfIdle() {
        if (!this.removeListener || this.ledgers.size) return;
        this.removeListener();
        this.removeListener = null;
    }

    // ---- ownership bookkeeping -------------------------------------------------

    async recordOwnedTab(tabId) {
        const id = Number(tabId);
        if (!Number.isInteger(id) || id < 0) return;
        this.ownedTabs.add(id);
        await this.updateMap(OWNED_TABS_KEY, (map) => { map[id] = Date.now(); });
    }

    async isOwned(tabId) {
        if (this.ownedTabs.has(tabId)) return true;
        const map = await this.readMap(OWNED_TABS_KEY);
        return Object.prototype.hasOwnProperty.call(map, String(tabId));
    }

    async forgetTab(tabId) {
        this.ownedTabs.delete(tabId);
        await this.updateMap(OWNED_TABS_KEY, (map) => { delete map[tabId]; });
        await this.updateMap(LEDGER_TABS_KEY, (map) => { delete map[tabId]; });
    }

    async readMap(key) {
        try {
            const stored = await this.chrome.storage?.session?.get?.(key);
            const value = stored?.[key];
            return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
        } catch (_) {
            return {};
        }
    }

    // Read-modify-write is serialized so concurrent tab creations cannot lose entries.
    updateMap(key, mutate) {
        const step = this.storageTail.then(async () => {
            const map = await this.readMap(key);
            mutate(map);
            try { await this.chrome.storage?.session?.set?.({ [key]: map }); } catch (_) { /* memory stays authoritative */ }
            return map;
        });
        this.storageTail = step.catch(() => {});
        return step;
    }

    isLedgerTab(tabId) {
        const ledger = this.ledgers.get(Number(tabId));
        return Boolean(ledger && ledger.state === 'open');
    }

    // Tabs listed as ledger tabs by a previous worker exist only for records
    // reads; without a live ledger they are closed. Owned tabs without a ledger
    // are left alone.
    async reapStaleLedgerTabs() {
        const ledgerTabs = await this.readMap(LEDGER_TABS_KEY);
        const closed = [];
        for (const key of Object.keys(ledgerTabs)) {
            const tabId = Number(key);
            if (!Number.isInteger(tabId) || this.ledgers.has(tabId)) continue;
            await this.runtime.debugDetachTarget({ tabId }).catch(() => {});
            this.runtime.controlAttachments.delete(`tab:${tabId}`);
            await this.runtime.call(this.chrome.tabs, 'remove', tabId).catch(() => {});
            await this.forgetTab(tabId);
            closed.push(tabId);
        }
        return { closed };
    }

    // ---- RPC surface -----------------------------------------------------------

    async open(params = {}) {
        const tabId = tabIdFrom(params);
        const owner = ownerFrom(params);
        const bodyOps = compileBodyOps(params.body_ops);
        const privatePaths = Array.isArray(params.private_paths) ? params.private_paths.map((path) => String(path)).filter(Boolean) : [];
        const maxBodyBytes = clampInteger(params.max_body_bytes, MAX_BODY_BYTES, 0, MAX_BODY_BYTES);
        const ringBytes = clampInteger(params.ring_bytes, MAX_RING_BYTES, 0, MAX_RING_BYTES);
        const idleMs = clampInteger(params.idle_ms, DEFAULT_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS);
        if (!(await this.isOwned(tabId))) throw failure('not_owned', `tab ${tabId} was not created by browser.create`, { tab_id: tabId });
        if (this.ledgers.has(tabId)) throw failure('ledger_busy', `tab ${tabId} already has a ledger`, { tab_id: tabId });
        if (this.runtime.isCapturingTab(tabId)) throw failure('tab_busy', `tab ${tabId} has an active capture`);
        const ledger = {
            id: `ledger-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
            tabId, owner, policyId: String(params.policy_id || ''),
            bodyOps, privatePaths, maxBodyBytes, ringBytes, idleMs,
            cursor: 0, records: new Map(), byRequestId: new Map(), navs: [],
            bodies: new Map(), bodyBytes: 0,
            stats: { evicted: 0, dropped: 0, skipped_by_reason: {} },
            waiters: new Set(), state: 'open', mainFrameId: '', ownsAttachment: false, idleTimer: null,
        };
        this.ledgers.set(tabId, ledger);
        this.listen();
        try {
            const attached = await this.runtime.attachControl({ tab_id: tabId });
            ledger.ownsAttachment = !attached.already_attached;
            const debuggee = { tabId };
            await this.runtime.sendDebugCommand(debuggee, 'Network.enable', { ...NETWORK_ENABLE, enableDurableMessages: true })
                .catch(() => this.runtime.sendDebugCommand(debuggee, 'Network.enable', { ...NETWORK_ENABLE }));
            await this.runtime.sendDebugCommand(debuggee, 'Page.enable', {});
            const tree = await this.runtime.sendDebugCommand(debuggee, 'Page.getFrameTree', {});
            ledger.mainFrameId = String(tree?.frameTree?.frame?.id || '');
            await this.updateMap(LEDGER_TABS_KEY, (map) => { map[tabId] = Date.now(); });
            this.touch(ledger);
            return { ledger_id: ledger.id, seq: 0, main_frame_id: ledger.mainFrameId, attached: true, already_attached: Boolean(attached.already_attached) };
        } catch (error) {
            await this.drop(ledger, { detach: true });
            if (error && typeof error === 'object' && !error.code) error.code = 'ledger_open_failed';
            throw error;
        }
    }

    async read(params = {}) {
        const ledger = this.resolve(params);
        this.touch(ledger);
        const since = clampInteger(params.since, 0, 0, Number.MAX_SAFE_INTEGER);
        const waitMs = clampInteger(params.wait_ms, 0, 0, MAX_WAIT_MS);
        const maxBytes = clampInteger(params.max_bytes, DEFAULT_READ_BYTES, 1024, MAX_READ_BYTES);
        const match = compileMatch(params.match);
        if (waitMs > 0 && ledger.state === 'open' && !hasWake(ledger, since, match)) {
            await this.waitFor(ledger, match, waitMs);
        }
        return this.batch(ledger, since, match, maxBytes);
    }

    async body(params = {}) {
        const ledger = this.resolve(params);
        this.touch(ledger);
        const seq = clampInteger(params.seq, -1, -1, Number.MAX_SAFE_INTEGER);
        const record = ledger.records.get(seq);
        if (!record) throw failure('body_unavailable', `no entry with seq ${params.seq}`, { state: 'unknown' });
        const body = record.entry.body;
        if (body.state !== 'complete') throw failure('body_unavailable', `body for seq ${seq} is ${body.state}`, { state: body.state, ...(body.reason ? { reason: body.reason } : {}) });
        const bytes = ledger.bodies.get(seq);
        if (!bytes) throw failure('body_unavailable', `body for seq ${seq} is evicted`, { state: 'evicted' });
        const offset = clampInteger(params.offset, 0, 0, bytes.length);
        const length = clampInteger(params.length, MAX_BODY_PAGE_BYTES, 0, MAX_BODY_PAGE_BYTES);
        const slice = bytes.subarray(offset, Math.min(bytes.length, offset + length));
        return { seq, offset, length: slice.length, total: bytes.length, sha256: body.sha256, encoding: 'base64', data: bytesToBase64(slice) };
    }

    async close(params = {}) {
        const tabId = tabIdFrom(params);
        const ledger = this.ledgers.get(tabId);
        if (!ledger || (params.ledger_id && ledger.id !== String(params.ledger_id))) return { closed: true };
        if (ledger.owner !== ownerFrom(params)) throw failure('not_owned', 'ledger belongs to another owner', { tab_id: tabId });
        await this.drop(ledger, { detach: true });
        return { closed: true };
    }

    // ---- lifecycle -------------------------------------------------------------

    resolve(params) {
        const tabId = tabIdFrom(params);
        const ledger = this.ledgers.get(tabId);
        if (!ledger || ledger.id !== String(params.ledger_id || '')) throw failure('ledger_lost', `tab ${tabId} has no ledger ${params.ledger_id || ''}`, { tab_id: tabId });
        if (ledger.owner !== ownerFrom(params)) throw failure('not_owned', 'ledger belongs to another owner', { tab_id: tabId });
        return ledger;
    }

    touch(ledger) {
        if (ledger.idleTimer) clearTimeout(ledger.idleTimer);
        ledger.idleTimer = setTimeout(() => { this.reap(ledger).catch(() => {}); }, ledger.idleMs);
        ledger.idleTimer.unref?.();
    }

    async reap(ledger) {
        if (this.ledgers.get(ledger.tabId) !== ledger) return;
        await this.drop(ledger, { detach: true, closeTab: true });
    }

    // The attachment is gone; what was collected stays readable until close or reap.
    detached(tabId) {
        const ledger = this.ledgers.get(Number(tabId));
        if (!ledger || ledger.state !== 'open') return;
        ledger.state = 'detached';
        this.wake(ledger);
    }

    async tabRemoved(tabId) {
        const ledger = this.ledgers.get(tabId);
        if (ledger && ledger.state !== 'closed') {
            ledger.state = 'closed';
            this.wake(ledger);
        }
        if (this.ownedTabs.has(tabId) || ledger) await this.forgetTab(tabId);
    }

    async drop(ledger, { detach = false, closeTab = false } = {}) {
        if (ledger.idleTimer) clearTimeout(ledger.idleTimer);
        ledger.idleTimer = null;
        ledger.state = 'closed';
        if (this.ledgers.get(ledger.tabId) === ledger) this.ledgers.delete(ledger.tabId);
        this.unlistenIfIdle();
        this.wake(ledger);
        ledger.bodies.clear();
        ledger.bodyBytes = 0;
        await this.updateMap(LEDGER_TABS_KEY, (map) => { delete map[ledger.tabId]; });
        if (detach && ledger.ownsAttachment && this.runtime.controlAttachments.has(`tab:${ledger.tabId}`)) {
            await this.runtime.detachControl({ tab_id: ledger.tabId }).catch(() => {});
        }
        if (closeTab) {
            await this.runtime.call(this.chrome.tabs, 'remove', ledger.tabId).catch(() => {});
            await this.forgetTab(ledger.tabId);
        }
    }

    wake(ledger, record = null, phase = 'state') {
        for (const waiter of [...ledger.waiters]) {
            if (record && !waiterWants(waiter.match, record, phase)) continue;
            waiter.resolve();
        }
    }

    waitFor(ledger, match, waitMs) {
        return new Promise((resolve) => {
            const waiter = { match, resolve: null };
            const timer = setTimeout(() => waiter.resolve(), waitMs);
            waiter.resolve = () => {
                clearTimeout(timer);
                ledger.waiters.delete(waiter);
                resolve();
            };
            ledger.waiters.add(waiter);
        });
    }

    // ---- read assembly ---------------------------------------------------------

    async batch(ledger, since, match, maxBytes) {
        const changed = [...ledger.records.values()]
            .filter((record) => record.cursor >= since && filterMatches(match, record) && phaseIncludes(match.phase, record))
            .sort((a, b) => a.cursor - b.cursor);
        const encoder = new TextEncoder();
        const entries = [];
        let nextSeq = ledger.cursor + 1;
        let bytes = 0;
        // Entries leave in change order (by cursor) and as snapshots, so a
        // truncated batch resumes exactly at next_seq and later mutations
        // never alter a result already handed out.
        for (const record of changed) {
            const json = JSON.stringify(record.entry);
            const size = encoder.encode(json).length;
            if (entries.length && bytes + size > maxBytes) { nextSeq = record.cursor; break; }
            entries.push(JSON.parse(json));
            bytes += size;
        }
        const navs = ledger.navs.filter((nav) => nav.seq >= since && nav.seq < nextSeq);
        let tab = { url: '', active: false };
        if (this.chrome.tabs?.get) {
            try {
                const live = await this.runtime.call(this.chrome.tabs, 'get', ledger.tabId);
                tab = { url: redactURL(live?.url || live?.pendingUrl || ''), active: Boolean(live?.active) };
            } catch (_) { /* tab is gone; state says so */ }
        }
        const stats = {
            entries: ledger.records.size, bodies: ledger.bodies.size, body_bytes: ledger.bodyBytes,
            evicted: ledger.stats.evicted, skipped_by_reason: { ...ledger.stats.skipped_by_reason },
            ...(ledger.stats.dropped ? { dropped_entries: ledger.stats.dropped } : {}),
        };
        return { entries, navs, next_seq: nextSeq, state: ledger.state, tab, stats };
    }

    // ---- debugger events -------------------------------------------------------

    onDebuggerEvent(source, method, params) {
        if (source?.sessionId) return;
        const ledger = this.ledgers.get(source?.tabId);
        if (!ledger || ledger.state !== 'open') return;
        switch (method) {
        case 'Network.requestWillBeSent': return this.onRequestWillBeSent(ledger, params);
        case 'Network.responseReceived': return this.onResponseReceived(ledger, params);
        case 'Network.loadingFinished': return this.onLoadingFinished(ledger, params);
        case 'Network.loadingFailed': return this.onLoadingFailed(ledger, params);
        case 'Page.frameNavigated': return this.onFrameNavigated(ledger, params);
        case 'Page.navigatedWithinDocument': return this.onNavigatedWithinDocument(ledger, params);
        default: return undefined;
        }
    }

    onRequestWillBeSent(ledger, params) {
        const requestId = String(params.requestId || '');
        if (!requestId) return;
        const request = params.request || {};
        const previous = ledger.byRequestId.get(requestId);
        if (previous && params.redirectResponse && !previous.finished) {
            previous.entry.response = responseSummary(params.redirectResponse);
            previous.entry.t.response = Date.now();
            previous.entry.body = { state: 'not_applicable', reason: 'redirect', bytes: 0 };
            previous.entry.t.end = Date.now();
            this.finish(ledger, previous);
        }
        const url = String(request.url || '') + String(request.urlFragment || '');
        const method = String(request.method || 'GET').toUpperCase();
        const type = String(params.type || '');
        const seq = ++ledger.cursor;
        const headers = redactHeaders(request.headers);
        const contentType = headerValue(request.headers, 'content-type');
        const entry = {
            seq, rev: 0, request_id: requestId, loader_id: String(params.loaderId || ''), frame_id: String(params.frameId || ''),
            type, method, url: redactURL(url),
            initiator: { type: String(params.initiator?.type || ''), url: redactURL(params.initiator?.url || '') },
            request: { headers },
            body: { state: 'pending', bytes: 0 },
            t: { start: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now() },
        };
        if (typeof request.postData === 'string') entry.request.post_data = redactPostData(request.postData, contentType);
        const record = { entry, seq, cursor: seq, endCursor: 0, admitted: false, finished: false, rawURL: url, postData: null };
        this.decideAdmission(ledger, record);
        // Current Chromium omits postData from this event. Admitted requests
        // fetch it on the side because a response's continuation is matched by
        // what its own request posted.
        if (record.admitted && request.hasPostData && entry.request.post_data === undefined) {
            record.postData = this.runtime.sendDebugCommand({ tabId: ledger.tabId }, 'Network.getRequestPostData', { requestId })
                .then((result) => { if (typeof result?.postData === 'string') entry.request.post_data = redactPostData(result.postData, contentType); })
                .catch(() => {});
        }
        ledger.records.set(seq, record);
        ledger.byRequestId.set(requestId, record);
        this.boundEntries(ledger);
        this.wake(ledger, record, 'start');
    }

    decideAdmission(ledger, record) {
        const { entry } = record;
        if (entry.body.state !== 'pending' && entry.body.state !== 'skipped') return;
        const decision = admit(ledger, entry.method, record.rawURL, entry.type);
        record.admitted = decision.admitted;
        entry.body = decision.admitted ? { state: 'pending', bytes: 0 } : { state: 'skipped', reason: decision.reason, bytes: 0 };
    }

    onResponseReceived(ledger, params) {
        const record = ledger.byRequestId.get(String(params.requestId || ''));
        if (!record || record.finished) return;
        const { entry } = record;
        if (params.type) entry.type = String(params.type);
        entry.response = responseSummary(params.response || {});
        entry.t.response = Date.now();
        this.decideAdmission(ledger, record);
        this.bump(ledger, record);
    }

    onLoadingFinished(ledger, params) {
        const record = ledger.byRequestId.get(String(params.requestId || ''));
        if (!record || record.finished) return;
        record.finished = true;
        const { entry } = record;
        entry.t.end = Date.now();
        if (entry.body.state !== 'pending') { this.finish(ledger, record); return; }
        this.bump(ledger, record);
        this.captureBody(ledger, record).catch(() => {});
    }

    async captureBody(ledger, record) {
        const { entry } = record;
        let bytes;
        try {
            await record.postData;
            const response = await this.runtime.sendDebugCommand({ tabId: ledger.tabId }, 'Network.getResponseBody', { requestId: entry.request_id });
            bytes = response?.base64Encoded ? base64ToBytes(response?.body || '') : new TextEncoder().encode(String(response?.body || ''));
        } catch (error) {
            if (this.ledgers.get(ledger.tabId) !== ledger) return;
            entry.body = { state: 'failed', reason: String(error?.message || error || 'body_unavailable').slice(0, 200), bytes: 0 };
            this.finish(ledger, record);
            return;
        }
        if (this.ledgers.get(ledger.tabId) !== ledger) return;
        if (bytes.length > ledger.maxBodyBytes || bytes.length > ledger.ringBytes) {
            entry.body = { state: 'skipped', reason: 'too_large', bytes: bytes.length };
            this.finish(ledger, record);
            return;
        }
        let sha256 = '';
        try { sha256 = await sha256HexAsync(bytes); } catch (_) { sha256 = sha256Hex(bytes); }
        if (this.ledgers.get(ledger.tabId) !== ledger) return;
        this.store(ledger, record, bytes, sha256);
        this.finish(ledger, record);
    }

    // Oldest bodies leave first; the entry keeps its metadata and hash.
    store(ledger, record, bytes, sha256) {
        while (ledger.bodies.size && ledger.bodyBytes + bytes.length > ledger.ringBytes) {
            const oldest = ledger.bodies.keys().next().value;
            this.evict(ledger, oldest);
        }
        ledger.bodies.set(record.seq, bytes);
        ledger.bodyBytes += bytes.length;
        record.entry.body = { state: 'complete', bytes: bytes.length, sha256, encoding: 'base64' };
    }

    evict(ledger, seq) {
        const bytes = ledger.bodies.get(seq);
        if (!bytes) return;
        ledger.bodies.delete(seq);
        ledger.bodyBytes = Math.max(0, ledger.bodyBytes - bytes.length);
        ledger.stats.evicted += 1;
        const record = ledger.records.get(seq);
        if (!record) return;
        const { sha256, bytes: size } = record.entry.body;
        record.entry.body = { state: 'evicted', bytes: size, ...(sha256 ? { sha256 } : {}) };
        this.bump(ledger, record);
    }

    onLoadingFailed(ledger, params) {
        const record = ledger.byRequestId.get(String(params.requestId || ''));
        if (!record || record.finished) return;
        record.finished = true;
        const { entry } = record;
        entry.t.end = Date.now();
        entry.error = String(params.errorText || params.blockedReason || 'loading_failed');
        if (entry.body.state === 'pending') entry.body = { state: 'failed', reason: params.canceled ? 'canceled' : 'loading_failed', bytes: 0 };
        this.finish(ledger, record);
    }

    finish(ledger, record) {
        record.finished = true;
        const { body } = record.entry;
        if (body.state === 'skipped' && body.reason) {
            ledger.stats.skipped_by_reason[body.reason] = (ledger.stats.skipped_by_reason[body.reason] || 0) + 1;
        }
        this.bump(ledger, record);
        record.endCursor = record.cursor;
        if (ledger.byRequestId.get(record.entry.request_id) === record) ledger.byRequestId.delete(record.entry.request_id);
        this.wake(ledger, record, 'end');
    }

    bump(ledger, record) {
        record.entry.rev += 1;
        record.cursor = ++ledger.cursor;
    }

    boundEntries(ledger) {
        while (ledger.records.size > MAX_ENTRIES) {
            const oldest = ledger.records.keys().next().value;
            const record = ledger.records.get(oldest);
            if (ledger.bodies.has(oldest)) {
                const bytes = ledger.bodies.get(oldest);
                ledger.bodies.delete(oldest);
                ledger.bodyBytes = Math.max(0, ledger.bodyBytes - bytes.length);
            }
            ledger.records.delete(oldest);
            if (ledger.byRequestId.get(record.entry.request_id) === record) ledger.byRequestId.delete(record.entry.request_id);
            ledger.stats.dropped += 1;
        }
        while (ledger.navs.length > MAX_ENTRIES) ledger.navs.shift();
    }

    onFrameNavigated(ledger, params) {
        const frame = params.frame || {};
        if (frame.parentId) return;
        ledger.mainFrameId = String(frame.id || ledger.mainFrameId);
        ledger.navs.push({ seq: ++ledger.cursor, url: redactURL(frame.url || ''), same_document: false, loader_id: String(frame.loaderId || ''), frame_id: String(frame.id || '') });
        this.boundEntries(ledger);
    }

    onNavigatedWithinDocument(ledger, params) {
        const frameId = String(params.frameId || '');
        if (ledger.mainFrameId && frameId && frameId !== ledger.mainFrameId) return;
        ledger.navs.push({ seq: ++ledger.cursor, url: redactURL(params.url || ''), same_document: true, loader_id: '', frame_id: frameId });
        this.boundEntries(ledger);
    }
}

// ---- admission -----------------------------------------------------------------

export function admit(ledger, method, url, type) {
    if (STATIC_TYPES.has(type)) return { admitted: false, reason: 'static_type' };
    if (ledger.privatePaths.some((path) => url.includes(path))) return { admitted: false, reason: 'private_path' };
    let parsed;
    try { parsed = new URL(url); } catch (_) { return { admitted: false, reason: 'not_admitted' }; }
    const host = parsed.hostname.toLowerCase();
    for (const op of ledger.bodyOps) {
        if (op.method !== method) continue;
        if (host !== op.host && !host.endsWith(`.${op.host}`)) continue;
        if (op.types && !op.types.has(type)) continue;
        if (!op.pathRe.test(parsed.pathname)) continue;
        return { admitted: true, op: op.op };
    }
    return { admitted: false, reason: 'not_admitted' };
}

function compileBodyOps(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw failure('invalid_argument', 'body_ops must be an array');
    return value.map((op, index) => {
        if (!op || typeof op !== 'object') throw failure('invalid_argument', `body_ops[${index}] must be an object`);
        let pathRe;
        try { pathRe = new RegExp(String(op.path_re || '')); } catch (_) { throw failure('invalid_argument', `body_ops[${index}].path_re is not a valid regular expression`); }
        const types = Array.isArray(op.types) && op.types.length ? new Set(op.types.map((type) => String(type))) : null;
        return { op: String(op.op || ''), method: String(op.method || 'GET').toUpperCase(), host: String(op.host || '').toLowerCase().replace(/\.$/, ''), pathRe, types };
    });
}

function compileMatch(value) {
    const match = { urlRe: null, method: '', types: null, admittedOnly: false, phase: 'any' };
    if (value == null) return match;
    if (typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_argument', 'match must be an object');
    if (value.url_re) {
        try { match.urlRe = new RegExp(String(value.url_re)); } catch (_) { throw failure('invalid_argument', 'match.url_re is not a valid regular expression'); }
    }
    if (value.method) match.method = String(value.method).toUpperCase();
    if (Array.isArray(value.types) && value.types.length) match.types = new Set(value.types.map((type) => String(type)));
    match.admittedOnly = value.admitted_only === true;
    if (value.phase != null) {
        if (!PHASES.has(value.phase)) throw failure('invalid_argument', 'match.phase must be start, end or any');
        match.phase = value.phase;
    }
    return match;
}

function filterMatches(match, record) {
    const { entry } = record;
    if (match.method && entry.method !== match.method) return false;
    if (match.types && !match.types.has(entry.type)) return false;
    if (match.admittedOnly && !record.admitted) return false;
    if (match.urlRe && !match.urlRe.test(entry.url)) return false;
    return true;
}

function phaseIncludes(phase, record) {
    return phase !== 'end' || record.endCursor > 0;
}

function waiterWants(match, record, phase) {
    if (!filterMatches(match, record)) return false;
    if (match.phase === 'start') return phase === 'start';
    if (match.phase === 'end') return phase === 'end';
    return phase === 'start' || phase === 'end';
}

function hasWake(ledger, since, match) {
    for (const record of ledger.records.values()) {
        if (!filterMatches(match, record)) continue;
        if (match.phase !== 'end' && record.seq >= since) return true;
        if (match.phase !== 'start' && record.endCursor > 0 && record.endCursor >= since) return true;
    }
    return false;
}

// ---- redaction -----------------------------------------------------------------

export function isSensitiveHeaderName(name) {
    const lower = String(name || '').toLowerCase();
    return SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_NAME_PATTERN.test(lower);
}

export function isSensitiveKey(name) {
    const lower = String(name || '').toLowerCase();
    return SENSITIVE_KEYS.has(lower) || isSensitiveHeaderName(lower);
}

export function redactionMarker(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    const bytes = new TextEncoder().encode(text);
    return { redacted: true, bytes: bytes.length, sha8: sha256Hex(bytes).slice(0, 8) };
}

export function redactHeaders(headers) {
    const output = [];
    for (const [name, value] of Object.entries(headers || {})) {
        const text = String(value ?? '');
        output.push([name, isSensitiveHeaderName(name) ? redactionMarker(text) : text]);
    }
    return output;
}

export function allowlistResponseHeaders(headers) {
    const output = [];
    for (const [name, value] of Object.entries(headers || {})) {
        if (!RESPONSE_ALLOWLIST.has(String(name).toLowerCase())) continue;
        output.push([name, String(value ?? '')]);
    }
    return output;
}

export function redactURL(url) {
    const text = String(url || '');
    if (!text.includes('?')) return text;
    let parsed;
    try { parsed = new URL(text); } catch (_) { return text; }
    let changed = false;
    for (const key of [...new Set(parsed.searchParams.keys())]) {
        if (!isSensitiveKey(key)) continue;
        parsed.searchParams.set(key, 'redacted');
        changed = true;
    }
    return changed ? parsed.href : text;
}

export function redactPostData(postData, contentType = '') {
    const text = String(postData || '');
    if (!text) return text;
    const type = String(contentType || '').toLowerCase();
    // The boundary token is case-sensitive; extract it from the original header.
    if (type.startsWith('multipart/form-data')) return redactMultipart(text, String(contentType || ''));
    const trimmed = text.trim();
    if (type.includes('json') || /^[[{]/.test(trimmed)) {
        try {
            const parsed = JSON.parse(trimmed);
            return JSON.stringify(redactJSON(parsed, 0));
        } catch (_) {
            if (type.includes('json')) return redactionMarker(text);
        }
    }
    if (type.includes('x-www-form-urlencoded') || /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(trimmed)) return redactURLEncoded(text);
    return text;
}

function redactJSON(value, depth) {
    if (depth > 32 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redactJSON(item, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        output[key] = isSensitiveKey(key) ? redactionMarker(typeof item === 'string' ? item : JSON.stringify(item ?? null)) : redactJSON(item, depth + 1);
    }
    return output;
}

function redactURLEncoded(text) {
    return text.split('&').map((segment) => {
        const index = segment.indexOf('=');
        const rawKey = index < 0 ? segment : segment.slice(0, index);
        let key = rawKey;
        try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch (_) { /* keep raw */ }
        if (!isSensitiveKey(key)) return segment;
        let value = index < 0 ? '' : segment.slice(index + 1);
        try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch (_) { /* hash the raw value */ }
        return `${rawKey}=${JSON.stringify(redactionMarker(value))}`;
    }).join('&');
}

function redactMultipart(text, contentType) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (!boundary) return redactionMarker(text);
    const delimiter = `--${boundary}`;
    const parts = text.split(delimiter);
    if (parts.length < 2) return redactionMarker(text);
    return parts.map((part, index) => {
        if (index === 0 || index === parts.length - 1) return part;
        const separator = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
        const split = part.indexOf(separator);
        if (split < 0) return part;
        const head = part.slice(0, split);
        const name = /name="([^"]*)"/i.exec(head)?.[1] ?? /name=([^;\s]+)/i.exec(head)?.[1];
        if (name == null || !isSensitiveKey(name)) return part;
        const tail = part.slice(split + separator.length);
        const lineEnd = tail.endsWith('\r\n') ? '\r\n' : tail.endsWith('\n') ? '\n' : '';
        const value = lineEnd ? tail.slice(0, -lineEnd.length) : tail;
        return `${head}${separator}${JSON.stringify(redactionMarker(value))}${lineEnd}`;
    }).join(delimiter);
}

function responseSummary(response) {
    return {
        status: Number(response.status) || 0,
        mime: String(response.mimeType || ''),
        protocol: String(response.protocol || ''),
        from_sw: Boolean(response.fromServiceWorker),
        from_cache: Boolean(response.fromDiskCache || response.fromPrefetchCache),
        headers: allowlistResponseHeaders(response.headers),
    };
}

function headerValue(headers, name) {
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() === name) return String(value ?? '');
    }
    return '';
}

// ---- parameters ----------------------------------------------------------------

function tabIdFrom(params) {
    const tabId = Number(params.tab_id);
    if (!Number.isInteger(tabId) || tabId < 0) throw failure('invalid_argument', 'tab_id must be a non-negative integer');
    return tabId;
}

function ownerFrom(params) {
    const owner = params.owner;
    if (typeof owner !== 'string' || !owner || owner.length > 256) throw failure('invalid_argument', 'a bounded task owner is required');
    return owner;
}

function clampInteger(value, fallback, minimum, maximum) {
    const number = value == null || value === '' ? fallback : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

// ---- bytes and hashing ---------------------------------------------------------

export function base64ToBytes(value) {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function sha256HexAsync(bytes) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return hex(new Uint8Array(digest));
}

function hex(bytes) {
    let output = '';
    for (const value of bytes) output += value.toString(16).padStart(2, '0');
    return output;
}

// Synchronous SHA-256 keeps entry creation atomic: a redaction marker is in
// place before any read can observe the entry.
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const length = bytes.length;
    const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, (length * 8) >>> 0);
    view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i += 1) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let i = 0; i < 64; i += 1) {
            const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0; state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0; state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i]);
    return hex(out);
}
