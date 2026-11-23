import { describe, expect, it, vi } from 'vitest';
import { captureGeometry, reduceSnapshot, STYLE_PROPS, DEFAULT_KEY_ATTRS, MAX_GEOMETRY_BYTES } from '../js/background/semantic-geometry.js';

// ---- fixtures ----------------------------------------------------------
// A tiny DOM description compiled into the columnar DOMSnapshot wire format,
// so the reducer is exercised on the exact shape Chromium emits: a shared
// string table, flat [nameIdx, valueIdx] attribute arrays, a layout tree that
// only holds rendered nodes, and shadow roots as #document-fragment nodes.

const DEFAULT_STYLE = { display: 'block', visibility: 'visible', opacity: '1', 'pointer-events': 'auto', cursor: 'auto' };

export function el(tag, attrs = {}, layout = {}, ...children) {
    return { tag, attrs, layout, children };
}
export function text(value, layout = {}) {
    return { text: value, layout };
}
export function shadow(options, ...children) {
    if (options && typeof options === 'object' && !Array.isArray(options) && !('tag' in options) && !('text' in options) && !('shadow' in options)) {
        return { shadow: options.ua ? 'user-agent' : 'open', children };
    }
    return { shadow: 'open', children: [options, ...children] };
}

export function buildSnapshot(roots, { styleNames = STYLE_PROPS, frameId = 'F1', url = 'https://example.test/' } = {}) {
    const strings = [];
    const stringIndex = new Map();
    const S = (value) => {
        const key = String(value);
        if (!stringIndex.has(key)) {
            stringIndex.set(key, strings.length);
            strings.push(key);
        }
        return stringIndex.get(key);
    };
    const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], backendNodeId: [], attributes: [], shadowRootType: { index: [], value: [] } };
    const layout = { nodeIndex: [], styles: [], bounds: [], text: [], paintOrders: [] };
    let backend = 100;
    let paint = 0;

    function push(type, name, value, parent) {
        const index = nodes.parentIndex.length;
        nodes.parentIndex.push(parent);
        nodes.nodeType.push(type);
        nodes.nodeName.push(S(name));
        nodes.nodeValue.push(S(value));
        nodes.backendNodeId.push(backend++);
        nodes.attributes.push([]);
        return index;
    }
    function lay(index, box, style, textValue) {
        if (!box) return;
        layout.nodeIndex.push(index);
        const merged = { ...DEFAULT_STYLE, ...(style || {}) };
        layout.styles.push(styleNames.map((name) => S(merged[name] ?? '')));
        layout.bounds.push(box);
        layout.text.push(S(textValue ?? ''));
        layout.paintOrders.push(paint++);
    }
    // Children inherit the parent's box and style unless they say otherwise;
    // a parent without layout (display:none) takes its subtree with it.
    function visit(spec, parent, inherited) {
        if (spec.text !== undefined) {
            const index = push(3, '#text', spec.text, parent);
            const box = spec.layout.box === undefined ? inherited.box : spec.layout.box;
            lay(index, inherited.box ? box : null, { ...inherited.style, ...(spec.layout.style || {}) }, spec.text);
            return;
        }
        if (spec.shadow) {
            const index = push(11, '#document-fragment', '', parent);
            nodes.shadowRootType.index.push(index);
            nodes.shadowRootType.value.push(S(spec.shadow));
            for (const child of spec.children) visit(child, index, inherited);
            return;
        }
        const index = push(1, spec.tag.toUpperCase(), '', parent);
        const flat = [];
        for (const [name, value] of Object.entries(spec.attrs)) flat.push(S(name), S(value));
        nodes.attributes[index] = flat;
        const style = { ...inherited.style, ...(spec.layout.style || {}) };
        const box = spec.layout.box === undefined ? inherited.box : spec.layout.box;
        const rendered = inherited.box !== null || spec.layout.box ? box : null;
        lay(index, rendered, style);
        for (const child of spec.children) visit(child, index, { box: rendered, style });
    }
    const docIndex = push(9, '#document', '', -1);
    for (const root of roots) visit(root, docIndex, { box: null, style: DEFAULT_STYLE });
    return { documents: [{ documentURL: S(url), frameId: S(frameId), nodes, layout }], strings };
}

export const METRICS = {
    layoutViewport: { pageX: 0, pageY: 0, clientWidth: 2400, clientHeight: 1800 },
    visualViewport: { pageX: 0, pageY: 0, clientWidth: 2400, clientHeight: 1800, scale: 1 },
    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 900 },
    cssVisualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 900, scale: 1 },
    cssContentSize: { width: 1200, height: 2400 },
};
export const FRAME = { id: 'F1', loaderId: 'L1', url: 'https://www.reddit.com/r/email/comments/abc123/why_do_smtp_relays_charge_per_1k/' };
export const X_FRAME = { id: 'F2', loaderId: 'L9', url: 'https://x.com/bob/status/1851000000000000001' };

const LONG_COMMENT = 'SMTP relays charge per 1k because deliverability costs scale with volume: reputation monitoring, bounce handling and ISP feedback loops all cost money per message.';

function actionRow(x, y, score, more = false) {
    const buttons = [
        el('button', { 'aria-label': 'Upvote' }, { box: [x, y, 32, 32], style: { cursor: 'pointer' } }, el('svg', {}, {}, el('path', {}))),
        el('faceplate-number', {}, { box: [x + 36, y, 24, 32] }, text(String(score))),
        el('button', { 'aria-label': 'Downvote' }, { box: [x + 64, y, 32, 32], style: { cursor: 'pointer' } }, el('svg', {}, {}, el('path', {}))),
        el('button', {}, { box: [x + 104, y, 80, 32], style: { cursor: 'pointer' } }, el('svg', {}, { box: [x + 108, y + 8, 16, 16] }), el('span', {}, { box: [x + 128, y, 50, 32] }, text('Reply'))),
        el('button', {}, { box: [x + 192, y, 80, 32], style: { cursor: 'pointer' } }, el('span', {}, {}, text('Share'))),
    ];
    if (more) {
        buttons.push(el('shreddit-overflow-menu', {}, { box: [x + 280, y, 32, 32] },
            shadow(el('button', { 'aria-label': 'More options' }, { box: [x + 280, y, 32, 32] }, el('svg', {}, {}, el('title', {}, { box: null }, text('Overflow')))))));
    }
    return el('shreddit-comment-action-row', { slot: 'actionRow' }, { box: [x, y, 700, 32] }, shadow({}, el('span', { class: 'flex' }, {}, ...buttons)));
}

function meta(x, y, author, when, ...extra) {
    return el('div', { slot: 'commentMeta' }, { box: [x, y, 600, 24] },
        el('faceplate-tracker', {}, { box: [x, y, 48, 24] }, el('a', { href: `/user/${author}/` }, {}, text(author))),
        el('faceplate-timeago', {}, { box: [x + 64, y, 60, 24] }, el('time', { datetime: '2026-10-31T10:00:00.000Z' }, {}, text(when))),
        ...extra);
}

function comment(x, y, body) {
    return el('div', { slot: 'comment' }, { box: [x, y, 1168 - x, 56] }, el('p', {}, {}, text(body)));
}

export function redditFixture() {
    const root = el('html', { lang: 'en' }, { box: [0, 0, 1200, 2400] },
        el('head', {}, { box: null }, el('title', {}, {}, text('Why do SMTP relays charge per 1k? : r/email')), el('script', {}, {}, text('window.__x = 1;'))),
        el('body', {}, {},
            el('shreddit-app', {}, {},
                el('header', { id: 'header' }, { box: [0, 0, 1200, 56] },
                    el('a', { href: '/', 'aria-label': 'Home' }, { box: [16, 8, 40, 40] }, el('svg', {}, {}, el('path', {}))),
                    // Icon-only button whose only name is its <svg><title>.
                    el('button', {}, { box: [60, 8, 40, 40] }, el('svg', {}, {}, el('title', {}, { box: null }, text('Notifications')), el('path', {}))),
                    el('span', { id: 'lbl-1' }, { box: [700, 16, 60, 24] }, text('Sort by')),
                    el('button', { 'aria-labelledby': 'lbl-1', 'aria-haspopup': 'menu' }, { box: [770, 8, 40, 40] }, el('svg', {}, {}, el('path', {}))),
                    el('input', { type: 'text', name: 'q', placeholder: 'Search Reddit' }, { box: [200, 12, 400, 32] },
                        shadow({ ua: true }, el('div', {}, {}, text('Search Reddit')))),
                    el('button', { id: 'expand-search', 'aria-label': 'Search' }, { box: null }, el('svg', {}, {}, el('path', {}))),
                    el('a', { id: 'login-hidden', href: '/login' }, { box: [1100, 8, 80, 40], style: { visibility: 'hidden' } }, text('Log In'))),
                el('main', {}, { box: [0, 56, 1200, 2300] },
                    el('shreddit-post', { id: 't3_post1', author: 'op' }, { box: [0, 64, 1200, 280] },
                        el('h1', {}, { box: [16, 72, 1168, 40] }, text('Why do SMTP relays charge per 1k emails?')),
                        el('div', { slot: 'text-body' }, { box: [16, 120, 1168, 200] }, el('p', {}, {}, text('Trying to understand the pricing model before we commit.')))),
                    el('shreddit-comment-tree', {}, { box: [0, 360, 1200, 1900] },
                        el('shreddit-comment', { thingid: 't1_abc', author: 'alice', depth: '0', score: '41' }, { box: [0, 360, 1200, 440] },
                            meta(16, 368, 'alice', '4d ago',
                                el('span', {}, { box: [150, 368, 60, 24], style: { cursor: 'pointer' } }, text('Collapse'))),
                            comment(16, 400, LONG_COMMENT),
                            actionRow(16, 464, 41, true),
                            el('shreddit-comment', { thingid: 't1_def', author: 'bob', depth: '1', score: '7' }, { box: [32, 512, 1168, 280] },
                                meta(48, 520, 'bob', '3d ago'),
                                comment(48, 552, 'Thanks, that clears it up.'),
                                actionRow(48, 584, 7),
                                el('shreddit-comment', { thingid: 't1_ghi', author: 'carol', depth: '2', score: '3' }, { box: [64, 632, 1136, 150] },
                                    meta(80, 640, 'carol', '2d ago'),
                                    comment(80, 672, 'Agreed — the feedback loops are the hidden cost.'),
                                    actionRow(80, 704, 3)))),
                        el('shreddit-comment', { thingid: 't1_jkl', author: 'dave', depth: '0', score: '5' }, { box: [0, 816, 1200, 120] },
                            meta(16, 824, 'dave', '1d ago'),
                            comment(16, 856, 'Different angle: the per-1k pricing mirrors how ISPs throttle.'),
                            actionRow(16, 888, 5)),
                        el('faceplate-partial', {}, { box: [0, 948, 1200, 32] },
                            el('button', {}, { box: [32, 948, 160, 32], style: { cursor: 'pointer' } }, text('3 more replies'))),
                        el('shreddit-comment', { thingid: 't1_mno', author: 'erin', depth: '0', score: '2' }, { box: [0, 1000, 1200, 120] },
                            meta(16, 1008, 'erin', '20h ago'),
                            comment(16, 1040, 'Late reply here.'),
                            actionRow(16, 1072, 2))),
                    el('div', { id: 'comments-footer' }, { box: [0, 1800, 1200, 48] },
                        el('button', {}, { box: [16, 1808, 200, 32] }, text('View more comments'))),
                    el('div', {}, { box: [0, 2300, 100, 100], style: { opacity: '0' } },
                        el('button', {}, {}, text('Ghost')))))));
    const snapshot = buildSnapshot([root], { frameId: 'F1', url: FRAME.url });
    // An ad iframe document: a same-process child frame rides along in the
    // snapshot but its coordinates are its own, so it must be ignored.
    const child = buildSnapshot([el('html', {}, { box: [0, 0, 300, 250] }, el('body', {}, {}, el('a', { href: 'https://ads.test/' }, {}, text('Ad'))))], { frameId: 'child', url: 'https://ads.test/frame' });
    snapshot.documents.push({ ...child.documents[0], documentURL: snapshot.strings.push('https://ads.test/frame') - 1, frameId: snapshot.strings.push('child') - 1 });
    return snapshot;
}

function tweetActions(x, y, replies, likes, views, status) {
    return el('div', { role: 'group', 'aria-label': `${replies} replies, 5 reposts, ${likes} likes, ${views} views` }, { box: [x, y, 576, 40] },
        el('button', { 'data-testid': 'reply', 'aria-label': `${replies} Replies. Reply` }, { box: [x, y, 60, 40] }, el('span', {}, {}, text(String(replies)))),
        el('button', { 'data-testid': 'retweet', 'aria-label': '5 reposts. Repost' }, { box: [x + 80, y, 60, 40] }, el('span', {}, {}, text('5'))),
        el('button', { 'data-testid': 'like', 'aria-label': `${likes} Likes. Like` }, { box: [x + 160, y, 60, 40] }, el('span', {}, {}, text(String(likes)))),
        el('a', { href: `/bob/status/${status}/analytics`, 'aria-label': `${views} views. View post analytics` }, { box: [x + 240, y, 60, 40] }, el('span', {}, {}, text('3K'))),
        el('button', { 'data-testid': 'bookmark', 'aria-label': 'Bookmark' }, { box: [x + 320, y, 40, 40] }),
        el('button', { 'aria-label': 'Share post' }, { box: [x + 370, y, 40, 40] }));
}

function userName(x, y, handle, name, timeAnchor) {
    return el('div', { 'data-testid': 'User-Name' }, { box: [x, y, 400, 20] },
        el('a', { href: `/${handle}`, role: 'link' }, { box: [x, y, 30, 20] }, el('span', {}, {}, text(name))),
        el('a', { href: `/${handle}`, role: 'link', tabindex: '-1' }, { box: [x + 36, y, 40, 20] }, el('span', {}, {}, text(`@${handle}`))),
        ...(timeAnchor ? [timeAnchor] : []));
}

function permalink(x, y, handle, status, when) {
    return el('a', { href: `/${handle}/status/${status}`, role: 'link' }, { box: [x, y, 60, 20] }, el('time', { datetime: '2026-11-04T08:00:00.000Z' }, {}, text(when)));
}

export function xFixture() {
    const root = el('html', { lang: 'en' }, { box: [0, 0, 688, 3000] },
        el('head', {}, { box: null }, el('title', {}, {}, text('Bob on X'))),
        el('body', {}, {},
            el('div', { id: 'react-root' }, {},
                el('header', { role: 'banner' }, { box: [0, 0, 88, 900] },
                    el('nav', { 'aria-label': 'Primary' }, {},
                        el('a', { href: '/home', 'aria-label': 'Home' }, { box: [8, 8, 50, 50] }, el('svg', {}, {}, el('path', {}))),
                        el('a', { href: '/explore', 'aria-label': 'Search and explore' }, { box: [8, 64, 50, 50] }, el('svg', {}, {}, el('path', {}))))),
                el('main', { role: 'main' }, { box: [88, 0, 600, 3000] },
                    el('section', { 'aria-labelledby': 'accessible-list-0', role: 'region' }, { box: [88, 53, 600, 2900] },
                        el('h1', { id: 'accessible-list-0', dir: 'auto' }, { box: [88, 53, 0, 0] }, text('Conversation')),
                        el('div', { 'aria-label': 'Timeline: Conversation' }, { box: [88, 53, 600, 2800] },
                            el('div', { 'data-testid': 'cellInnerDiv' }, { box: [88, 53, 600, 480] },
                                el('article', { 'data-testid': 'tweet', role: 'article', tabindex: '-1' }, { box: [88, 53, 600, 480] },
                                    userName(160, 65, 'bob', 'Bob', null),
                                    el('div', { 'data-testid': 'tweetText', lang: 'en' }, { box: [100, 95, 576, 48] }, el('span', {}, {}, text('Shipping today: the new perception layer lands with records, controls and handles.'))),
                                    // The quote block is a role=link container; its own permalink
                                    // anchor wraps a <time> and appears before the outer tweet's.
                                    el('div', { role: 'link', tabindex: '0' }, { box: [100, 151, 576, 160], style: { cursor: 'pointer' } },
                                        el('div', { 'data-testid': 'User-Name' }, { box: [112, 159, 400, 20] },
                                            el('span', {}, { box: [112, 159, 40, 20] }, text('Carol')),
                                            el('span', {}, { box: [156, 159, 50, 20] }, text('@carol')),
                                            el('a', { href: '/carol/status/1849000000000000009', role: 'link' }, { box: [300, 159, 50, 20] }, el('time', { datetime: '2026-10-28T12:00:00.000Z' }, {}, text('Oct 28')))),
                                        el('div', { 'data-testid': 'tweetText', lang: 'en' }, { box: [112, 187, 552, 48] }, el('span', {}, {}, text('Original post: we measured 0 of 546 controls tied to a comment.')))),
                                    permalink(100, 319, 'bob', '1851000000000000001', '2h'),
                                    tweetActions(100, 347, 26, 120, 3000, '1851000000000000001'))),
                            el('div', { 'data-testid': 'cellInnerDiv' }, { box: [88, 541, 600, 200] },
                                el('article', { 'data-testid': 'tweet', role: 'article', tabindex: '-1' }, { box: [88, 541, 600, 200] },
                                    userName(160, 553, 'dan', 'Dan', permalink(260, 553, 'dan', '1851000000000000002', '1h')),
                                    el('div', { 'data-testid': 'tweetText', lang: 'en' }, { box: [160, 581, 516, 48] }, el('span', {}, {}, text('Does this handle quoted posts?'))),
                                    tweetActions(160, 641, 1, 4, 80, '1851000000000000002'))),
                            el('div', { 'data-testid': 'cellInnerDiv' }, { box: [88, 1300, 600, 200] },
                                el('article', { 'data-testid': 'tweet', role: 'article', tabindex: '-1' }, { box: [88, 1300, 600, 200] },
                                    userName(160, 1312, 'erin', 'Erin', permalink(260, 1312, 'erin', '1851000000000000003', '45m')),
                                    el('div', { 'data-testid': 'tweetText', lang: 'en' }, { box: [160, 1340, 516, 48] }, el('span', {}, {}, text('Late to the thread.'))),
                                    tweetActions(160, 1400, 0, 2, 12, '1851000000000000003'))),
                            el('div', { 'data-testid': 'cellInnerDiv' }, { box: [88, 1512, 600, 48] },
                                el('div', { role: 'button', tabindex: '0' }, { box: [100, 1520, 576, 32], style: { cursor: 'pointer' } }, el('span', {}, {}, text('Show more replies')))),
                            el('div', { 'data-testid': 'cellInnerDiv' }, { box: [88, 2800, 600, 48] },
                                el('div', { role: 'button', tabindex: '0' }, { box: [100, 2808, 576, 32], style: { cursor: 'pointer' } }, el('span', {}, {}, text('Show probable spam'))))))))));
    return buildSnapshot([root], { frameId: 'F2', url: X_FRAME.url });
}

export const X_METRICS = {
    layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1376, clientHeight: 1800 },
    visualViewport: { pageX: 0, pageY: 0, clientWidth: 1376, clientHeight: 1800, scale: 1 },
    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 688, clientHeight: 900 },
    cssVisualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 688, clientHeight: 900, scale: 1 },
    cssContentSize: { width: 688, height: 3000 },
};

// ---- tests -------------------------------------------------------------

function column(reduced, name) {
    return reduced.nodes[name];
}
function attr(reduced, i, name) {
    const pairs = reduced.nodes.attrs[i];
    if (!pairs) return undefined;
    const hit = pairs.find(([k]) => k === name);
    return hit ? hit[1] : undefined;
}
function findAll(reduced, predicate) {
    const out = [];
    for (let i = 0; i < reduced.nodes.tag.length; i++) if (predicate(i)) out.push(i);
    return out;
}
function textNodes(reduced) {
    return findAll(reduced, (i) => reduced.nodes.tag[i] === '#text').map((i) => reduced.nodes.text[i]);
}
function ancestors(reduced, i) {
    const chain = [];
    for (let p = reduced.nodes.parent[i]; p >= 0; p = reduced.nodes.parent[p]) chain.push(p);
    return chain;
}

describe('reduceSnapshot: columnar shape', () => {
    const reduced = reduceSnapshot(redditFixture(), METRICS, FRAME, { keys: DEFAULT_KEY_ATTRS, styles: STYLE_PROPS, maxBytes: 512 * 1024 });

    it('carries frame identity and CSS-pixel geometry', () => {
        expect(reduced.frame_id).toBe('F1');
        expect(reduced.loader_id).toBe('L1');
        expect(reduced.url).toBe(FRAME.url);
        expect(reduced.scale).toBe(2);
        expect(reduced.viewport).toEqual({ x: 0, y: 0, w: 1200, h: 900 });
        expect(reduced.content).toEqual({ w: 1200, h: 2400 });
        expect(reduced.dropped_text).toBe(0);
    });

    it('keeps every column index-aligned with parents before children', () => {
        const n = reduced.nodes.tag.length;
        for (const name of ['parent', 'backend', 'tag', 'role', 'attrs', 'box', 'paint', 'style', 'text']) expect(column(reduced, name)).toHaveLength(n);
        expect(reduced.nodes.parent[0]).toBe(-1);
        for (let i = 1; i < n; i++) {
            expect(reduced.nodes.parent[i]).toBeGreaterThanOrEqual(0);
            expect(reduced.nodes.parent[i]).toBeLessThan(i);
        }
        expect(reduced.nodes.tag[0]).toBe('html');
        for (const style of reduced.nodes.style) if (style) expect(style).toHaveLength(5);
    });

    it('ignores child-frame documents', () => {
        expect(textNodes(reduced)).not.toContain('Ad');
        expect(findAll(reduced, (i) => attr(reduced, i, 'href') === 'https://ads.test/')).toHaveLength(0);
    });
});

describe('reduceSnapshot: Reddit-like thread', () => {
    const reduced = reduceSnapshot(redditFixture(), METRICS, FRAME, {});

    it('keeps the comment containers with their thingid keys', () => {
        const comments = findAll(reduced, (i) => reduced.nodes.tag[i] === 'shreddit-comment');
        expect(comments.map((i) => attr(reduced, i, 'thingid'))).toEqual(['t1_abc', 't1_def', 't1_ghi', 't1_jkl', 't1_mno']);
        // Nested replies are descendants of their parent comment in the kept tree.
        const [abc, def, ghi] = comments;
        expect(ancestors(reduced, def)).toContain(abc);
        expect(ancestors(reduced, ghi)).toContain(def);
    });

    it('flattens shadow roots so action-row buttons hang under their comment', () => {
        const upvotes = findAll(reduced, (i) => attr(reduced, i, 'aria-label') === 'Upvote');
        expect(upvotes).toHaveLength(5);
        expect(reduced.nodes.tag).not.toContain('#document-fragment');
        const abc = findAll(reduced, (i) => attr(reduced, i, 'thingid') === 't1_abc')[0];
        expect(ancestors(reduced, upvotes[0])).toContain(abc);
        // The doubly nested overflow menu button comes through too.
        const more = findAll(reduced, (i) => attr(reduced, i, 'aria-label') === 'More options');
        expect(more).toHaveLength(1);
        expect(ancestors(reduced, more[0])).toContain(abc);
        // Its svg <title> text survives without a box so the control can be named.
        const overflow = findAll(reduced, (i) => reduced.nodes.text[i] === 'Overflow');
        expect(overflow).toHaveLength(1);
        expect(reduced.nodes.box[overflow[0]]).toBeNull();
        const bell = findAll(reduced, (i) => reduced.nodes.text[i] === 'Notifications');
        expect(bell).toHaveLength(1);
        expect(reduced.nodes.tag[reduced.nodes.parent[bell[0]]]).toBe('title');
        expect(textNodes(reduced)).toContain('Sort by');
    });

    it('keeps cursor:pointer and text controls with their names as text nodes', () => {
        const texts = textNodes(reduced);
        expect(texts).toContain('Reply');
        expect(texts).toContain('Share');
        expect(texts).toContain('Collapse');
        expect(texts).toContain('3 more replies');
        expect(texts).toContain('View more comments');
        expect(texts).toContain('41');
        expect(texts).toContain('4d ago');
        const collapse = findAll(reduced, (i) => reduced.nodes.text[i] === 'Collapse')[0];
        expect(reduced.nodes.style[reduced.nodes.parent[collapse]][4]).toBe('pointer');
        // Descendants inherit cursor:pointer; the icon paths inside pointer
        // buttons are parts of the button, not candidates of their own.
        expect(reduced.nodes.tag).not.toContain('path');
        const replyButtons = findAll(reduced, (i) => reduced.nodes.tag[i] === 'button' && reduced.nodes.style[i]?.[4] === 'pointer');
        expect(replyButtons.length).toBeGreaterThan(0);
        for (const b of replyButtons) {
            expect(findAll(reduced, (i) => reduced.nodes.parent[i] === b && reduced.nodes.tag[i] === 'svg')).toHaveLength(0);
        }
    });

    it('collapses whitespace and caps text at 160 bytes', () => {
        const long = textNodes(reduced).find((t) => t.startsWith('SMTP relays charge'));
        expect(long).toBeDefined();
        expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(160);
        expect(long.length).toBeLessThan(LONG_COMMENT.length);
        expect(textNodes(reduced)).toContain('Agreed — the feedback loops are the hidden cost.');
    });

    it('drops hidden and unrendered nodes unless they carry a key', () => {
        const texts = textNodes(reduced);
        expect(texts).not.toContain('Ghost');
        expect(texts).not.toContain('Search Reddit');
        expect(texts).not.toContain('window.__x = 1;');
        expect(texts).not.toContain('Why do SMTP relays charge per 1k? : r/email');
        // display:none but keyed (id, aria-label): kept with no box so the
        // scene can report it hidden rather than pretend it does not exist.
        const search = findAll(reduced, (i) => attr(reduced, i, 'id') === 'expand-search');
        expect(search).toHaveLength(1);
        expect(reduced.nodes.box[search[0]]).toBeNull();
        expect(reduced.nodes.style[search[0]]).toBeNull();
        const login = findAll(reduced, (i) => attr(reduced, i, 'id') === 'login-hidden');
        expect(login).toHaveLength(1);
        expect(reduced.nodes.style[login[0]][1]).toBe('hidden');
        expect(texts).not.toContain('Log In');
    });

    it('emits only key and name attributes, in CSS pixels, with paint order', () => {
        const abc = findAll(reduced, (i) => attr(reduced, i, 'thingid') === 't1_abc')[0];
        expect(reduced.nodes.attrs[abc].map(([k]) => k)).toEqual(['thingid']);
        expect(reduced.nodes.box[abc]).toEqual([0, 360, 1200, 440]);
        expect(reduced.nodes.paint[abc]).toBeGreaterThanOrEqual(0);
        const time = findAll(reduced, (i) => reduced.nodes.tag[i] === 'time')[0];
        expect(attr(reduced, time, 'datetime')).toBe('2026-10-31T10:00:00.000Z');
        expect(reduced.nodes.role[abc]).toBe('');
    });

    it('honours extra key attributes requested by the caller', () => {
        const withScore = reduceSnapshot(redditFixture(), METRICS, FRAME, { keys: [...DEFAULT_KEY_ATTRS, 'author', 'score'] });
        const abc = findAll(withScore, (i) => attr(withScore, i, 'thingid') === 't1_abc')[0];
        expect(attr(withScore, abc, 'author')).toBe('alice');
        expect(attr(withScore, abc, 'score')).toBe('41');
    });
});

describe('reduceSnapshot: X-like conversation', () => {
    const reduced = reduceSnapshot(xFixture(), X_METRICS, X_FRAME, {});

    it('keeps tweet articles, their permalink anchors wrapping <time>, and the quote block', () => {
        const articles = findAll(reduced, (i) => reduced.nodes.tag[i] === 'article' && attr(reduced, i, 'data-testid') === 'tweet');
        expect(articles).toHaveLength(3);
        const times = findAll(reduced, (i) => reduced.nodes.tag[i] === 'time');
        expect(times).toHaveLength(4);
        for (const t of times) {
            const parent = reduced.nodes.parent[t];
            expect(reduced.nodes.tag[parent]).toBe('a');
            expect(attr(reduced, parent, 'href')).toMatch(/\/status\/\d+$/);
        }
        const quote = findAll(reduced, (i) => reduced.nodes.role[i] === 'link' && reduced.nodes.tag[i] === 'div');
        expect(quote).toHaveLength(1);
        expect(ancestors(reduced, quote[0])).toContain(articles[0]);
        // The quote's time anchor sits inside the quote container, the outer
        // tweet's permalink outside it; both are children of the first article.
        const quoteTime = times.find((t) => ancestors(reduced, t).includes(quote[0]));
        const outerTime = times.find((t) => ancestors(reduced, t).includes(articles[0]) && !ancestors(reduced, t).includes(quote[0]));
        expect(attr(reduced, reduced.nodes.parent[quoteTime], 'href')).toBe('/carol/status/1849000000000000009');
        expect(attr(reduced, reduced.nodes.parent[outerTime], 'href')).toBe('/bob/status/1851000000000000001');
    });

    it('keeps the action rows and the orphan continuation buttons', () => {
        expect(findAll(reduced, (i) => attr(reduced, i, 'data-testid') === 'like')).toHaveLength(3);
        const texts = textNodes(reduced);
        expect(texts).toContain('Show more replies');
        expect(texts).toContain('Show probable spam');
        expect(texts).toContain('@bob');
        expect(texts).toContain('@carol');
        expect(texts).not.toContain('Conversation');
    });

    it('reports the X viewport geometry', () => {
        expect(reduced.viewport).toEqual({ x: 0, y: 0, w: 688, h: 900 });
        expect(reduced.content).toEqual({ w: 688, h: 3000 });
        expect(reduced.scale).toBe(2);
    });
});

describe('reduceSnapshot: byte budget', () => {
    it('drops text nodes first, farthest from the viewport, and reports the count', () => {
        const full = reduceSnapshot(redditFixture(), METRICS, FRAME, {});
        const fullBytes = new TextEncoder().encode(JSON.stringify(full)).length;
        // Room for a handful of rows below the full size: only the farthest
        // offscreen text should go.
        const budget = fullBytes - 150;
        const reduced = reduceSnapshot(redditFixture(), METRICS, FRAME, { maxBytes: budget });
        expect(new TextEncoder().encode(JSON.stringify(reduced)).length).toBeLessThanOrEqual(budget);
        expect(reduced.dropped_text).toBeGreaterThan(0);
        expect(reduced.dropped_text).toBeLessThanOrEqual(4);
        expect(textNodes(reduced).length).toBe(textNodes(full).length - reduced.dropped_text);
        // Structure survives intact: every element the full reduction kept is still here.
        const elements = (r) => findAll(r, (i) => r.nodes.tag[i] !== '#text').map((i) => r.nodes.backend[i]);
        expect(elements(reduced)).toEqual(elements(full));
        // Offscreen words go before the viewport's words.
        expect(textNodes(reduced)).not.toContain('View more comments');
        expect(textNodes(reduced)).toContain('Reply');
        expect(textNodes(reduced)).toContain('4d ago');
        for (let i = 1; i < reduced.nodes.tag.length; i++) expect(reduced.nodes.parent[i]).toBeLessThan(i);
    });

    it('never drops elements even when the budget is below the structural floor', () => {
        const reduced = reduceSnapshot(redditFixture(), METRICS, FRAME, { maxBytes: 4096 });
        expect(textNodes(reduced)).toHaveLength(0);
        expect(findAll(reduced, (i) => reduced.nodes.tag[i] === 'shreddit-comment')).toHaveLength(5);
    });
});

describe('captureGeometry', () => {
    function runtime({ attached = false, snapshot = redditFixture(), metrics = METRICS, frame = FRAME } = {}) {
        const calls = [];
        return {
            calls,
            controlAttachments: new Map(attached ? [['tab:7', { tabId: 7 }]] : []),
            isCaptureAttached: vi.fn(() => false),
            debugAttachTarget: vi.fn(async () => { calls.push('attach'); }),
            debugDetachTarget: vi.fn(async () => { calls.push('detach'); }),
            prepareRealBrowserContext: vi.fn(async () => { calls.push('prepare'); return {}; }),
            sendDebugCommand: vi.fn(async (debuggee, method, params) => {
                calls.push(method);
                expect(debuggee).toEqual({ tabId: 7 });
                if (method === 'Page.getFrameTree') return { frameTree: { frame } };
                if (method === 'Page.getLayoutMetrics') return metrics;
                if (method === 'DOMSnapshot.captureSnapshot') {
                    expect(params.includePaintOrder).toBe(true);
                    expect(params.includeDOMRects).toBe(true);
                    expect(params.computedStyles.slice(0, 5)).toEqual(STYLE_PROPS);
                    return snapshot;
                }
                throw new Error(`unexpected ${method}`);
            }),
        };
    }

    it('attaches only for the call and detaches afterwards', async () => {
        const rt = runtime();
        const reduced = await captureGeometry(rt, { tab_id: 7, max_bytes: 200000 });
        expect(rt.calls).toEqual(['attach', 'prepare', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'DOMSnapshot.captureSnapshot', 'detach']);
        expect(reduced.frame_id).toBe('F1');
        expect(reduced.loader_id).toBe('L1');
        expect(findAll(reduced, (i) => reduced.nodes.tag[i] === 'shreddit-comment')).toHaveLength(5);
    });

    it('reuses an attachment another owner holds and never detaches it', async () => {
        const rt = runtime({ attached: true });
        await captureGeometry(rt, { tab_id: 7 });
        expect(rt.calls).toEqual(['Page.getFrameTree', 'Page.getLayoutMetrics', 'DOMSnapshot.captureSnapshot']);
        expect(rt.debugDetachTarget).not.toHaveBeenCalled();
    });

    it('detaches even when the snapshot fails', async () => {
        const rt = runtime();
        rt.sendDebugCommand = vi.fn(async (_d, method) => {
            rt.calls.push(method);
            if (method === 'DOMSnapshot.captureSnapshot') throw new Error('target closed');
            return method === 'Page.getFrameTree' ? { frameTree: { frame: FRAME } } : METRICS;
        });
        await expect(captureGeometry(rt, { tab_id: 7 })).rejects.toThrow('target closed');
        expect(rt.calls.at(-1)).toBe('detach');
    });

    it('passes extra keys and styles through to the snapshot request', async () => {
        const rt = runtime();
        const reduced = await captureGeometry(rt, { tab_id: 7, keys: ['thingid', 'author'], styles: ['position'] });
        const snapshotCall = rt.sendDebugCommand.mock.calls.find(([, method]) => method === 'DOMSnapshot.captureSnapshot');
        expect(snapshotCall[2].computedStyles).toEqual([...STYLE_PROPS, 'position']);
        const abc = findAll(reduced, (i) => attr(reduced, i, 'thingid') === 't1_abc')[0];
        expect(attr(reduced, abc, 'author')).toBe('alice');
    });

    it('rejects bad arguments before touching the debugger', async () => {
        const rt = runtime();
        await expect(captureGeometry(rt, { tab_id: 'x' })).rejects.toMatchObject({ code: 'invalid_argument' });
        await expect(captureGeometry(rt, { tab_id: 7, max_bytes: MAX_GEOMETRY_BYTES + 1 })).rejects.toMatchObject({ code: 'invalid_argument' });
        await expect(captureGeometry(rt, { tab_id: 7, keys: ['bad attr'] })).rejects.toMatchObject({ code: 'invalid_argument' });
        expect(rt.debugAttachTarget).not.toHaveBeenCalled();
    });
});
