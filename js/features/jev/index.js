import { state } from '../../core/state.js';

const CATEGORIES = ['api', 'document', 'static', 'analytics', 'other'];
const REVIEW_THRESHOLD = 0.8;
const TIMEOUT_MS = 35000;

// Only a small metadata allowlist crosses the native bridge for classification.
export function buildTrafficMetadata(selected) {
    if (!selected?.request?.url) throw new Error('Select a captured request first.');
    let url;
    try {
        url = new URL(selected.request.url);
    } catch (_) {
        throw new Error('The selected request has an invalid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Jev classification supports HTTP and HTTPS requests.');
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const sensitiveSegment = /^(?:token|key|secret|password|session|auth|authorization|api[-_]?key)$/i;
    const segments = url.pathname.split('/');
    url.pathname = segments.map((segment, index) => {
        if (!segment) return '';
        if (sensitiveSegment.test(segments[index - 1] || '') ||
            !/^[a-zA-Z][a-zA-Z._-]{0,31}$/.test(segment)) return ':redacted';
        return segment;
    }).join('/');

    const headers = selected.responseHeaders || selected.response?.headers || [];
    let contentType = selected.response?.content?.mimeType || '';
    if (!contentType && Array.isArray(headers)) {
        contentType = headers.find(header => header.name?.toLowerCase() === 'content-type')?.value || '';
    } else if (!contentType && headers && typeof headers === 'object') {
        const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-type');
        contentType = key ? headers[key] : '';
    }
    if (Array.isArray(contentType)) contentType = contentType[0];
    contentType = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(contentType)) contentType = '';
    const method = String(selected.request.method || '').toUpperCase();
    const resourceType = String(selected.resourceType || selected._resourceType || selected.type || '').toLowerCase();
    const status = Number(selected.responseStatus || selected.response?.status || 0);
    return {
        method: /^[A-Z]{1,16}$/.test(method) ? method : 'UNKNOWN',
        url: url.href,
        resource_type: /^[a-z_]{1,32}$/.test(resourceType) ? resourceType : 'other',
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
        content_type: contentType,
    };
}

function validateResult(result) {
    const probabilities = result?.probabilities;
    const values = CATEGORIES.map(category => probabilities?.[category]);
    if (!result || !CATEGORIES.includes(result.category) ||
        !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
        typeof result.needs_review !== 'boolean' || !probabilities ||
        typeof probabilities !== 'object' || Array.isArray(probabilities) ||
        Object.keys(probabilities).length !== CATEGORIES.length ||
        !CATEGORIES.every(category => Object.hasOwn(probabilities, category)) ||
        values.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
        Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02 ||
        probabilities[result.category] < Math.max(...values) - 1e-6) {
        throw new Error('The native host returned an invalid Jev classification. Update rep-cli and try again.');
    }
    return result;
}

export async function classifySelectedTraffic(selected, { chromeApi = globalThis.chrome, timeoutMs = TIMEOUT_MS } = {}) {
    const params = buildTrafficMetadata(selected);
    const id = `jev-${globalThis.crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
        let port;
        let timer;
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (port) {
                port.onMessage.removeListener(onMessage);
                port.onDisconnect.removeListener(onDisconnect);
                try { port.disconnect(); } catch (_) { /* already disconnected */ }
            }
            if (error) reject(error);
            else resolve(result);
        };
        const onMessage = message => {
            // The bridge also broadcasts status, other requests, and an immediate
            // acknowledgement without an ID. Only the correlated host reply counts.
            if (message?.action !== 'jev_classify' || message.id !== id) return;
            if (message.success !== true) {
                const error = typeof message.error === 'string' ? message.error.slice(0, 512) : 'Jev classification failed.';
                finish(new Error(error));
                return;
            }
            try {
                finish(null, validateResult(message.result));
            } catch (error) {
                finish(error);
            }
        };
        const onDisconnect = () => {
            // Reading lastError also acknowledges Chrome's disconnect diagnostic.
            void chromeApi?.runtime?.lastError;
            finish(new Error('The native bridge disconnected. Reconnect rep-host and try again.'));
        };
        timer = setTimeout(() => finish(new Error('Jev classification timed out. Check rep-host and the Jev configuration, then try again.')), timeoutMs);
        try {
            port = chromeApi.runtime.connect({ name: 'rep-native-export' });
            port.onMessage.addListener(onMessage);
            port.onDisconnect.addListener(onDisconnect);
            port.postMessage({ action: 'jev_classify', id, params });
        } catch (_) {
            finish(new Error('Unable to connect to the native bridge. Install or update rep-cli and rep-host first.'));
        }
    });
}

export function renderClassification(container, result) {
    validateResult(result);
    container.replaceChildren();
    const lines = [
        `Category: ${result.category}`,
        `Confidence: ${(result.confidence * 100).toFixed(1)}%`,
        `Needs review: ${result.needs_review || result.confidence < REVIEW_THRESHOLD ? 'Yes' : 'No'}`,
    ];
    for (const text of lines) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        container.appendChild(paragraph);
    }
    const probabilities = result.probabilities;
    if (probabilities && typeof probabilities === 'object') {
        const list = document.createElement('ul');
        for (const category of CATEGORIES) {
            const probability = probabilities[category];
            if (!Number.isFinite(probability) || probability < 0 || probability > 1) continue;
            const item = document.createElement('li');
            item.textContent = `${category}: ${(probability * 100).toFixed(1)}%`;
            list.appendChild(item);
        }
        if (list.childElementCount) {
            const heading = document.createElement('p');
            heading.textContent = 'Category probabilities';
            container.append(heading, list);
        }
    }
}

export function setupJevClassification() {
    const button = document.getElementById('jev-classify-btn');
    const modal = document.getElementById('jev-classification-modal');
    const content = document.getElementById('jev-classification-content');
    const summary = document.getElementById('jev-classification-request');
    if (!button || !modal || !content || !summary) return;
    button.addEventListener('click', async () => {
        document.getElementById('ai-menu-dropdown')?.classList.remove('show');
        button.disabled = true;
        modal.style.display = 'block';
        summary.textContent = '';
        content.textContent = 'Classifying selected traffic with Jev…';
        try {
            const selected = state.selectedRequest;
            const metadata = buildTrafficMetadata(selected);
            summary.textContent = `${metadata.method} ${metadata.url}`;
            renderClassification(content, await classifySelectedTraffic(selected));
        } catch (error) {
            content.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    });
}
