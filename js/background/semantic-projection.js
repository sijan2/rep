// The model projection deliberately excludes URLs, HTML, attributes and field values.
// Frame URLs are binding metadata only; callers must not include them in model state.
const words = value => new Set(value.split(' '));
const controls = words('button checkbox combobox link listbox menuitem menuitemcheckbox menuitemradio option radio scrollbar searchbox slider spinbutton switch tab textbox treeitem');
const texts = words('statictext heading paragraph labeltext caption legend term definition');
const containers = words('row layouttablerow listitem article');
const relationRoles = words('row layouttablerow listitem article columnheader rowheader heading form dialog table layouttable grid group region list listbox navigation main banner complementary');
const safeStates = words('checked selected expanded pressed required readonly invalid modal busy');
const safeEnums = words('mixed true false grammar spelling');
const encoder = new TextEncoder();

export async function digest(value) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function scrub(value, limit) {
    const full = String(value || '')
        .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, '[link omitted]')
        .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email omitted]')
        .replace(/\b(?:bearer\s+\S+|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/gi, '[credential omitted]')
        .replace(/[\s\p{Cc}]+/gu, ' ').trim();
    let result = '', size = 0;
    for (const char of full) {
        size += encoder.encode(char).length;
        if (size > limit) break;
        result += char;
    }
    return { value: result, truncated: result !== full };
}

const roleOf = node => String(node?.role?.value || '').toLowerCase();
const nameOf = node => typeof node?.name?.value === 'string' ? node.name.value : '';
const property = (node, name) => (node.properties || []).find(item => item.name === name)?.value?.value;
const blocked = node => ['disabled', 'hidden'].some(name => [true, 'true'].includes(property(node, name)));
const editable = node => ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(roleOf(node))
    || ['editable', 'richlyEditable'].some(name => [true, 'true', 'plaintext', 'richtext'].includes(property(node, name)));
// A frame's document node is named by the page title, which every candidate in
// that frame shares, so it never distinguishes one candidate from another.
const documentRoot = node => ['rootwebarea', 'webarea'].includes(roleOf(node));
const headingLevel = node => {
    const level = Number(property(node, 'level'));
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
};

// Map each node to the nearest preceding heading in document order: the label a
// reader sees for the section that contains it. A heading maps to the nearest
// preceding heading of a higher level. Order follows childIds, then response order.
function sectionHeadings(nodes, byID, children) {
    const result = new Map(), stack = new Array(7).fill(''), visited = new Set();
    const nearest = below => {
        for (let level = below - 1; level >= 1; level--) if (stack[level]) return stack[level];
        return '';
    };
    const pending = nodes.filter(node => !node.parentId || !byID.has(node.parentId)).reverse().map(node => ({ id: node.nodeId, depth: 0 }));
    while (pending.length) {
        const { id, depth } = pending.pop();
        const node = byID.get(id);
        if (!node || visited.has(id) || depth > 256) continue;
        visited.add(id);
        const name = nameOf(node).trim();
        const heading = roleOf(node) === 'heading' && !node.ignored && !blocked(node) && Boolean(name);
        const level = heading ? headingLevel(node) : stack.length;
        result.set(id, nearest(level));
        if (heading) {
            stack[level] = name;
            for (let deeper = level + 1; deeper < stack.length; deeper++) stack[deeper] = '';
        }
        const next = Array.isArray(node.childIds) && node.childIds.length ? node.childIds : (children.get(id) || []).map(child => child.nodeId);
        for (let index = next.length - 1; index >= 0; index--) pending.push({ id: next[index], depth: depth + 1 });
    }
    return result;
}

function statesOf(node) {
    const states = {};
    for (const item of node.properties || []) {
        const value = item.value?.value;
        if (safeStates.has(item.name) && (typeof value === 'boolean' || safeEnums.has(value))) states[item.name] = value;
    }
    return states;
}

// Return both the scrubbed projection and raw semantic evidence for its local digest.
export async function projectAX(nodes, frame, kind = 'controls', options = {}) {
    const byID = new Map(nodes.map(node => [node.nodeId, node]));
    const children = new Map();
    for (const node of nodes) {
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node);
    }
    const headings = sectionHeadings(nodes, byID, children), topFrame = !frame.parentID;
    const candidates = [], evidence = [], seen = new Set(), rowCache = new Map();
    const maxCandidates = options.maxCandidates ?? 4096, maxBytes = options.maxBytes ?? 512 * 1024;
    let omittedNodes = 0, textTruncated = 0, totalCandidates = 0, bytes = 0, evidenceBytes = 0;
    function rowText(root) {
        if (rowCache.has(root.nodeId)) return rowCache.get(root.nodeId);
        const labels = [], visited = new Set(), pending = [...(children.get(root.nodeId) || [])].reverse().map(node => ({ node, depth: 0 }));
        let exhausted = false;
        while (pending.length) {
            const { node, depth } = pending.pop();
            if (visited.has(node.nodeId)) continue;
            if (visited.size >= 2048 || depth >= 64) { exhausted = true; break; }
            visited.add(node.nodeId);
            if (blocked(node) || editable(node) || (controls.has(roleOf(node)) && roleOf(node) !== 'link')) continue;
            const name = nameOf(node).trim();
            if (!node.ignored && (texts.has(roleOf(node)) || roleOf(node) === 'link') && name && !labels.includes(name)) labels.push(name);
            if (roleOf(node) !== 'link') pending.push(...[...(children.get(node.nodeId) || [])].reverse().map(node => ({ node, depth: depth + 1 })));
        }
        if (exhausted) omittedNodes++;
        const value = labels.join(' | ');
        rowCache.set(root.nodeId, value);
        return value;
    }
    for (const node of nodes) {
        const role = roleOf(node);
        const allowed = ((kind === 'controls' || kind === 'all') && controls.has(role)) || ((kind === 'text' || kind === 'all') && texts.has(role));
        if (node.ignored || !(node.backendDOMNodeId > 0) || !allowed || !nameOf(node).trim() || (!controls.has(role) && editable(node))) continue;
        if (options.allowedNodeIDs && !options.allowedNodeIDs.has(node.nodeId)) continue;
        if (node.frameId && node.frameId !== frame.id) continue;
        let isBlocked = blocked(node), context = '', parentID = node.parentId, rowSeen = false, nativePopup = false;
        const visited = new Set([node.nodeId]), relations = [];
        for (let depth = 0; parentID && depth < 64; depth++) {
            const parent = byID.get(parentID);
            if (!parent || visited.has(parentID)) break;
            visited.add(parentID);
            isBlocked ||= blocked(parent);
            if (roleOf(parent) === 'menulistpopup') nativePopup = true;
            if (editable(parent)) {
                if (roleOf(parent) === 'combobox' && (role === 'option' || role.startsWith('menuitem'))) {
                    // An option names its owning control: a native <select>
                    // (reached through its MenuListPopup) or an ARIA combobox.
                    // Options with equal labels in different dropdowns stay
                    // distinguishable, and a native option can be chosen through
                    // its select rather than by an ineffective click.
                    const owner = nameOf(parent).trim();
                    if (owner && owner !== nameOf(node).trim() && !relations.some(item => item.name === owner)) relations.push({ role: nativePopup ? 'select' : 'combobox', name: owner });
                    parentID = parent.parentId;
                    continue;
                }
                isBlocked = true;
                parentID = '';
                break;
            }
            const parentName = nameOf(parent);
            if (!context && !parent.ignored && parentName && parentName !== nameOf(node) && !(topFrame && documentRoot(parent))) context = parentName;
            if (!rowSeen && containers.has(roleOf(parent))) {
                rowSeen = true;
                const summary = rowText(parent);
                if (summary) relations.push({ role: roleOf(parent), name: summary });
            }
            if (!parent.ignored && parentName && parentName !== nameOf(node) && relationRoles.has(roleOf(parent))) {
                if (!relations.some(item => item.role === roleOf(parent) && item.name === parentName)) relations.push({ role: roleOf(parent), name: parentName });
            }
            parentID = parent.parentId;
        }
        if (parentID) { omittedNodes++; continue; }
        if (isBlocked) continue;
        // The section heading is added only when it tells the model something new
        // and never displaces entity or ancestor relations.
        const heading = (headings.get(node.nodeId) || '').trim();
        if (heading && heading !== nameOf(node).trim() && heading !== context && relations.length < 8 && !relations.some(item => item.name === heading)) {
            relations.push({ role: 'heading', name: heading });
        }
        totalCandidates++;
        if (candidates.length >= maxCandidates) { omittedNodes++; continue; }
        const id = `c_${(await digest(`${frame.id}:${node.backendDOMNodeId}`)).slice(0, 16)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const states = statesOf(node);
        const rawEvidence = [id, role, nameOf(node), context, states, relations];
        const rawBytes = encoder.encode(JSON.stringify(rawEvidence)).length;
        if (evidenceBytes + rawBytes > 256 * 1024) { omittedNodes++; continue; }
        const name = scrub(nameOf(node), 180), label = scrub(context, 120);
        let truncated = name.truncated || label.truncated || relations.length > 8;
        const contextRelations = relations.slice(0, 8).map(item => {
            const name = scrub(item.name, 240);
            truncated ||= name.truncated;
            return { role: item.role, name: name.value };
        });
        const candidate = { id, role, name: name.value, ...(label.value ? { context: label.value } : {}),
            ...(Object.keys(states).length ? { states } : {}), ...(contextRelations.length ? { context_relations: contextRelations } : {}),
            ...(truncated ? { text_truncated: true } : {}), frame_id: frame.id, frame_url: frame.url,
            session_id: frame.sessionId, document_generation: frame.documentGeneration, backend_dom_node_id: node.backendDOMNodeId };
        const size = encoder.encode(JSON.stringify(candidate)).length + 1;
        if (bytes + size > maxBytes) { omittedNodes++; continue; }
        bytes += size;
        evidenceBytes += rawBytes;
        if (truncated) textTruncated++;
        evidence.push(rawEvidence);
        candidates.push(candidate);
    }
    return { candidates, evidence, omittedNodes, textTruncated, totalCandidates, bytes };
}
