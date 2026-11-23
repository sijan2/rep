// Reduced geometry snapshot for the G2 scene graph (browser.geometry).
//
// One DOMSnapshot of a page is 6-9 MB; the scene builder in Go needs a few
// hundred nodes of it. The reduction happens here, before native messaging,
// because the extension hop is the expensive part of the round trip. The
// reducer is a pure function over canned CDP results so it can be tested
// without a browser; captureGeometry is the thin CDP wrapper around it.

export const STYLE_PROPS = ['display', 'visibility', 'opacity', 'pointer-events', 'cursor'];
// Attributes that make a node a key carrier (kept even when hidden). Policy
// callers extend this with site keys; the defaults cover Reddit (thingid) and
// X (data-testid, href) plus the generic identity attributes.
export const DEFAULT_KEY_ATTRS = ['thingid', 'data-testid', 'id', 'slot', 'href', 'aria-label', 'aria-labelledby', 'role', 'type', 'name'];
// Emitted when present because the scene builder names controls and reads
// time/heading structure from them, but they do not make a node a key carrier.
const NAME_ATTRS = ['title', 'alt', 'datetime', 'tabindex', 'aria-modal', 'aria-level', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-haspopup', 'disabled', 'placeholder'];
const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'option', 'radio', 'combobox']);
const STRUCTURE_TAGS = new Set(['dialog', 'time', 'article']);
// Text under these never renders, so it is noise for a reader.
const OPAQUE_TEXT_PARENTS = new Set(['script', 'style', 'noscript', 'template']);
const MAX_TEXT_BYTES = 160;
const MAX_ATTR_BYTES = 256;
export const MAX_GEOMETRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MIN_MAX_BYTES = 4096;
const MAX_KEY_ATTRS = 32;

const failure = (code, message) => Object.assign(new Error(message), { code });
const encoder = new TextEncoder();

function byteLength(text) {
    return encoder.encode(text).length;
}

// Cuts on a code point boundary so a truncated label is still valid UTF-8 and
// never ends in half a surrogate pair.
function truncateBytes(text, max) {
    if (byteLength(text) <= max) return text;
    let bytes = 0;
    let out = '';
    for (const char of text) {
        const size = byteLength(char);
        if (bytes + size > max) break;
        bytes += size;
        out += char;
    }
    return out;
}

function collapse(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function round2(value) {
    return Math.round(Number(value) * 100) / 100;
}

function tabIdFrom(params) {
    const tabId = Number(params.tab_id);
    if (!Number.isInteger(tabId) || tabId < 0) throw failure('invalid_argument', 'tab_id must be a non-negative integer');
    return tabId;
}

function clampBytes(value) {
    if (value == null || value === '') return DEFAULT_MAX_BYTES;
    const number = Number(value);
    if (!Number.isFinite(number)) throw failure('invalid_argument', 'max_bytes must be a number');
    if (number > MAX_GEOMETRY_BYTES) throw failure('invalid_argument', `max_bytes must be at most ${MAX_GEOMETRY_BYTES}`);
    return Math.max(MIN_MAX_BYTES, Math.round(number));
}

function attributeNames(value, fallback, what) {
    if (value == null) return fallback;
    if (!Array.isArray(value) || value.length > MAX_KEY_ATTRS) throw failure('invalid_argument', `${what} must be an array of at most ${MAX_KEY_ATTRS} names`);
    const names = [];
    for (const name of value) {
        if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_:-]*$/.test(name)) throw failure('invalid_argument', `${what} entries must be attribute or property names`);
        const lower = name.toLowerCase();
        if (!names.includes(lower)) names.push(lower);
    }
    return names;
}

// The document for the frame we were asked about; same-process child frames
// ride along in `documents` but their boxes are in their own coordinate space,
// so they are left unobserved rather than misplaced.
function pickDocument(snapshot, frame) {
    const documents = snapshot?.documents || [];
    const strings = snapshot?.strings || [];
    if (frame?.id) {
        const match = documents.find((doc) => strings[doc.frameId] === frame.id);
        if (match) return match;
    }
    return documents[0] || null;
}

function viewportFrom(metrics) {
    const visual = metrics?.cssVisualViewport || null;
    const layout = metrics?.cssLayoutViewport || null;
    const source = visual || layout || {};
    const content = metrics?.cssContentSize || {};
    // Device pixels per CSS pixel, taken as a ratio of the two viewport
    // reports so it is not rounded the way window.devicePixelRatio is.
    const deviceWidth = metrics?.visualViewport?.clientWidth ?? metrics?.layoutViewport?.clientWidth;
    const cssWidth = source.clientWidth;
    const scale = deviceWidth > 0 && cssWidth > 0 ? round2(deviceWidth / cssWidth) : 1;
    return {
        scale,
        viewport: { x: round2(source.pageX || 0), y: round2(source.pageY || 0), w: round2(source.clientWidth || 0), h: round2(source.clientHeight || 0) },
        content: { w: round2(content.width || 0), h: round2(content.height || 0) },
    };
}

function intersects(box, viewport) {
    return box[0] < viewport.x + viewport.w && box[0] + box[2] > viewport.x && box[1] < viewport.y + viewport.h && box[1] + box[3] > viewport.y;
}

function verticalDistance(box, viewport) {
    if (intersects(box, viewport)) return 0;
    if (box[1] + box[3] <= viewport.y) return viewport.y - (box[1] + box[3]);
    return box[1] - (viewport.y + viewport.h);
}

export function reduceSnapshot(snapshot, metrics, frame, options = {}) {
    const keys = new Set((options.keys || DEFAULT_KEY_ATTRS).map((name) => name.toLowerCase()));
    const styleNames = options.styles || STYLE_PROPS;
    const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    const strings = snapshot?.strings || [];
    const doc = pickDocument(snapshot, frame);
    if (!doc) throw failure('geometry_failed', 'DOMSnapshot returned no document');

    const nodes = doc.nodes || {};
    const layout = doc.layout || {};
    const count = nodes.parentIndex?.length || 0;
    const parentIndex = nodes.parentIndex || [];
    const nodeType = nodes.nodeType || [];
    const stylePos = STYLE_PROPS.map((name) => styleNames.indexOf(name));

    const layoutOf = new Int32Array(count).fill(-1);
    for (let li = 0; li < (layout.nodeIndex?.length || 0); li++) layoutOf[layout.nodeIndex[li]] = li;

    const uaShadow = new Uint8Array(count);
    for (let k = 0; k < (nodes.shadowRootType?.index?.length || 0); k++) {
        if (strings[nodes.shadowRootType.value[k]] === 'user-agent') uaShadow[nodes.shadowRootType.index[k]] = 1;
    }

    const tag = new Array(count);
    const attrs = new Array(count);
    const box = new Array(count);
    const style = new Array(count);
    const paint = new Int32Array(count).fill(-1);
    const text = new Array(count);
    // Under a user-agent shadow root (input internals, media controls) or an
    // opacity:0 ancestor nothing is perceivable, and computed opacity does not
    // inherit, so both facts are propagated down the tree explicitly.
    const excluded = new Uint8Array(count);
    const faded = new Uint8Array(count);

    for (let i = 0; i < count; i++) {
        const parent = parentIndex[i];
        const type = nodeType[i];
        if (parent >= 0 && (excluded[parent] || uaShadow[parent])) excluded[i] = 1;
        if (type === 1) tag[i] = String(strings[nodes.nodeName[i]] || '').toLowerCase();
        else if (type === 3) tag[i] = '#text';
        else tag[i] = null;

        const li = layoutOf[i];
        if (li >= 0) {
            const bounds = layout.bounds?.[li];
            if (bounds && bounds.length === 4) box[i] = bounds.map(round2);
            else box[i] = null;
            const raw = layout.styles?.[li] || [];
            style[i] = stylePos.map((pos) => (pos >= 0 && raw[pos] != null ? String(strings[raw[pos]] ?? '') : ''));
            paint[i] = layout.paintOrders?.[li] ?? -1;
        } else {
            box[i] = null;
            style[i] = null;
        }

        if (type === 1) {
            const flat = nodes.attributes?.[i] || [];
            const map = new Map();
            for (let k = 0; k + 1 < flat.length; k += 2) {
                const name = String(strings[flat[k]] || '').toLowerCase();
                if (!map.has(name)) map.set(name, String(strings[flat[k + 1]] ?? ''));
            }
            attrs[i] = map;
        } else {
            attrs[i] = null;
        }

        const opacity = style[i] ? Number(style[i][2]) : NaN;
        if ((parent >= 0 && faded[parent]) || opacity === 0) faded[i] = 1;

        text[i] = type === 3 ? truncateBytes(collapse(strings[nodes.nodeValue[i]]), MAX_TEXT_BYTES) : '';
    }

    // cursor is an inherited property, so every descendant of a pointer
    // element reports pointer too; only the element where it starts is a
    // candidate control, the rest are its parts.
    const inheritedCursor = (i) => {
        let p = parentIndex[i];
        while (p >= 0 && !style[p]) p = parentIndex[p];
        return p >= 0 ? style[p][4] : '';
    };

    const keep = new Uint8Array(count);
    const isText = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        if (excluded[i]) continue;
        const type = nodeType[i];
        const visible = Boolean(box[i]) && (box[i][2] > 0 || box[i][3] > 0) && !faded[i]
            && style[i]?.[0] !== 'none' && style[i]?.[1] !== 'hidden' && style[i]?.[1] !== 'collapse';
        if (type === 3) {
            const parent = parentIndex[i];
            const parentTag = parent >= 0 ? tag[parent] : null;
            if (!text[i] || OPAQUE_TEXT_PARENTS.has(parentTag)) continue;
            // <svg><title> never lays out, yet it is the only name an icon
            // button has; it is kept so the scene can name the control.
            const svgTitle = parentTag === 'title' && parent >= 0 && parentIndex[parent] >= 0 && tag[parentIndex[parent]] !== 'head';
            if (visible || svgTitle) {
                keep[i] = 1;
                isText[i] = 1;
            }
            continue;
        }
        if (type !== 1) continue;
        const a = attrs[i];
        let keyed = false;
        for (const name of keys) {
            if (a.get(name)) { keyed = true; break; }
        }
        const role = (a.get('role') || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
        const tabindex = Number(a.get('tabindex'));
        const interactive = (tag[i] === 'a' && a.has('href'))
            || (INTERACTIVE_TAGS.has(tag[i]) && !(tag[i] === 'input' && (a.get('type') || '').toLowerCase() === 'hidden'))
            || INTERACTIVE_ROLES.has(role)
            || (Number.isInteger(tabindex) && tabindex >= 0)
            || (style[i]?.[4] === 'pointer' && inheritedCursor(i) !== 'pointer');
        const structural = /^h[1-6]$/.test(tag[i]) || role === 'heading' || STRUCTURE_TAGS.has(tag[i]) || a.has('aria-modal');
        if (keyed || ((interactive || structural) && visible)) keep[i] = 1;
    }

    // Ancestors give the builder containment; document and shadow-root nodes
    // are not elements, so marking passes through them to the host.
    for (let i = count - 1; i >= 0; i--) {
        if (!keep[i]) continue;
        let p = parentIndex[i];
        while (p >= 0) {
            if (nodeType[p] === 1) {
                if (keep[p]) break;
                keep[p] = 1;
                break;
            }
            p = parentIndex[p];
        }
    }

    const geometry = viewportFrom(metrics);
    const frameId = frame?.id || strings[doc.frameId] || '';
    const url = frame?.url || strings[doc.documentURL] || '';
    const emitAttrs = [...keys, ...NAME_ATTRS.filter((name) => !keys.has(name))];

    const assemble = () => {
        const index = new Int32Array(count).fill(-1);
        const out = { parent: [], backend: [], tag: [], role: [], attrs: [], box: [], paint: [], style: [], text: [] };
        for (let i = 0; i < count; i++) {
            if (!keep[i]) continue;
            index[i] = out.parent.length;
            let p = parentIndex[i];
            while (p >= 0 && index[p] < 0) p = parentIndex[p];
            out.parent.push(p >= 0 ? index[p] : -1);
            out.backend.push(nodes.backendNodeId?.[i] ?? 0);
            out.tag.push(tag[i]);
            const a = attrs[i];
            out.role.push(a ? ((a.get('role') || '').trim().split(/\s+/)[0]?.toLowerCase() || '') : '');
            if (a) {
                const pairs = [];
                for (const name of emitAttrs) {
                    if (a.has(name)) pairs.push([name, truncateBytes(a.get(name), MAX_ATTR_BYTES)]);
                }
                out.attrs.push(pairs.length ? pairs : null);
            } else {
                out.attrs.push(null);
            }
            out.box.push(box[i]);
            out.paint.push(paint[i]);
            out.style.push(style[i]);
            out.text.push(text[i]);
        }
        return out;
    };

    let droppedText = 0;
    let result = {
        frame_id: frameId,
        loader_id: frame?.loaderId || '',
        url,
        scale: geometry.scale,
        viewport: geometry.viewport,
        content: geometry.content,
        nodes: assemble(),
        dropped_text: 0,
    };
    let size = byteLength(JSON.stringify(result));
    if (size > maxBytes) {
        // Text is the bulk and the least structural; far-offscreen text goes
        // first so the viewport the agent is reading keeps its words longest.
        const candidates = [];
        for (let i = 0; i < count; i++) {
            if (keep[i] && isText[i]) candidates.push(i);
        }
        candidates.sort((a, b) => {
            const da = box[a] ? verticalDistance(box[a], geometry.viewport) : Infinity;
            const db = box[b] ? verticalDistance(box[b], geometry.viewport) : Infinity;
            return db - da || b - a;
        });
        let cursor = 0;
        while (size > maxBytes && cursor < candidates.length) {
            let estimate = size;
            while (estimate > maxBytes && cursor < candidates.length) {
                const i = candidates[cursor++];
                keep[i] = 0;
                droppedText++;
                // Roughly the JSON footprint of one text row across the nine
                // columns; the five-string style tuple is most of it.
                estimate -= 70 + byteLength(text[i]) + (box[i] ? 24 : 4);
            }
            result = { ...result, nodes: assemble(), dropped_text: droppedText };
            size = byteLength(JSON.stringify(result));
        }
    }
    return result;
}

// browser.geometry: attach only when nobody else holds the tab, and never
// detach an attachment another owner created (same rule as page-control.js).
export async function captureGeometry(runtime, params = {}) {
    const tabId = tabIdFrom(params);
    const maxBytes = clampBytes(params.max_bytes);
    const keys = attributeNames(params.keys, DEFAULT_KEY_ATTRS, 'keys');
    const extraStyles = attributeNames(params.styles, [], 'styles');
    const styles = [...STYLE_PROPS, ...extraStyles.filter((name) => !STYLE_PROPS.includes(name))];
    const debuggee = { tabId };
    const attached = Boolean(runtime.isCaptureAttached?.(tabId)) || runtime.controlAttachments.has(`tab:${tabId}`);
    if (!attached) {
        await runtime.debugAttachTarget(debuggee);
        await runtime.prepareRealBrowserContext(debuggee);
    }
    try {
        const tree = await runtime.sendDebugCommand(debuggee, 'Page.getFrameTree', {});
        const metrics = await runtime.sendDebugCommand(debuggee, 'Page.getLayoutMetrics', {});
        const snapshot = await runtime.sendDebugCommand(debuggee, 'DOMSnapshot.captureSnapshot', {
            computedStyles: styles,
            includePaintOrder: true,
            includeDOMRects: true,
        });
        return reduceSnapshot(snapshot, metrics, tree?.frameTree?.frame || null, { keys, styles, maxBytes });
    } finally {
        if (!attached) await runtime.debugDetachTarget(debuggee).catch(() => {});
    }
}
