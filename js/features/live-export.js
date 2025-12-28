// Live Export - Real-time export to CLI via Native Messaging
// Sends requests directly to ~/.local/share/rep-cli/live.json

import { state } from '../core/state/index.js';
import { events, EVENT_NAMES } from '../core/events.js';
import { buildStableRequestId } from '../core/utils/hash.js';

const NATIVE_HOST = 'com.repplus.host';
const DEBOUNCE_MS = 500;

let port = null;
let isEnabled = false;
let isConnected = false;
let debounceTimer = null;
let requestQueue = [];
let reconnectTimer = null;
let reconnectDelay = 1000;
let needsResync = false;
let isContextAlive = true;

/**
 * Initialize live export feature
 */
export function initLiveExport() {
    if (typeof window !== 'undefined') {
        window.addEventListener('unload', () => {
            isContextAlive = false;
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            requestQueue = [];
            disconnectNativeHost();
        });
    }

    // Setup button click handler
    const btn = document.getElementById('live-export-btn');
    if (btn) {
        btn.addEventListener('click', toggleLiveExport);
    }

    // Load saved preference (use localStorage as fallback)
    try {
        if (chrome?.storage?.local) {
            chrome.storage.local.get(['liveExportEnabled'], (result) => {
                if (result?.liveExportEnabled) {
                    enableLiveExport();
                }
                updateUI();
            });
        } else {
            // Fallback to localStorage
            const saved = localStorage.getItem('liveExportEnabled');
            if (saved === 'true') {
                enableLiveExport();
            }
            updateUI();
        }
    } catch (e) {
        console.warn('Live export: Could not load preference', e);
        updateUI();
    }

    // Listen for new requests
    events.on(EVENT_NAMES.REQUEST_RENDERED, ({ request, index }) => {
        if (!isEnabled) return;
        if (isConnected) {
            queueRequest(request, index);
            return;
        }
        needsResync = true;
    });

    // Listen for clear all
    events.on(EVENT_NAMES.STATE_REQUESTS_CLEARED, () => {
        if (!isEnabled) return;
        resetQueue();
        syncAllRequests();
    });

    // Listen for request list changes (delete/group delete)
    events.on(EVENT_NAMES.STATE_REQUESTS_UPDATED, () => {
        if (!isEnabled) return;
        resetQueue();
        syncAllRequests();
    });
}

/**
 * Save preference helper
 */
function savePreference(enabled) {
    if (!isContextValid()) {
        return;
    }
    try {
        if (chrome?.storage?.local) {
            chrome.storage.local.set({ liveExportEnabled: enabled });
        } else {
            localStorage.setItem('liveExportEnabled', enabled ? 'true' : 'false');
        }
    } catch (e) {
        if (!handleInvalidContextError(e)) {
            console.warn('Live export: Could not save preference', e);
        }
    }
}

/**
 * Enable live export and connect to native host
 */
function enableLiveExport() {
    isEnabled = true;
    savePreference(true);
    connectNativeHost();
}

/**
 * Disable live export
 */
function disableLiveExport() {
    isEnabled = false;
    savePreference(false);
    disconnectNativeHost();
}

/**
 * Toggle live export
 */
export function toggleLiveExport() {
    if (isEnabled) {
        disableLiveExport();
    } else {
        enableLiveExport();
    }
    updateUI();
}

/**
 * Connect to native messaging host
 */
function connectNativeHost() {
    if (port) return;
    if (!isContextValid()) return;

    try {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        port = chrome.runtime.connectNative(NATIVE_HOST);

        port.onMessage.addListener((response) => {
            console.log('Native host response:', response);
            if (response.success) {
                isConnected = true;
                resetReconnect();
                updateUI();
                if (needsResync) {
                    needsResync = false;
                    syncAllRequests();
                }
            }
        });

        port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError;
            console.log('Native host disconnected:', error?.message || 'unknown');
            port = null;
            isConnected = false;
            updateUI();

            // Show error if it was enabled
            if (isEnabled && error) {
                showConnectionError(error.message);
            }
            scheduleReconnect();
        });

        // Test connection
        sendMessage({ action: 'ping' });

        // Always sync on connect - replaces old data with current state
        // (even if empty, this clears stale requests from previous sessions)
        syncAllRequests();

    } catch (e) {
        console.error('Failed to connect to native host:', e);
        showConnectionError(e.message);
        if (!handleInvalidContextError(e)) {
            scheduleReconnect();
        }
    }
}

/**
 * Disconnect from native host
 */
function disconnectNativeHost() {
    if (port) {
        port.disconnect();
        port = null;
    }
    isConnected = false;
}

/**
 * Send message to native host
 */
function sendMessage(msg) {
    if (!isContextValid()) {
        return false;
    }
    if (!port) {
        scheduleReconnect();
        return false;
    }

    try {
        port.postMessage(msg);
        return true;
    } catch (e) {
        console.error('Failed to send message:', e);
        if (handleInvalidContextError(e)) {
            return false;
        }
        port = null;
        isConnected = false;
        updateUI();
        scheduleReconnect();
        return false;
    }
}

function resetQueue() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    requestQueue = [];
}

/**
 * Queue a request for sending (debounced)
 */
function queueRequest(request, index) {
    const formatted = formatRequest(request, index);
    requestQueue.push(formatted);

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
        flushQueue();
    }, DEBOUNCE_MS);
}

/**
 * Flush queued requests
 */
function flushQueue() {
    if (requestQueue.length === 0) return;

    // Send as batch
    const pending = requestQueue;
    requestQueue = [];
    for (let i = 0; i < pending.length; i++) {
        if (!sendMessage({ action: 'add', request: pending[i] })) {
            requestQueue = [];
            needsResync = true;
            break;
        }
    }
}

/**
 * Sync all current requests
 */
function syncAllRequests() {
    resetQueue();
    const requests = state.requests.map((req, index) => formatRequest(req, index));
    if (!sendMessage({ action: 'sync', requests })) {
        needsResync = true;
    }
}

/**
 * Format request for CLI consumption
 */
function formatRequest(req, index) {
    const headersObj = {};
    if (req.request?.headers) {
        req.request.headers.forEach(h => {
            if (!headersObj[h.name]) {
                headersObj[h.name] = [];
            }
            headersObj[h.name].push(h.value);
        });
    }

    const resHeadersObj = {};
    if (req.response?.headers) {
        req.response.headers.forEach(h => {
            if (!resHeadersObj[h.name]) {
                resHeadersObj[h.name] = [];
            }
            resHeadersObj[h.name].push(h.value);
        });
    }

    const timestamp = req.capturedAt || Date.now();
    const method = req.request?.method || 'GET';
    const url = req.request?.url || '';
    const requestId = req.requestId || req._requestId || req.request?.requestId || '';
    const tabId = req.tabId || req._tabId || '';
    const stableId = buildStableRequestId({ requestId, tabId, timestamp, method, url });

    return {
        id: stableId,
        original_id: `req_${index + 1}`,
        method: method,
        url: url,
        page_url: req.pageUrl || url,
        resource_type: req.resourceType || req.type || '',
        initiator: req.initiator || '',
        headers: headersObj,
        body: req.request?.postData?.text || '',
        response: {
            status: req.response?.status || 0,
            headers: resHeadersObj,
            body: req.responseBody || req.response?.content?.text || ''
        },
        response_encoding: req.responseEncoding || '',
        timestamp: timestamp
    };
}

/**
 * Show connection error
 */
function showConnectionError(message) {
    console.error('Live Export Error:', message);
    // Could show a toast notification here
}

function scheduleReconnect() {
    if (!isContextValid()) return;
    if (!isEnabled) return;
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectNativeHost();
    }, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function resetReconnect() {
    reconnectDelay = 1000;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function isContextValid() {
    if (!isContextAlive) return false;
    try {
        return Boolean(chrome?.runtime?.id);
    } catch (e) {
        return false;
    }
}

function handleInvalidContextError(error) {
    const message = (error && error.message) ? error.message : '';
    if (message.includes('Extension context invalidated')) {
        disableLiveExport();
        return true;
    }
    return false;
}

/**
 * Check if live export is enabled
 */
export function isLiveExportEnabled() {
    return isEnabled;
}

/**
 * Check if connected to native host
 */
export function isLiveExportConnected() {
    return isConnected;
}

/**
 * Update UI to reflect current state
 */
function updateUI() {
    const btn = document.getElementById('live-export-btn');
    if (btn) {
        if (!isEnabled) {
            btn.title = 'Live Export to CLI: OFF';
            btn.style.color = '';
            btn.style.background = '';
        } else if (isConnected) {
            btn.title = 'Live Export to CLI: ON - Connected';
            btn.style.color = '#81c995'; // Green
            btn.style.background = 'rgba(129, 201, 149, 0.15)';
        } else {
            btn.title = 'Live Export to CLI: ERROR - Native host not found';
            btn.style.color = '#f28b82'; // Red
            btn.style.background = 'rgba(242, 139, 130, 0.15)';
        }
    }
}
