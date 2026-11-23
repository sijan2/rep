// Network Operations

export function setupNetworkListener(onRequestCaptured, chromeApi = globalThis.chrome) {
    // DevTools APIs are only injected into a DevTools page and its panels.
    // Opening panel.html as an extension tab must not abort the rest of the UI.
    const devtools = chromeApi?.devtools;
    const network = devtools?.network;
    if (!network?.onNavigated?.addListener || !network?.onRequestFinished?.addListener) {
        console.warn('rep+: Current-tab capture requires the rep+ panel inside browser DevTools.');
        return false;
    }

    // Get the current page URL once at setup
    let currentPageUrl = '';
    let inspectedTabId = null;
    if (devtools.inspectedWindow) {
        inspectedTabId = devtools.inspectedWindow.tabId ?? null;
        devtools.inspectedWindow.eval('window.location.href', (result, isException) => {
            if (!isException && result) {
                currentPageUrl = result;
            }
        });
    }

    // Update page URL when navigation occurs
    network.onNavigated.addListener((url) => {
        currentPageUrl = url;
    });

    network.onRequestFinished.addListener((request) => {
        // Filter out data URLs or extension schemes
        if (!request.request.url.startsWith('http')) return;

        // Filter out requests sent by rep+ extension (replayed requests)
        // Check if request has our custom header
        if (request.request.headers) {
            const hasRepPlusHeader = request.request.headers.some(h => 
                (h.name === 'X-Rep-Plus-Replay' || h.name.toLowerCase() === 'x-rep-plus-replay') && 
                h.value === 'true'
            );
            if (hasRepPlusHeader) {
                return; // Skip requests sent by our extension
            }
        }

        // Filter out Chrome extension requests
        // Extension IDs are 32-character alphanumeric strings
        const extensionIdPattern = /^[a-z]{32}$/i;
        try {
            const urlObj = new URL(request.request.url);
            const hostname = urlObj.hostname.toLowerCase();
            
            // Check if hostname is an extension ID (32 alphanumeric chars)
            // or contains chrome-extension:// scheme
            if (extensionIdPattern.test(hostname) || 
                request.request.url.startsWith('chrome-extension://') ||
                request.request.url.startsWith('chrome://') ||
                request.request.url.startsWith('moz-extension://')) {
                return;
            }
        } catch (e) {
            // If URL parsing fails, continue with other checks
        }

        // Filter out static resources (JS, CSS, images, fonts, etc.)
        const url = request.request.url.toLowerCase();
        const staticExtensions = [
            '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
            '.woff', '.woff2', '.ttf', '.eot', '.otf',
            '.mp4', '.webm', '.mp3', '.wav',
            '.pdf'
        ];

        // Check if URL ends with any static extension
        const isStatic = staticExtensions.some(ext => {
            return url.endsWith(ext) || url.includes(ext + '?');
        });

        if (isStatic) {
            // console.log('Skipping static resource:', request.request.url);
            return;
        }

        // Store the capture time for relative time display
        request.capturedAt = Date.now();

        // Store the page URL that this request belongs to
        const pageUrl = currentPageUrl || request.request.url;

        // Skip if pageUrl is from an extension (chrome-extension:// or extension ID hostname)
        try {
            const pageUrlObj = new URL(pageUrl);
            const pageHostname = pageUrlObj.hostname.toLowerCase();
            if (extensionIdPattern.test(pageHostname) ||
                pageUrl.startsWith('chrome-extension://') ||
                pageUrl.startsWith('chrome://') ||
                pageUrl.startsWith('moz-extension://')) {
                return;
            }
        } catch (e) {
            // If URL parsing fails, continue
        }

        request.pageUrl = pageUrl;
        request.tabId = inspectedTabId;
        request.requestId = request.requestId || request._requestId || '';
        request.resourceType = request._resourceType || request.resourceType || request.type || '';

        // Fetch response content so we can show it without switching tabs
        request.getContent((body, encoding) => {
            const responseStatus = request.response?.status || request.response?.statusCode || '';
            const responseStatusText = request.response?.statusText || '';
            const responseHeaders = request.response?.headers || [];

            const enhancedRequest = {
                ...request,
                responseBody: body || '',
                responseEncoding: encoding || '',
                responseStatus,
                responseStatusText,
                responseHeaders
            };

            onRequestCaptured(enhancedRequest);
        });
    });
    return true;
}

// Request headers the browser owns. fetch() drops them silently (they are "forbidden request
// headers" in the Fetch standard), so what the editor shows is not what goes on the wire:
//  - Cookie: the browser attaches its own cookie jar (credentials: 'include'), never the edited
//    value, and deleting the line does not stop the jar from being sent;
//  - Origin and Referer: the panel's fetch sends Origin: chrome-extension://<id> on non-GET
//    requests and no Referer at all, whatever the editor says.
export const BROWSER_CONTROLLED_HEADERS = ['cookie', 'cookie2', 'origin', 'referer'];

/**
 * Builds the editor text for a captured request (the inverse of parseRequest).
 * The body is copied byte for byte: no JSON re-serialisation, which would round integers
 * above 2^53, merge duplicate keys and turn CRLF into LF. An unchanged resend therefore
 * carries exactly the captured body.
 * @param {Object} request - Captured request ({ request: { url, method, httpVersion, headers, postData } })
 * @returns {string} Raw HTTP request text
 */
export function buildRawRequest(request) {
    const urlObj = new URL(request.request.url);
    const path = urlObj.pathname + urlObj.search;
    const method = request.request.method;
    const httpVersion = request.request.httpVersion || 'HTTP/1.1';
    const headers = request.request.headers || [];

    const lines = [`${method} ${path} ${httpVersion}`];
    if (!headers.some(h => h.name.toLowerCase() === 'host')) {
        lines.push(`Host: ${urlObj.host}`);
    }
    for (const header of headers) {
        if (header.name.startsWith(':')) continue; // HTTP/2 pseudo-headers
        lines.push(`${header.name}: ${header.value}`);
    }

    let rawText = lines.join('\n');
    const bodyText = request.request.postData?.text;
    if (bodyText) {
        rawText += '\n\n' + bodyText;
    }
    return rawText;
}

/**
 * Compares the browser-controlled headers (see BROWSER_CONTROLLED_HEADERS) typed in the editor
 * with the ones the browser captured. fetch() would drop every one of these edits silently and
 * send the browser's own values instead, so Send has to refuse rather than show a misleading
 * result. Added, changed and removed headers all count: removing Cookie does not remove the
 * cookie jar, and removing Origin or Referer does not change what the panel sends either.
 * @param {Array<{name: string, value: string}>} editorHeaders - Headers present in the editor
 * @param {Array<{name: string, value: string}>} capturedHeaders - Headers of the captured request
 * @returns {Array<{name: string, change: 'added'|'changed'|'removed', editorValue: string, capturedValue: string}>}
 */
export function findBrowserControlledHeaderEdits(editorHeaders, capturedHeaders) {
    const collect = (headers) => {
        const byName = new Map();
        for (const header of headers || []) {
            const name = String(header?.name ?? '');
            const lower = name.toLowerCase();
            if (!BROWSER_CONTROLLED_HEADERS.includes(lower)) continue;
            const entry = byName.get(lower) || { name, values: [] };
            entry.values.push(String(header.value ?? '').trim());
            byName.set(lower, entry);
        }
        return byName;
    };
    const editor = collect(editorHeaders);
    const captured = collect(capturedHeaders);

    const edits = [];
    for (const lower of BROWSER_CONTROLLED_HEADERS) {
        const inEditor = editor.get(lower);
        const inCapture = captured.get(lower);
        if (!inEditor && !inCapture) continue;
        const editorValue = inEditor ? inEditor.values.join('\n') : '';
        const capturedValue = inCapture ? inCapture.values.join('\n') : '';
        let change;
        if (inEditor && !inCapture) change = 'added';
        else if (!inEditor && inCapture) change = 'removed';
        else if (editorValue !== capturedValue) change = 'changed';
        else continue;
        edits.push({ name: (inEditor || inCapture).name, change, editorValue, capturedValue });
    }
    return edits;
}

export function parseRequest(rawContent, useHttps) {
    const lines = rawContent.split('\n');
    if (lines.length === 0) {
        throw new Error('No content to send');
    }

    // Parse Request Line
    const requestLine = lines[0].trim();
    const reqLineParts = requestLine.split(' ');
    if (reqLineParts.length < 2) {
        throw new Error('Invalid Request Line. Format: METHOD PATH HTTP/1.1');
    }

    const method = reqLineParts[0].toUpperCase();
    const path = reqLineParts[1];

    // Split Headers and Body
    let headers = {};
    let bodyText = null;
    let isBody = false;
    let host = '';
    const browserControlledHeaders = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        if (!isBody) {
            if (line.trim() === '') {
                isBody = true;
                continue;
            }

            // Skip HTTP/2 pseudo-headers (start with :)
            if (line.trim().startsWith(':')) {
                continue;
            }

            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();

                if (key && value) {
                    if (BROWSER_CONTROLLED_HEADERS.includes(key.toLowerCase())) {
                        browserControlledHeaders.push({ name: key, value });
                    }
                    if (key.toLowerCase() === 'host') {
                        host = value;
                    } else {
                        headers[key] = value;
                    }
                }
            }
        } else {
            // Body content
            if (bodyText === null) bodyText = line;
            else bodyText += '\n' + line;
        }
    }

    if (!host) {
        throw new Error('Host header is missing!');
    }

    const scheme = useHttps ? 'https' : 'http';
    const url = `${scheme}://${host}${path}`;

    // Filter out forbidden headers (fetch() would drop them silently anyway).
    // Edits to the browser-controlled ones are reported separately so Send can refuse.
    const forbiddenHeaders = [
        'accept-charset', 'accept-encoding', 'access-control-request-headers',
        'access-control-request-method', 'connection', 'content-length',
        'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
        'origin', 'referer', 'set-cookie', 'set-cookie2', 'te', 'trailer',
        'transfer-encoding', 'upgrade', 'via'
    ];

    const filteredHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase();
        const isForbidden = forbiddenHeaders.includes(lowerKey) ||
            lowerKey.startsWith('sec-') ||
            lowerKey.startsWith('proxy-');

        if (!isForbidden) {
            if (/^[a-zA-Z0-9\-_]+$/.test(key)) {
                filteredHeaders[key] = value;
            }
        }
    }

    // Add cache-busting headers to prevent 304 Not Modified responses
    // This ensures we always get fresh responses when replaying requests
    filteredHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    filteredHeaders['Pragma'] = 'no-cache';
    filteredHeaders['Expires'] = '0';
    
    // Remove conditional headers that might cause 304 responses
    delete filteredHeaders['If-None-Match'];
    delete filteredHeaders['If-Modified-Since'];
    
    const options = {
        method: method,
        headers: filteredHeaders,
        mode: 'cors',
        credentials: 'include',
        cache: 'no-store' // Fetch API cache control
    };

    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && bodyText) {
        options.body = bodyText;
    }

    return { url, options, method, filteredHeaders, bodyText, browserControlledHeaders };
}

export async function executeRequest(url, options) {
    // Add a custom header to identify requests sent by rep+ extension
    // This allows us to filter them out from being captured
    if (!options.headers) {
        options.headers = {};
    }
    options.headers['X-Rep-Plus-Replay'] = 'true';
    
    const startTime = performance.now();
    const response = await fetch(url, options);
    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(0);

    const responseBody = await response.text();
    const size = new TextEncoder().encode(responseBody).length;

    return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: responseBody,
        size: size,
        duration: duration
    };
}
