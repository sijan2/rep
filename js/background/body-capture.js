// CDP streaming delivers decoded response bytes. HTTP transfer chunks are not
// application records; keep their bytes ordered before interpreting any text.
export class CaptureBodyBudget {
    constructor(limit) { this.limit = limit; this.bytes = 0; this.exhausted = false; }
    take(wanted) {
        const taken = Math.min(wanted, Math.max(0, this.limit - this.bytes));
        this.bytes += taken;
        if (taken < wanted) this.exhausted = true;
        return taken;
    }
    release(bytes) { this.bytes = Math.max(0, this.bytes - bytes); }
}

export class ResponseBodyCollector {
    constructor(limit, budget = null) {
        this.limit = Math.max(0, Number(limit) || 0);
        this.budget = budget;
        this.budgetTruncated = false;
        this.parts = [];
        this.bytes = 0;
        this.observed = 0;
        this.chunks = 0;
    }

    appendBase64(value) {
        const encoded = String(value || '').replace(/\s/g, '');
        const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
        const firstPadding = encoded.indexOf('=');
        if (/[^A-Za-z0-9+/=]/.test(encoded) || encoded.length % 4 === 1 || (padding && encoded.length % 4 !== 0) || (firstPadding !== -1 && firstPadding !== encoded.length - padding)) throw new Error('invalid base64 payload');
        const observed = Math.floor(encoded.length * 3 / 4) - padding;
        const take = this.reserve(observed);
        // Decode only the retained prefix. CDP already handed us the encoded
        // string; allocating its entire decoded body would defeat the budget.
        const binary = atob(encoded.slice(0, Math.ceil(take / 3) * 4));
        this.appendRetained(binary, take);
    }

    appendBytes(bytes) {
        const take = this.reserve(bytes.length);
        this.appendRetained(bytes, take);
    }

    reserve(observed) {
        this.observed += observed;
        this.chunks += 1;
        const wanted = Math.min(observed, Math.max(0, this.limit - this.bytes));
        const take = this.budget ? this.budget.take(wanted) : wanted;
        if (take < wanted) this.budgetTruncated = true;
        return take;
    }

    appendRetained(source, take) {
        let offset = 0;
        while (offset < take) {
            let part = this.parts.at(-1);
            let capacity = part ? part.buffer.byteLength - part.byteOffset : 0;
            if (!part || part.length === capacity) {
                // Geometrically grow small pages, then cap at 16 KiB. A million
                // one-byte data events must not allocate a million objects.
                capacity = Math.min(this.limit - this.bytes - offset, 16384, Math.max(256, capacity * 2, take - offset));
                part = new Uint8Array(capacity).subarray(0, 0);
                this.parts.push(part);
            }
            const count = Math.min(take - offset, capacity - part.length);
            const page = new Uint8Array(part.buffer, part.byteOffset, capacity);
            if (typeof source === 'string') {
                for (let index = 0; index < count; index += 1) page[part.length + index] = source.charCodeAt(offset + index);
            } else page.set(source.subarray(offset, offset + count), part.length);
            this.parts[this.parts.length - 1] = page.subarray(0, part.length + count);
            offset += count;
        }
        this.bytes += take;
    }

    prependBase64(value) {
        // Buffered bytes precede events received while stream setup was pending.
        // Reallocate this collector's reservation so a shared budget still
        // retains a prefix, rather than a tail with the beginning missing.
        if (this.budget) this.budget.release(this.bytes);
        const preceding = new ResponseBodyCollector(this.limit, this.budget);
        preceding.appendBase64(value);
        const observed = preceding.observed + this.observed;
        const chunks = preceding.chunks + this.chunks;
        for (const part of this.parts) {
            const wanted = Math.min(part.length, Math.max(0, this.limit - preceding.bytes));
            const take = this.budget ? this.budget.take(wanted) : wanted;
            if (take < wanted) preceding.budgetTruncated = true;
            if (take) {
                preceding.parts.push(part.subarray(0, take));
                preceding.bytes += take;
            }
        }
        this.parts = preceding.parts;
        this.bytes = preceding.bytes;
        this.observed = observed;
        this.chunks = chunks;
        this.budgetTruncated ||= preceding.budgetTruncated;
    }

    materialize(contentType) {
        const bytes = new Uint8Array(this.bytes);
        let offset = 0;
        for (const part of this.parts) { bytes.set(part, offset); offset += part.length; }
        const truncated = this.observed > this.bytes;
        const type = String(contentType || '').toLowerCase();
        const textual = /^(text\/)|json|javascript|xml|x-www-form-urlencoded|graphql/.test(type);
        if (textual) {
            const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1] || 'utf-8';
            try {
                const decoder = new TextDecoder(charset, { fatal: true, ignoreBOM: true });
                if (decoder.encoding !== 'utf-8') throw new Error('retain non-UTF8 response bytes');
                // A partial trailing codepoint must remain bytes, never U+FFFD.
                // Keeping base64 also preserves the exact captured byte prefix.
                const body = decoder.decode(bytes);
                return { body, encoding: '', captured: this.bytes, truncated, charset: decoder.encoding };
            } catch (_) { /* binary/invalid/incomplete text stays lossless base64 */ }
        }
        return { body: bytesToBase64(bytes), encoding: 'base64', captured: this.bytes, truncated, charset: 'base64' };
    }
}

export function bytesToBase64(bytes) {
    const pieces = [];
    for (let index = 0; index < bytes.length; index += 16384) {
        pieces.push(String.fromCharCode(...bytes.subarray(index, index + 16384)));
    }
    return btoa(pieces.join(''));
}

export async function* nativeRequestMessages(requests, sessionID, { batchBytes = 720 * 1024, chunkBytes = 192 * 1024 } = {}) {
    let batch = [];
    let size = 0;
    for (const request of requests) {
        const bytes = new TextEncoder().encode(JSON.stringify(request));
        if (batch.length && size + bytes.length + 1 > batchBytes) {
            yield { action: 'add_many', session_id: sessionID, requests: batch };
            batch = []; size = 0;
        }
        if (bytes.length + 128 <= batchBytes) {
            batch.push(request); size += bytes.length + 1;
            continue;
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
        const transferID = `${request.id}:${sha256.slice(0, 16)}`;
        let sequence = 0;
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            yield {
                action: 'request_chunk', session_id: sessionID, transfer_id: transferID,
                sequence, total_bytes: bytes.length, sha256,
                data: bytesToBase64(bytes.subarray(offset, offset + chunkBytes)),
            };
            sequence += 1;
        }
        yield { action: 'request_end', session_id: sessionID, transfer_id: transferID, chunks: sequence, total_bytes: bytes.length, sha256 };
    }
    if (batch.length) yield { action: 'add_many', session_id: sessionID, requests: batch };
}
