// Fast page control for agents: readiness-based navigation and screenshots.
// Navigation waits on Chromium lifecycle events instead of network idle, so an
// agent that only needs an interactive page does not pay capture settle time.

export const WAIT_MODES = ['commit', 'domcontentloaded', 'load', 'networkidle', 'settled'];
const LIFECYCLE = { domcontentloaded: 'DOMContentLoaded', load: 'load', networkidle: 'networkIdle' };
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const SETTLE_QUIET_MS = 200;
const SETTLE_MAX_MS = 3000;
export const SCREENSHOT_FORMATS = ['png', 'jpeg', 'webp'];
// Base64 crosses native messaging, whose host reader accepts 32 MiB.
export const MAX_SCREENSHOT_BASE64 = 24 * 1024 * 1024;
const MAX_CAPTURE_DIMENSION = 16384;

const failure = (code, message, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

function integer(value, fallback, minimum, maximum) {
    const number = value == null || value === '' ? fallback : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function tabIdFrom(params) {
    const tabId = Number(params.tab_id);
    if (!Number.isInteger(tabId) || tabId < 0) throw failure('invalid_argument', 'tab_id must be a non-negative integer');
    return tabId;
}

// One page operation per tab at a time; different tabs run concurrently.
function serialize(runtime, tabId, work) {
    runtime.pageTails ||= new Map();
    const previous = runtime.pageTails.get(tabId) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    const tail = result.catch(() => {});
    runtime.pageTails.set(tabId, tail);
    tail.then(() => { if (runtime.pageTails.get(tabId) === tail) runtime.pageTails.delete(tabId); });
    return result;
}

function assertControllable(runtime, tabId, operation) {
    runtime.assertReloadNotPending(operation);
    if (runtime.isCapturingTab(tabId)) throw failure('tab_busy', `tab ${tabId} has an active capture`);
    if (runtime.semantic?.activeExecution(tabId)) throw failure('tab_busy', 'tab has an active execution lease');
}

// Reuse capture, control, or observation attachments; otherwise attach only for
// this operation. Detaching an attachment another owner created is never done.
async function withAttachment(runtime, tabId, work) {
    const debuggee = { tabId };
    const attached = runtime.isCaptureAttached(tabId) || runtime.controlAttachments.has(`tab:${tabId}`);
    if (!attached) {
        await runtime.debugAttachTarget(debuggee);
        await runtime.prepareRealBrowserContext(debuggee);
    }
    try {
        return await work(debuggee);
    } finally {
        if (!attached) await runtime.debugDetachTarget(debuggee).catch(() => {});
    }
}

function lifecycleWaiter(runtime, tabId, frameId) {
    const events = [];
    let notify = null;
    const remove = runtime.addDebuggerEventListener((source, method, params) => {
        if (source?.tabId !== tabId || source.sessionId || method !== 'Page.lifecycleEvent' || params?.frameId !== frameId) return;
        events.push({ name: params.name, loaderId: params.loaderId || '', at: Date.now() });
        notify?.();
    });
    return {
        events,
        remove,
        // Resolves with the matching event, or null at the deadline.
        wait(name, loaderId, deadline) {
            return new Promise((resolve) => {
                const check = () => {
                    const found = events.find(event => event.name === name && (!loaderId || event.loaderId === loaderId));
                    if (found) { finish(found); return true; }
                    return false;
                };
                let timer = null;
                const finish = (value) => { notify = null; if (timer) clearTimeout(timer); resolve(value); };
                if (check()) return;
                notify = check;
                timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
            });
        },
    };
}

function settleExpression(quietMs, maxMs) {
    return `new Promise(resolve => {
        const started = performance.now();
        let last = started;
        const observer = new MutationObserver(() => { last = performance.now(); });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const tick = () => {
            const now = performance.now();
            const quiet = now - last >= ${quietMs};
            if (quiet || now - started >= ${maxMs}) {
                observer.disconnect();
                resolve({ quiet, waited_ms: Math.round(now - started) });
            } else setTimeout(tick, Math.min(50, ${quietMs}));
        };
        setTimeout(tick, ${quietMs});
    })`;
}

const PAINTED_FRAME_EXPRESSION = `new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(true); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 300);
})`;

const PAGE_STATE_EXPRESSION = `(() => {
    const entry = performance.getEntriesByType('navigation')[0];
    return { url: location.href, title: document.title, ready_state: document.readyState,
        http_status: entry && entry.responseStatus ? entry.responseStatus : null };
})()`;

async function evaluateValue(runtime, debuggee, expression, awaitPromise = false) {
    const response = await runtime.sendDebugCommand(debuggee, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (response?.exceptionDetails) return null;
    return response?.result?.value ?? null;
}

export async function navigate(runtime, params = {}) {
    const wait = String(params.wait || 'load').toLowerCase();
    if (!WAIT_MODES.includes(wait)) throw failure('invalid_argument', `wait must be one of ${WAIT_MODES.join(', ')}`);
    const timeoutMs = integer(params.timeout_ms, DEFAULT_NAVIGATION_TIMEOUT_MS, 100, 120000);
    let tabId;
    let created = false;
    if (params.tab_id == null) {
        runtime.assertReloadNotPending('navigate a tab');
        const tab = await runtime.call(runtime.chrome.tabs, 'create', { url: 'about:blank', active: Boolean(params.active) });
        tabId = tab.id;
        created = true;
    } else {
        tabId = tabIdFrom(params);
    }
    let url, referrer;
    try {
        url = params.url === 'about:blank' ? 'about:blank' : normalizeNavigationURL(params.url);
        referrer = params.referrer ? normalizeNavigationURL(params.referrer) : '';
    } catch (error) {
        if (created) await runtime.call(runtime.chrome.tabs, 'remove', tabId).catch(() => {});
        throw error;
    }
    const operation = serialize(runtime, tabId, async () => {
        assertControllable(runtime, tabId, 'navigate a tab');
        return withAttachment(runtime, tabId, async (debuggee) => {
            const started = Date.now();
            const deadline = started + timeoutMs;
            await runtime.sendDebugCommand(debuggee, 'Page.enable', {});
            await runtime.sendDebugCommand(debuggee, 'Page.setLifecycleEventsEnabled', { enabled: true });
            const tree = await runtime.sendDebugCommand(debuggee, 'Page.getFrameTree', {});
            const frameId = tree?.frameTree?.frame?.id;
            if (!frameId) throw failure('invalid_frame_tree', 'browser returned no root frame');
            const waiter = lifecycleWaiter(runtime, tabId, frameId);
            try {
                const navigation = await runtime.sendDebugCommand(debuggee, 'Page.navigate', { url, ...(referrer ? { referrer } : {}) });
                if (navigation?.errorText) throw failure('navigation_failed', navigation.errorText, { url, tab_id: tabId });
                const loaderId = navigation?.loaderId || '';
                const sameDocument = !loaderId;
                const result = { tab_id: tabId, created_tab: created, requested_url: url, wait, same_document: sameDocument, timed_out: false, reached: 'commit' };
                const lifecycle = {};
                if (!sameDocument && ['domcontentloaded', 'load', 'networkidle', 'settled'].includes(wait)) {
                    const order = wait === 'domcontentloaded' ? ['domcontentloaded'] : wait === 'networkidle' ? ['domcontentloaded', 'load', 'networkidle'] : ['domcontentloaded', 'load'];
                    for (const stage of order) {
                        const event = await waiter.wait(LIFECYCLE[stage], loaderId, deadline);
                        if (!event) { result.timed_out = true; break; }
                        lifecycle[`${stage}_ms`] = event.at - started;
                        result.reached = stage;
                    }
                }
                if (wait === 'settled' && !result.timed_out) {
                    const remaining = deadline - Date.now();
                    const settled = remaining > SETTLE_QUIET_MS ? await evaluateValue(runtime, debuggee, settleExpression(SETTLE_QUIET_MS, Math.min(SETTLE_MAX_MS, remaining)), true) : null;
                    result.dom_quiet = Boolean(settled?.quiet);
                    if (settled) { lifecycle.settled_ms = Date.now() - started; result.reached = 'settled'; }
                }
                const state = await evaluateValue(runtime, debuggee, PAGE_STATE_EXPRESSION);
                Object.assign(result, {
                    url: state?.url || '', title: state?.title || '', ready_state: state?.ready_state || '',
                    http_status: state?.http_status ?? null, loader_id: loaderId, lifecycle, duration_ms: Date.now() - started,
                });
                if (result.timed_out) {
                    throw failure('navigation_timeout', `navigation did not reach ${wait} within ${timeoutMs} ms (reached ${result.reached})`, result);
                }
                return result;
            } finally {
                waiter.remove();
            }
        });
    });
    if (!created) return operation;
    // A tab created for this call is closed on hard failure. After a timeout it
    // remains usable and the error data names it.
    return operation.catch(async (error) => {
        if (error?.code !== 'navigation_timeout') await runtime.call(runtime.chrome.tabs, 'remove', tabId).catch(() => {});
        throw error;
    });
}

function normalizeNavigationURL(input) {
    let value = String(input || '').trim();
    if (!value) throw failure('invalid_url', 'URL is required');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw failure('invalid_url', `Invalid URL: ${input}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw failure('invalid_url', 'Only http:// and https:// URLs are supported');
    return parsed.href;
}

export async function screenshot(runtime, params = {}) {
    const tabId = tabIdFrom(params);
    const format = String(params.format || 'png').toLowerCase();
    if (!SCREENSHOT_FORMATS.includes(format)) throw failure('invalid_argument', `format must be one of ${SCREENSHOT_FORMATS.join(', ')}`);
    const fullPage = Boolean(params.full_page);
    const selector = params.selector == null ? '' : String(params.selector);
    if (fullPage && selector) throw failure('invalid_argument', 'choose either full_page or selector');
    if (selector.length > 4096) throw failure('invalid_argument', 'selector is too long');
    const quality = format === 'png' ? undefined : integer(params.quality, 80, 1, 100);
    return serialize(runtime, tabId, async () => {
        runtime.assertReloadNotPending('capture a screenshot');
        return withAttachment(runtime, tabId, async (debuggee) => {
            const started = Date.now();
            const command = { format, optimizeForSpeed: true, fromSurface: true, ...(quality ? { quality } : {}) };
            let clip = null;
            if (fullPage || selector) {
                const metrics = await runtime.sendDebugCommand(debuggee, 'Page.getLayoutMetrics', {});
                const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
                if (fullPage) {
                    const size = metrics?.cssContentSize || metrics?.contentSize || {};
                    clip = { x: 0, y: 0, width: Math.ceil(size.width || 0), height: Math.ceil(size.height || 0), scale: 1 };
                } else {
                    const box = await evaluateValue(runtime, debuggee, `(() => {
                        const element = document.querySelector(${JSON.stringify(selector)});
                        if (!element) return null;
                        const rect = element.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                    })()`);
                    if (!box) throw failure('element_not_found', 'selector matched no element in the top frame');
                    if (!(box.width > 0 && box.height > 0)) throw failure('element_not_visible', 'selected element has no rendered size');
                    clip = { x: box.x + (viewport.pageX || 0), y: box.y + (viewport.pageY || 0), width: box.width, height: box.height, scale: 1 };
                }
                if (!(clip.width > 0 && clip.height > 0)) throw failure('screenshot_failed', 'page has no rendered area');
                clip.width = Math.min(clip.width, MAX_CAPTURE_DIMENSION);
                clip.height = Math.min(clip.height, MAX_CAPTURE_DIMENSION);
                command.clip = clip;
                command.captureBeyondViewport = true;
            }
            // A capture right after load can precede rasterization of the full
            // viewport (observed ~1 in 24 fresh tabs as a blank lower half). Two
            // animation frames guarantee an activated frame with viewport tiles.
            await evaluateValue(runtime, debuggee, PAINTED_FRAME_EXPRESSION, true);
            const response = await runtime.sendDebugCommand(debuggee, 'Page.captureScreenshot', command);
            const data = response?.data;
            if (typeof data !== 'string' || !data) throw failure('screenshot_failed', 'browser returned no image data');
            if (data.length > MAX_SCREENSHOT_BASE64) {
                throw failure('screenshot_too_large', 'screenshot exceeds the native transport budget; use jpeg/webp, a lower quality, or a selector', { base64_bytes: data.length });
            }
            return { tab_id: tabId, format, full_page: fullPage, selector: selector || undefined, clip, quality, data, duration_ms: Date.now() - started };
        });
    });
}
