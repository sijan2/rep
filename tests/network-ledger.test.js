import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { BrowserRuntime } from '../js/background/browser-runtime.js';
import { CDPCaptureController } from '../js/background/cdp-capture.js';
import { NativeBridge } from '../js/background/native-bridge.js';
import {
    LEDGER_TABS_KEY, OWNED_TABS_KEY, base64ToBytes, redactHeaders, redactPostData, redactURL, sha256Hex,
} from '../js/background/network-ledger.js';

const OWNER = 'workspace/records';
const OPS = [
    { op: 'thread', method: 'GET', host: 'example.test', path_re: '^/r/[^/]+/comments/[^/]+', types: ['Document'] },
    { op: 'more', method: 'POST', host: 'example.test', path_re: '^/svc/more-comments/' },
];
const PRIVATE = ['/svc/chat', 'matrix.example.test'];
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture({ tabs: seed = [] } = {}) {
    const eventListeners = [];
    const detachListeners = [];
    const removedListeners = [];
    const commands = [];
    const bodies = new Map();
    const stores = { session: new Map(), local: new Map() };
    const tabs = new Map(seed.map((tab) => [tab.id, { active: false, status: 'complete', ...tab }]));
    let nextTabId = 100;
    const storage = (store) => ({
        get: vi.fn(async (key) => ({ [key]: store.get(key) })),
        set: vi.fn(async (items) => { for (const [key, value] of Object.entries(items)) store.set(key, JSON.parse(JSON.stringify(value))); }),
    });
    const chromeApi = {
        runtime: { lastError: null, id: 'ext-id', getURL: (path) => `chrome-extension://ext-id/${path}` },
        storage: { session: storage(stores.session), local: storage(stores.local) },
        tabs: {
            onRemoved: { addListener(fn) { removedListeners.push(fn); } },
            onUpdated: { addListener() {}, removeListener() {} },
            create: vi.fn((options, done) => {
                const tab = { id: nextTabId++, windowId: 1, active: Boolean(options.active), status: 'complete', url: options.url };
                tabs.set(tab.id, tab);
                done(tab);
            }),
            get: vi.fn((id, done) => {
                const tab = tabs.get(id);
                if (!tab) { chromeApi.runtime.lastError = { message: `No tab with id: ${id}.` }; done(undefined); chromeApi.runtime.lastError = null; return; }
                done({ ...tab });
            }),
            remove: vi.fn((id, done) => { tabs.delete(id); done(); }),
            query: vi.fn((_query, done) => done([...tabs.values()])),
        },
        debugger: {
            onDetach: { addListener(fn) { detachListeners.push(fn); } },
            onEvent: { addListener(fn) { eventListeners.push(fn); } },
            attach: vi.fn((_target, _version, done) => done()),
            detach: vi.fn((_target, done) => done()),
            sendCommand: vi.fn((target, method, params, done) => {
                commands.push({ target, method, params });
                if (method === 'Page.getFrameTree') return done({ frameTree: { frame: { id: 'F1', loaderId: 'L1', url: 'about:blank' } } });
                if (method === 'Network.getResponseBody') {
                    const body = bodies.get(params.requestId);
                    if (body instanceof Error) { chromeApi.runtime.lastError = { message: body.message }; done(undefined); chromeApi.runtime.lastError = null; return; }
                    return done(body || { body: '', base64Encoded: false });
                }
                if (method === 'Runtime.evaluate') return done({ result: { type: 'object', value: { ok: true } } });
                return done({});
            }),
        },
    };
    const emit = (tabId, method, params) => { for (const fn of eventListeners) fn({ tabId }, method, params); };
    const detach = (tabId, reason = 'target_closed') => { for (const fn of detachListeners) fn({ tabId }, reason); };
    const removeTab = (tabId) => { tabs.delete(tabId); for (const fn of removedListeners) fn(tabId, { windowId: 1, isWindowClosing: false }); };
    return { chromeApi, emit, detach, removeTab, commands, bodies, tabs, stores };
}

async function openLedger(runtime, overrides = {}) {
    const created = await runtime.createTab({});
    const opened = await runtime.openLedger({ tab_id: created.tab_id, owner: OWNER, policy_id: 'example', body_ops: OPS, private_paths: PRIVATE, ...overrides });
    return { tabId: created.tab_id, ...opened };
}

// Emits the three events of one request on the root session.
function exchange(emit, tabId, { id, url, method = 'GET', type = 'XHR', headers = {}, postData, status = 200, responseHeaders = { 'content-type': 'text/html' }, fail = false }) {
    emit(tabId, 'Network.requestWillBeSent', {
        requestId: id, loaderId: 'L1', frameId: 'F1', type, wallTime: 1700000000,
        request: { url, method, headers, ...(postData === undefined ? {} : { postData, hasPostData: true }) },
        initiator: { type: 'parser', url: 'https://www.example.test/r/test/comments/abc/?token=zzz' },
    });
    if (fail) { emit(tabId, 'Network.loadingFailed', { requestId: id, type, errorText: 'net::ERR_FAILED', canceled: false }); return; }
    emit(tabId, 'Network.responseReceived', { requestId: id, loaderId: 'L1', frameId: 'F1', type, response: { url, status, mimeType: responseHeaders['content-type'] || '', protocol: 'h2', headers: responseHeaders } });
    emit(tabId, 'Network.loadingFinished', { requestId: id, encodedDataLength: 10 });
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('ledger open and ownership', () => {
    it('refuses tabs not created by browser.create and a second ledger on the same tab', async () => {
        const { chromeApi } = fixture({ tabs: [{ id: 5, url: 'https://www.example.test/' }] });
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.openLedger({ tab_id: 5, owner: OWNER })).rejects.toMatchObject({ code: 'not_owned' });
        const { tabId, ledger_id, main_frame_id, already_attached } = await openLedger(runtime);
        expect(ledger_id).toMatch(/^ledger-/);
        expect(main_frame_id).toBe('F1');
        expect(already_attached).toBe(false);
        await expect(runtime.openLedger({ tab_id: tabId, owner: OWNER })).rejects.toMatchObject({ code: 'ledger_busy' });
        expect(runtime.debuggerEventListeners.size).toBe(1);
        await runtime.closeLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        expect(runtime.debuggerEventListeners.size).toBe(0);
    });

    it('enables Network before Page over the control attachment and never requests ExtraInfo events', async () => {
        const { chromeApi, commands, stores } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId } = await openLedger(runtime);
        const methods = commands.filter((command) => command.target.tabId === tabId).map((command) => command.method);
        expect(methods.slice(0, 2)).toEqual(['Page.setWebLifecycleState', 'Emulation.setFocusEmulationEnabled']);
        expect(methods.indexOf('Network.enable')).toBeLessThan(methods.indexOf('Page.enable'));
        expect(methods.indexOf('Page.enable')).toBeLessThan(methods.indexOf('Page.getFrameTree'));
        const enable = commands.find((command) => command.method === 'Network.enable');
        expect(enable.params).toEqual({ maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024, maxPostDataSize: 65536, enableDurableMessages: true });
        expect(methods.some((method) => /ExtraInfo/i.test(method))).toBe(false);
        expect(stores.session.get(OWNED_TABS_KEY)).toHaveProperty(String(tabId));
        expect(stores.session.get(LEDGER_TABS_KEY)).toHaveProperty(String(tabId));
    });

    it('falls back to Network.enable without durable messages when the browser rejects the flag', async () => {
        const { chromeApi, commands } = fixture();
        const prior = chromeApi.debugger.sendCommand.getMockImplementation();
        chromeApi.debugger.sendCommand.mockImplementation((target, method, params, done) => {
            if (method === 'Network.enable' && params.enableDurableMessages) {
                commands.push({ target, method, params });
                chromeApi.runtime.lastError = { message: 'Invalid parameters' }; done(undefined); chromeApi.runtime.lastError = null;
                return undefined;
            }
            return prior(target, method, params, done);
        });
        const runtime = new BrowserRuntime({ chromeApi });
        await openLedger(runtime);
        const enables = commands.filter((command) => command.method === 'Network.enable').map((command) => command.params);
        expect(enables).toHaveLength(2);
        expect(enables[1]).not.toHaveProperty('enableDurableMessages');
    });

    it('rejects owner mismatches and unknown ledgers', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        await expect(runtime.readLedger({ tab_id: tabId, ledger_id, owner: 'someone/else' })).rejects.toMatchObject({ code: 'not_owned' });
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: 'someone/else', seq: 1 })).rejects.toMatchObject({ code: 'not_owned' });
        await expect(runtime.closeLedger({ tab_id: tabId, ledger_id, owner: 'someone/else' })).rejects.toMatchObject({ code: 'not_owned' });
        await expect(runtime.readLedger({ tab_id: tabId, ledger_id: 'ledger-missing', owner: OWNER })).rejects.toMatchObject({ code: 'ledger_lost' });
        await expect(runtime.readLedger({ tab_id: 4242, ledger_id, owner: OWNER })).rejects.toMatchObject({ code: 'ledger_lost' });
    });
});

describe('body admission and entry shape', () => {
    it('keeps bodies only for admitted ops and reports skipped reasons for the rest', async () => {
        const { chromeApi, emit, bodies } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        bodies.set('doc', { body: '<html>thread</html>', base64Encoded: false });
        bodies.set('more', { body: btoa('{"comments":[]}'), base64Encoded: true });
        exchange(emit, tabId, { id: 'doc', url: 'https://www.example.test/r/test/comments/abc/title/', type: 'Document' });
        exchange(emit, tabId, { id: 'more', url: 'https://www.example.test/svc/more-comments/t3_abc', method: 'POST', type: 'XHR', postData: 'cursor=1', headers: { 'content-type': 'application/x-www-form-urlencoded' }, responseHeaders: { 'content-type': 'application/json' } });
        exchange(emit, tabId, { id: 'script', url: 'https://www.example.test/static/app.js', type: 'Script' });
        exchange(emit, tabId, { id: 'image', url: 'https://img.example.test/pic.png', type: 'Image' });
        exchange(emit, tabId, { id: 'third', url: 'https://tracker.third.test/collect', type: 'XHR' });
        exchange(emit, tabId, { id: 'chat', url: 'https://www.example.test/svc/chat/send', method: 'POST', type: 'XHR' });
        exchange(emit, tabId, { id: 'fetch', url: 'https://www.example.test/r/test/comments/abc/.json', type: 'Fetch' });
        exchange(emit, tabId, { id: 'failed', url: 'https://www.example.test/svc/more-comments/t3_def', method: 'POST', type: 'XHR', fail: true });
        await settle();

        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        const byId = Object.fromEntries(batch.entries.map((entry) => [entry.request_id, entry]));
        // Entries arrive in change order: the two bodies completed asynchronously, after the metadata-only entries.
        expect(new Set(batch.entries.map((entry) => entry.seq)).size).toBe(8);
        expect(batch.entries.slice(-2).map((entry) => entry.request_id).sort()).toEqual(['doc', 'more']);
        expect(byId.doc.body).toEqual({ state: 'complete', bytes: 19, sha256: sha256('<html>thread</html>'), encoding: 'base64' });
        expect(byId.more.body).toMatchObject({ state: 'complete', bytes: 15, sha256: sha256('{"comments":[]}') });
        expect(byId.script.body).toEqual({ state: 'skipped', reason: 'static_type', bytes: 0 });
        expect(byId.image.body).toEqual({ state: 'skipped', reason: 'static_type', bytes: 0 });
        expect(byId.third.body).toEqual({ state: 'skipped', reason: 'not_admitted', bytes: 0 });
        expect(byId.chat.body).toEqual({ state: 'skipped', reason: 'private_path', bytes: 0 });
        expect(byId.fetch.body).toEqual({ state: 'skipped', reason: 'not_admitted', bytes: 0 });
        expect(byId.failed.body).toEqual({ state: 'failed', reason: 'loading_failed', bytes: 0 });
        expect(byId.failed.error).toBe('net::ERR_FAILED');
        expect(byId.doc).toMatchObject({
            request_id: 'doc', loader_id: 'L1', frame_id: 'F1', type: 'Document', method: 'GET',
            url: 'https://www.example.test/r/test/comments/abc/title/',
            initiator: { type: 'parser', url: 'https://www.example.test/r/test/comments/abc/?token=redacted' },
            response: { status: 200, mime: 'text/html', protocol: 'h2', from_sw: false, from_cache: false, headers: [['content-type', 'text/html']] },
        });
        expect(byId.doc.t.start).toBe(1700000000000);
        expect(byId.doc.t.end).toBeGreaterThanOrEqual(byId.doc.t.response);
        expect(byId.doc.rev).toBeGreaterThan(0);
        expect(batch.state).toBe('open');
        expect(batch.tab).toEqual({ url: 'about:blank', active: false });
        expect(batch.stats).toEqual({
            entries: 8, bodies: 2, body_bytes: 34, evicted: 0,
            skipped_by_reason: { static_type: 2, not_admitted: 2, private_path: 1 },
        });
        expect(batch.next_seq).toBeGreaterThan(Math.max(...batch.entries.map((entry) => entry.seq)));
    });

    it('keeps bodies on any admitted site and marks oversize bodies too_large', async () => {
        const { chromeApi, emit, bodies } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const ops = [{ op: 'thread', method: 'GET', host: 'reddit.com', path_re: '^/r/' }, ...OPS];
        const { tabId, ledger_id } = await openLedger(runtime, { body_ops: ops, max_body_bytes: 8 });
        bodies.set('reddit', { body: 'x', base64Encoded: false });
        bodies.set('big', { body: 'y'.repeat(9), base64Encoded: false });
        exchange(emit, tabId, { id: 'reddit', url: 'https://www.reddit.com/r/test/comments/abc/', type: 'Document' });
        exchange(emit, tabId, { id: 'big', url: 'https://www.example.test/r/test/comments/abc/', type: 'Document' });
        await settle();
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        const byId = Object.fromEntries(batch.entries.map((entry) => [entry.request_id, entry]));
        expect(byId.reddit.body.state).toBe('complete');
        expect(byId.big.body).toEqual({ state: 'skipped', reason: 'too_large', bytes: 9 });
    });

    it('finalizes a redirect hop as not_applicable and tracks the follow-up request', async () => {
        const { chromeApi, emit } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        emit(tabId, 'Network.requestWillBeSent', { requestId: 'r', type: 'Document', request: { url: 'https://example.test/old', method: 'GET', headers: {} }, initiator: { type: 'other' } });
        emit(tabId, 'Network.requestWillBeSent', {
            requestId: 'r', type: 'Document', request: { url: 'https://www.example.test/r/test/comments/abc/', method: 'GET', headers: {} }, initiator: { type: 'other' },
            redirectResponse: { status: 302, headers: { location: 'https://www.example.test/r/test/comments/abc/', 'set-cookie': 'a=b' } },
        });
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        expect(batch.entries).toHaveLength(2);
        expect(batch.entries[0]).toMatchObject({ url: 'https://example.test/old', body: { state: 'not_applicable', reason: 'redirect', bytes: 0 }, response: { status: 302, headers: [['location', 'https://www.example.test/r/test/comments/abc/']] } });
        expect(batch.entries[0].t.end).toBeDefined();
        expect(batch.entries[1]).toMatchObject({ url: 'https://www.example.test/r/test/comments/abc/', body: { state: 'pending', bytes: 0 } });
    });
});

describe('redaction', () => {
    it('turns sensitive request headers, form fields, JSON keys and query values into markers', () => {
        const marker = (value) => ({ redacted: true, bytes: Buffer.byteLength(value), sha8: sha256(value).slice(0, 8) });
        expect(redactHeaders({ Authorization: 'Bearer abc', 'x-csrf-token': 'csrf-1', 'X-Client-Transaction-Id': 'tx', Accept: '*/*', Cookie: 'sid=1', 'x-session-key': 'k' })).toEqual([
            ['Authorization', marker('Bearer abc')], ['x-csrf-token', marker('csrf-1')], ['X-Client-Transaction-Id', marker('tx')],
            ['Accept', '*/*'], ['Cookie', marker('sid=1')], ['x-session-key', marker('k')],
        ]);
        expect(redactPostData('csrf_token=abc%26def&body=hello+world&page=2', 'application/x-www-form-urlencoded'))
            .toBe(`csrf_token=${JSON.stringify(marker('abc&def'))}&body=hello+world&page=2`);
        const multipart = [
            '------WebKitFormBoundaryAb12', 'Content-Disposition: form-data; name="csrf_token"', '', 'secretval',
            '------WebKitFormBoundaryAb12', 'Content-Disposition: form-data; name="text"', '', 'hello',
            '------WebKitFormBoundaryAb12--', '',
        ].join('\r\n');
        const redactedMultipart = redactPostData(multipart, 'multipart/form-data; boundary=----WebKitFormBoundaryAb12');
        expect(redactedMultipart).toContain(`name="csrf_token"\r\n\r\n${JSON.stringify(marker('secretval'))}\r\n`);
        expect(redactedMultipart).toContain('name="text"\r\n\r\nhello\r\n');
        expect(redactedMultipart).not.toContain('secretval');
        const json = JSON.stringify({ variables: { focalTweetId: '1', access_token: 'tok' }, queryId: 'q', api_key: 7, nested: [{ password: 'pw' }] });
        expect(JSON.parse(redactPostData(json, 'application/json'))).toEqual({
            variables: { focalTweetId: '1', access_token: marker('tok') }, queryId: 'q', api_key: marker('7'), nested: [{ password: marker('pw') }],
        });
        expect(redactPostData('{"token":"beacon"}', 'text/plain')).toBe(JSON.stringify({ token: marker('beacon') }));
        expect(redactPostData('not json {', 'application/json')).toEqual(marker('not json {'));
        expect(redactURL('https://x.com/i/api/graphql/abc/TweetDetail?variables=%7B%7D&sig=zz&key=k&access_token=t')).toBe('https://x.com/i/api/graphql/abc/TweetDetail?variables=%7B%7D&sig=redacted&key=redacted&access_token=redacted');
        expect(redactURL('https://x.com/home')).toBe('https://x.com/home');
        expect(sha256Hex('abc')).toBe(sha256('abc'));
    });

    it('reduces response headers to the allowlist and leaves no credential in a stored entry', async () => {
        const { chromeApi, emit } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        exchange(emit, tabId, {
            id: 'api', url: 'https://www.example.test/svc/more-comments/t3_abc?token=querysecret&sort=top', method: 'POST', type: 'XHR',
            headers: { 'content-type': 'application/json', authorization: 'Bearer headersecret', 'x-csrf-token': 'csrfsecret', 'x-client-transaction-id': 'txsecret' },
            postData: JSON.stringify({ csrf_token: 'bodysecret', ids: ['t1_a'] }),
            responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'session=cookiesecret; HttpOnly', 'x-ratelimit-remaining': '42', 'Cache-Control': 'no-store', 'x-custom': 'dropped', date: 'Tue, 04 Nov 2026 00:00:00 GMT' },
        });
        await settle();
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        const serialized = JSON.stringify(batch);
        for (const secret of ['headersecret', 'csrfsecret', 'txsecret', 'bodysecret', 'querysecret', 'cookiesecret']) expect(serialized).not.toContain(secret);
        const [entry] = batch.entries;
        expect(entry.url).toBe('https://www.example.test/svc/more-comments/t3_abc?token=redacted&sort=top');
        expect(entry.response.headers).toEqual([['content-type', 'application/json'], ['x-ratelimit-remaining', '42'], ['Cache-Control', 'no-store'], ['date', 'Tue, 04 Nov 2026 00:00:00 GMT']]);
        expect(entry.request.headers.find(([name]) => name === 'authorization')[1]).toEqual({ redacted: true, bytes: 19, sha8: sha256('Bearer headersecret').slice(0, 8) });
        expect(JSON.parse(entry.request.post_data).csrf_token).toEqual({ redacted: true, bytes: 10, sha8: sha256('bodysecret').slice(0, 8) });
    });
});

describe('bodies', () => {
    it('pages a stored body by offset and re-hashes to its sha256', async () => {
        const { chromeApi, emit, bodies } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        const raw = new Uint8Array(100);
        for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 7 + 3) % 256;
        bodies.set('doc', { body: Buffer.from(raw).toString('base64'), base64Encoded: true });
        exchange(emit, tabId, { id: 'doc', url: 'https://www.example.test/r/test/comments/abc/', type: 'Document' });
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER, wait_ms: 2000, match: { phase: 'end', admitted_only: true } });
        const [entry] = batch.entries;
        expect(entry.body).toMatchObject({ state: 'complete', bytes: 100, sha256: sha256(raw) });
        const first = await runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: entry.seq, offset: 0, length: 40 });
        const second = await runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: entry.seq, offset: 40 });
        expect(first).toMatchObject({ seq: entry.seq, offset: 0, length: 40, total: 100, sha256: sha256(raw), encoding: 'base64' });
        expect(second).toMatchObject({ offset: 40, length: 60, total: 100 });
        const joined = Buffer.concat([Buffer.from(base64ToBytes(first.data)), Buffer.from(base64ToBytes(second.data))]);
        expect(joined.equals(Buffer.from(raw))).toBe(true);
        expect(sha256(joined)).toBe(first.sha256);
    });

    it('reports non-complete bodies as body_unavailable with their state', async () => {
        const { chromeApi, emit } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        exchange(emit, tabId, { id: 'script', url: 'https://www.example.test/app.js', type: 'Script' });
        emit(tabId, 'Network.requestWillBeSent', { requestId: 'pending', type: 'Document', request: { url: 'https://www.example.test/r/a/comments/b/', method: 'GET', headers: {} }, initiator: {} });
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        const skipped = batch.entries.find((entry) => entry.request_id === 'script');
        const pending = batch.entries.find((entry) => entry.request_id === 'pending');
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: skipped.seq })).rejects.toMatchObject({ code: 'body_unavailable', data: { state: 'skipped', reason: 'static_type' } });
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: pending.seq })).rejects.toMatchObject({ code: 'body_unavailable', data: { state: 'pending' } });
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: 9999 })).rejects.toMatchObject({ code: 'body_unavailable', data: { state: 'unknown' } });
    });

    it('evicts the oldest bodies first when the ring fills and never throws', async () => {
        const { chromeApi, emit, bodies } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime, { ring_bytes: 100, max_body_bytes: 60 });
        for (const [index, id] of ['a', 'b', 'c'].entries()) {
            bodies.set(id, { body: id.repeat(40), base64Encoded: false });
            exchange(emit, tabId, { id, url: `https://www.example.test/r/test/comments/${id}${index}/`, type: 'Document' });
            await settle();
        }
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        const byId = Object.fromEntries(batch.entries.map((entry) => [entry.request_id, entry]));
        expect(byId.a.body).toEqual({ state: 'evicted', bytes: 40, sha256: sha256('a'.repeat(40)) });
        expect(byId.b.body.state).toBe('complete');
        expect(byId.c.body.state).toBe('complete');
        expect(batch.stats).toMatchObject({ bodies: 2, body_bytes: 80, evicted: 1 });
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: byId.a.seq })).rejects.toMatchObject({ code: 'body_unavailable', data: { state: 'evicted' } });
        await expect(runtime.ledgerBody({ tab_id: tabId, ledger_id, owner: OWNER, seq: byId.c.seq })).resolves.toMatchObject({ total: 40 });
    });
});

describe('reads and long-polls', () => {
    it('wakes on a matching phase start, on completion, and times out cleanly', async () => {
        const { chromeApi, emit, bodies } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        const base = { tab_id: tabId, ledger_id, owner: OWNER };

        const started = Date.now();
        const idle = await runtime.readLedger({ ...base, wait_ms: 120 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
        expect(idle).toMatchObject({ entries: [], navs: [], next_seq: 1, state: 'open' });

        const onStart = runtime.readLedger({ ...base, since: idle.next_seq, wait_ms: 5000, match: { phase: 'start', url_re: 'comments' } });
        await settle(5);
        emit(tabId, 'Network.requestWillBeSent', { requestId: 'other', type: 'XHR', request: { url: 'https://www.example.test/svc/other', method: 'GET', headers: {} }, initiator: {} });
        await settle(5);
        emit(tabId, 'Network.requestWillBeSent', { requestId: 'doc', type: 'Document', request: { url: 'https://www.example.test/r/test/comments/abc/', method: 'GET', headers: {} }, initiator: {} });
        const startBatch = await onStart;
        expect(startBatch.entries.map((entry) => entry.request_id)).toEqual(['doc']);
        expect(startBatch.entries[0].body.state).toBe('pending');

        const onEnd = runtime.readLedger({ ...base, since: startBatch.next_seq, wait_ms: 5000, match: { phase: 'end', admitted_only: true } });
        await settle(5);
        bodies.set('doc', { body: 'thread', base64Encoded: false });
        emit(tabId, 'Network.responseReceived', { requestId: 'doc', type: 'Document', response: { status: 200, mimeType: 'text/html', headers: {} } });
        emit(tabId, 'Network.loadingFinished', { requestId: 'doc' });
        const endBatch = await onEnd;
        expect(endBatch.entries).toHaveLength(1);
        expect(endBatch.entries[0]).toMatchObject({ request_id: 'doc', body: { state: 'complete', bytes: 6 } });
        expect(endBatch.entries[0].rev).toBeGreaterThan(startBatch.entries[0].rev);
        expect(endBatch.entries[0].seq).toBe(startBatch.entries[0].seq);

        const quiet = await runtime.readLedger({ ...base, since: endBatch.next_seq, wait_ms: 50 });
        expect(quiet.entries).toEqual([]);
        expect(quiet.next_seq).toBe(endBatch.next_seq);
    });

    it('resumes a byte-bounded read from next_seq without duplicating or skipping entries', async () => {
        const { chromeApi, emit } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        for (const id of ['a', 'b', 'c']) {
            exchange(emit, tabId, { id, url: `https://www.example.test/svc/${id}/${'p'.repeat(700)}`, type: 'XHR' });
        }
        const seen = [];
        let since = 0;
        for (let round = 0; round < 5; round += 1) {
            const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER, since, max_bytes: 1024 });
            seen.push(...batch.entries.map((entry) => entry.request_id));
            if (batch.next_seq === since) break;
            since = batch.next_seq;
            if (!batch.entries.length) break;
        }
        expect(seen).toEqual(['a', 'b', 'c']);
    });

    it('records main-frame navigations with the cursor and filters by method and type', async () => {
        const { chromeApi, emit } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        emit(tabId, 'Page.frameNavigated', { frame: { id: 'F1', loaderId: 'L2', url: 'https://www.example.test/r/test/?token=abc' } });
        emit(tabId, 'Page.frameNavigated', { frame: { id: 'child', parentId: 'F1', loaderId: 'L3', url: 'https://ads.example.test/' } });
        exchange(emit, tabId, { id: 'get', url: 'https://www.example.test/svc/a', type: 'XHR' });
        exchange(emit, tabId, { id: 'post', url: 'https://www.example.test/svc/b', method: 'POST', type: 'Fetch' });
        emit(tabId, 'Page.navigatedWithinDocument', { frameId: 'F1', url: 'https://www.example.test/r/test/#top' });
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER, match: { method: 'POST', types: ['Fetch'] } });
        expect(batch.entries.map((entry) => entry.request_id)).toEqual(['post']);
        expect(batch.navs).toEqual([
            { seq: 1, url: 'https://www.example.test/r/test/?token=redacted', same_document: false, loader_id: 'L2', frame_id: 'F1' },
            { seq: expect.any(Number), url: 'https://www.example.test/r/test/#top', same_document: true, loader_id: '', frame_id: 'F1' },
        ]);
        await expect(runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER, match: { url_re: '[' } })).rejects.toMatchObject({ code: 'invalid_argument' });
    });
});

describe('lifecycle', () => {
    it('marks the ledger detached on debugger detach and on detachControl, keeping entries readable', async () => {
        const { chromeApi, emit, detach } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const first = await openLedger(runtime);
        exchange(emit, first.tabId, { id: 'x', url: 'https://www.example.test/svc/x', type: 'XHR' });
        const waiting = runtime.readLedger({ tab_id: first.tabId, ledger_id: first.ledger_id, owner: OWNER, since: 100, wait_ms: 5000 });
        await settle(5);
        detach(first.tabId);
        const woke = await waiting;
        expect(woke.state).toBe('detached');
        exchange(emit, first.tabId, { id: 'late', url: 'https://www.example.test/svc/late', type: 'XHR' });
        const after = await runtime.readLedger({ tab_id: first.tabId, ledger_id: first.ledger_id, owner: OWNER });
        expect(after.entries.map((entry) => entry.request_id)).toEqual(['x']);
        expect(runtime.controlAttachments.size).toBe(0);

        const second = await openLedger(runtime);
        await runtime.detachControl({ tab_id: second.tabId });
        const detached = await runtime.readLedger({ tab_id: second.tabId, ledger_id: second.ledger_id, owner: OWNER });
        expect(detached.state).toBe('detached');
    });

    it('closes on tab removal and forgets the tab in session storage', async () => {
        const { chromeApi, removeTab, stores } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        removeTab(tabId);
        await settle(5);
        const batch = await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        expect(batch.state).toBe('closed');
        expect(batch.tab).toEqual({ url: '', active: false });
        expect(stores.session.get(OWNED_TABS_KEY)).not.toHaveProperty(String(tabId));
        expect(stores.session.get(LEDGER_TABS_KEY)).not.toHaveProperty(String(tabId));
    });

    it('close is idempotent, detaches only an attachment the ledger made, and drops the ledger', async () => {
        const { chromeApi, stores } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime);
        await expect(runtime.closeLedger({ tab_id: tabId, ledger_id, owner: OWNER })).resolves.toEqual({ closed: true });
        expect(chromeApi.debugger.detach).toHaveBeenCalledWith({ tabId }, expect.any(Function));
        await expect(runtime.closeLedger({ tab_id: tabId, ledger_id, owner: OWNER })).resolves.toEqual({ closed: true });
        await expect(runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER })).rejects.toMatchObject({ code: 'ledger_lost' });
        expect(stores.session.get(LEDGER_TABS_KEY)).toEqual({});
        expect(stores.session.get(OWNED_TABS_KEY)).toHaveProperty(String(tabId));

        await runtime.attachControl({ tab_id: tabId });
        chromeApi.debugger.detach.mockClear();
        const reopened = await runtime.openLedger({ tab_id: tabId, owner: OWNER, body_ops: OPS });
        expect(reopened.already_attached).toBe(true);
        await runtime.closeLedger({ tab_id: tabId, ledger_id: reopened.ledger_id, owner: OWNER });
        expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
    });

    it('idle reaper closes the ledger, detaches control and closes the tab', async () => {
        vi.useFakeTimers();
        const { chromeApi, stores } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const { tabId, ledger_id } = await openLedger(runtime, { idle_ms: 1000 });
        await vi.advanceTimersByTimeAsync(600);
        await runtime.readLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        await vi.advanceTimersByTimeAsync(600);
        expect(runtime.ledger.ledgers.has(tabId)).toBe(true);
        expect(chromeApi.tabs.remove).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
        expect(runtime.ledger.ledgers.has(tabId)).toBe(false);
        expect(chromeApi.debugger.detach).toHaveBeenCalledWith({ tabId }, expect.any(Function));
        expect(chromeApi.tabs.remove).toHaveBeenCalledWith(tabId, expect.any(Function));
        expect(runtime.controlAttachments.size).toBe(0);
        expect(stores.session.get(LEDGER_TABS_KEY)).toEqual({});
        expect(stores.session.get(OWNED_TABS_KEY)).toEqual({});
    });

    it('worker-start reaper closes stale ledger tabs and never a non-ledger owned tab', async () => {
        const { chromeApi, stores } = fixture({ tabs: [{ id: 5, url: 'https://www.example.test/' }, { id: 6, url: 'https://www.example.test/other' }] });
        stores.session.set(LEDGER_TABS_KEY, { 5: 1 });
        stores.session.set(OWNED_TABS_KEY, { 5: 1, 6: 1 });
        const runtime = new BrowserRuntime({ chromeApi });
        await expect(runtime.ledger.reapStaleLedgerTabs()).resolves.toEqual({ closed: [5] });
        expect(chromeApi.tabs.remove).toHaveBeenCalledTimes(1);
        expect(chromeApi.tabs.remove).toHaveBeenCalledWith(5, expect.any(Function));
        expect(chromeApi.debugger.detach).toHaveBeenCalledWith({ tabId: 5 }, expect.any(Function));
        expect(stores.session.get(LEDGER_TABS_KEY)).toEqual({});
        expect(stores.session.get(OWNED_TABS_KEY)).toEqual({ 6: 1 });
        await expect(runtime.openLedger({ tab_id: 6, owner: OWNER })).resolves.toMatchObject({ seq: 0 });
    });
});

describe('runtime wiring', () => {
    it('refuses a capture session on a tab with an open ledger', async () => {
        const { chromeApi } = fixture();
        const controller = new CDPCaptureController({ chromeApi });
        const { tabId, ledger_id } = await openLedger(controller);
        await expect(controller.action({ tab_id: tabId, expression: '1', timeout_ms: 1000 })).rejects.toMatchObject({ code: 'tab_busy' });
        expect(controller.sessions.size).toBe(0);
        await controller.closeLedger({ tab_id: tabId, ledger_id, owner: OWNER });
        controller.startSession = vi.fn(async () => { throw Object.assign(new Error('sentinel'), { code: 'sentinel' }); });
        await expect(controller.action({ tab_id: tabId, expression: '1', timeout_ms: 1000 })).rejects.toMatchObject({ code: 'sentinel' });
    });

    it('prepareRealBrowserContext sends exactly the lifecycle and focus commands', async () => {
        const { chromeApi, commands } = fixture({ tabs: [{ id: 5, url: 'https://www.example.test/' }] });
        const runtime = new BrowserRuntime({ chromeApi });
        const result = await runtime.attachControl({ tab_id: 5 });
        expect(result.context_overrides).toEqual({ 'Page.setWebLifecycleState': true, 'Emulation.setFocusEmulationEnabled': true });
        expect(commands.map((command) => [command.method, command.params])).toEqual([
            ['Page.setWebLifecycleState', { state: 'active' }],
            ['Emulation.setFocusEmulationEnabled', { enabled: true }],
        ]);
    });

    it('fetch never adopts an existing same-origin tab', async () => {
        const { chromeApi } = fixture({ tabs: [{ id: 5, url: 'https://www.example.test/home' }] });
        const controller = new CDPCaptureController({ chromeApi });
        controller.startSession = vi.fn(async () => { throw Object.assign(new Error('sentinel'), { code: 'sentinel' }); });
        await expect(controller.fetch({ url: 'https://www.example.test/api/data', timeout_ms: 1000 })).rejects.toMatchObject({ code: 'sentinel' });
        expect(chromeApi.tabs.query).not.toHaveBeenCalled();
        expect(chromeApi.tabs.create).toHaveBeenCalledWith({ url: 'https://www.example.test/', active: false }, expect.any(Function));
        expect(controller.startSession).toHaveBeenCalledWith(100, expect.objectContaining({ captureMode: 'fetch' }));
        expect(chromeApi.tabs.remove).toHaveBeenCalledWith(100, expect.any(Function));
        expect(chromeApi.tabs.remove).not.toHaveBeenCalledWith(5, expect.any(Function));
    });

    it('abandons a capture task that never settles once its deadline and drain have passed', async () => {
        vi.useFakeTimers();
        const { chromeApi } = fixture();
        const controller = new CDPCaptureController({ chromeApi });
        const hung = controller.runExplicitCapture({ timeout_ms: 1000 }, 'hung fixture', () => new Promise(() => {}));
        const abandoned = expect(hung).rejects.toMatchObject({ code: 'capture_deadline' });
        await vi.advanceTimersByTimeAsync(1000 + 5000 + 5000 + 10);
        await abandoned;
        expect(controller.captureOperationActive).toBe(false);
        expect(controller.queuedCaptures).toBe(0);
        await expect(controller.runExplicitCapture({ timeout_ms: 1000 }, 'next fixture', async (params) => params.timeout_ms)).resolves.toBe(1000);
    });

    it('native bridge backoff resets only when the host answers hello', () => {
        const ports = [];
        const hook = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } }; };
        const chromeApi = {
            runtime: {
                id: 'a'.repeat(32), getManifest: () => ({ version: '1.0.0' }), lastError: null,
                connectNative: () => { const port = { onMessage: hook(), onDisconnect: hook(), postMessage() {}, disconnect() {} }; ports.push(port); return port; },
            },
        };
        const bridge = new NativeBridge({ chromeApi });
        bridge.reconnectDelay = 8000;
        bridge.start();
        expect(bridge.isConnected()).toBe(true);
        expect(bridge.reconnectDelay).toBe(8000);
        ports[0].onMessage.emit({ action: 'bridge_status' });
        expect(bridge.reconnectDelay).toBe(8000);
        ports[0].onMessage.emit({ action: 'hello', capture_ack: true });
        expect(bridge.reconnectDelay).toBe(250);
        bridge.stop();
    });
});
