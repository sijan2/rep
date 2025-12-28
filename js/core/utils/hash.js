// Hash utilities for stable request IDs (fast and deterministic).
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function fnv1a64(input) {
    let hash = FNV_OFFSET;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * FNV_PRIME) & FNV_MASK;
    }
    return hash.toString(16).padStart(16, '0');
}

export function buildStableRequestId(fields) {
    const requestId = fields.requestId || '';
    const tabId = fields.tabId || '';
    const timestamp = fields.timestamp || '';
    const method = fields.method || '';
    const url = fields.url || '';
    const raw = `${requestId}|${tabId}|${timestamp}|${method}|${url}`;
    return `h_${fnv1a64(raw)}`;
}
