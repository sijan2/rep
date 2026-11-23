// Request Handler Module - High-level orchestrator for sending requests
import { state, addToHistory } from '../core/state.js';
import { elements } from '../ui/main-ui.js';
import { events, EVENT_NAMES } from '../core/events.js';
import { parseRequest, findBrowserControlledHeaderEdits } from './capture.js';
import { sendRequest } from './request-sender.js';
import { formatRawResponse, getStatusClass } from './response-parser.js';
import { formatBytes } from '../core/utils/format.js';
import { escapeHtml } from '../core/utils/dom.js';
import { renderDiff } from '../core/utils/misc.js';
import { highlightHTTP } from '../core/utils/network.js';
import { generateHexView } from '../ui/hex-view.js'
import { generateJsonView } from '../ui/json-view.js'
import { saveEditorState } from '../ui/request-editor.js';

export async function handleSendRequest() {
    const rawContent = elements.rawRequestInput.innerText;
    const useHttps = elements.useHttpsCheckbox.checked;

    // Save editor state before sending (preserve modifications)
    if (state.selectedRequest) {
        const requestIndex = state.requests.indexOf(state.selectedRequest);
        if (requestIndex !== -1) {
            saveEditorState(requestIndex);
        }
    }

    // Add to history
    addToHistory(rawContent, useHttps);
    events.emit(EVENT_NAMES.UI_UPDATE_HISTORY_BUTTONS);

    try {
        const { url, options, browserControlledHeaders } = parseRequest(rawContent, useHttps);

        // fetch() cannot send an edited Cookie, Origin or Referer; it silently substitutes the
        // browser's own values. Refuse instead of showing a result the edited request did not produce.
        const capturedHeaders = state.selectedRequest?.request?.headers || [];
        const blockedEdits = findBrowserControlledHeaderEdits(browserControlledHeaders, capturedHeaders);
        if (blockedEdits.length > 0) {
            showRefusedSend(blockedEdits);
            return;
        }

        elements.resStatus.textContent = 'Sending...';
        elements.resStatus.className = 'status-badge';

        console.log('Sending request to:', url);

        const result = await sendRequest(url, options);

        elements.resTime.textContent = `${result.duration}ms`;
        elements.resSize.textContent = formatBytes(result.size);

        elements.resStatus.textContent = `${result.status} ${result.statusText}`;
        elements.resStatus.className = getStatusClass(result.status);

        // Format raw HTTP response
        const rawResponse = formatRawResponse(result);

        // Store current response
        state.currentResponse = rawResponse;
        
        // Save editor state (including response) after receiving response
        if (state.selectedRequest) {
            const requestIndex = state.requests.indexOf(state.selectedRequest);
            if (requestIndex !== -1) {
                saveEditorState(requestIndex);
            }
        }

        // Handle Diff Baseline
        if (!state.regularRequestBaseline) {
            state.regularRequestBaseline = rawResponse;
            elements.diffToggle.style.display = 'none';
        } else {
            elements.diffToggle.style.display = 'flex';
            if (elements.showDiffCheckbox && elements.showDiffCheckbox.checked) {
                elements.rawResponseDisplay.innerHTML = renderDiff(state.regularRequestBaseline, rawResponse);
            } else {
                elements.rawResponseDisplay.innerHTML = highlightHTTP(rawResponse);
            }
        }

        // If diff not enabled or first response
        if (!elements.showDiffCheckbox || !elements.showDiffCheckbox.checked || !state.regularRequestBaseline || state.regularRequestBaseline === rawResponse) {
            elements.rawResponseDisplay.innerHTML = highlightHTTP(rawResponse);
        }

        elements.rawResponseDisplay.style.display = 'block';
        elements.rawResponseDisplay.style.visibility = 'visible';

        // Update other tabs as well
        elements.rawResponseText.textContent = rawResponse;
        elements.hexResponseDisplay.textContent = generateHexView(rawResponse);
        elements.jsonResponseDisplay.innerHTML = '';
        elements.jsonResponseDisplay.appendChild(generateJsonView(rawResponse));

    } catch (err) {
        console.error('Request Failed:', err);

        // Check for missing permissions if it's a fetch error
        if (err.message === 'Failed to fetch' || err.message.includes('NetworkError')) {
            chrome.permissions.contains({
                permissions: ['webRequest'],
                origins: ['<all_urls>']
            }, (hasPermissions) => {
                if (!hasPermissions) {
                    elements.resStatus.textContent = 'Permission Required';
                    elements.resStatus.className = 'status-badge status-4xx';
                    elements.resTime.textContent = '0ms';

                    elements.rawResponseDisplay.innerHTML = `
                        <div style="padding: 20px; text-align: center;">
                            <h3 style="margin-top: 0;">Permission Required</h3>
                            <p>To replay requests to any domain, Rep+ needs the <code>&lt;all_urls&gt;</code> permission.</p>
                            <p>This permission is optional and only requested when you use this feature.</p>
                            <button id="grant-perm-btn" class="primary-btn" style="margin-top: 10px;">Grant Permission & Retry</button>
                        </div>
                    `;
                    elements.rawResponseDisplay.style.display = 'block';

                    document.getElementById('grant-perm-btn').addEventListener('click', () => {
                        chrome.permissions.request({
                            permissions: ['webRequest'],
                            origins: ['<all_urls>']
                        }, (granted) => {
                            if (granted) {
                                handleSendRequest();
                            } else {
                                elements.rawResponseDisplay.innerHTML += '<p style="color: var(--error-color); margin-top: 10px;">Permission denied.</p>';
                            }
                        });
                    });
                    return;
                }

                // If permissions exist but still failed
                showError(err);
            });
        } else {
            showError(err);
        }
    }
}

const BROWSER_CONTROLLED_HEADER_NOTES = {
    cookie: 'fetch() cannot set Cookie: the browser attaches its own cookie jar for this site, so the edited value is never sent, and deleting the line does not remove the cookies.',
    cookie2: 'fetch() cannot set Cookie2: the browser attaches its own cookie jar for this site, so the edited value is never sent.',
    origin: 'fetch() cannot set Origin: the panel sends Origin: chrome-extension://<id> on non-GET requests, whatever the editor says.',
    referer: 'fetch() cannot set Referer: the panel sends no Referer at all, whatever the editor says.'
};

function previewValue(value) {
    const text = String(value ?? '');
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Shows why Send was refused: edited browser-controlled headers would be dropped silently.
 * @param {Array<{name: string, change: string, editorValue: string, capturedValue: string}>} edits
 */
export function showRefusedSend(edits) {
    elements.resStatus.textContent = 'Not sent';
    elements.resStatus.className = 'status-badge status-4xx';
    elements.resTime.textContent = '';
    if (elements.resSize) elements.resSize.textContent = '';

    const items = edits.map((edit) => {
        const note = BROWSER_CONTROLLED_HEADER_NOTES[edit.name.toLowerCase()] || '';
        const captured = edit.change === 'added'
            ? 'not present in the captured request'
            : `captured as <code>${escapeHtml(previewValue(edit.capturedValue))}</code>`;
        return `<li><strong>${escapeHtml(edit.name)}</strong> ${edit.change} (${captured}). ${escapeHtml(note)}</li>`;
    }).join('');

    elements.rawResponseDisplay.innerHTML = `
        <div class="send-refused" style="padding: 20px;">
            <h3 style="margin-top: 0;">Not sent: this edit would be dropped silently</h3>
            <p>The panel replays with the browser's <code>fetch()</code>, which owns these headers and ignores edited values. Sending now would show a response the edited request did not produce.</p>
            <ul>${items}</ul>
            <p>Undo the change to send from the panel. The panel cannot replay with a different cookie, Origin or Referer.</p>
        </div>
    `;
    elements.rawResponseDisplay.style.display = 'block';
    elements.rawResponseDisplay.style.visibility = 'visible';
}

function showError(err) {
    elements.resStatus.textContent = 'Error';
    elements.resStatus.className = 'status-badge status-5xx';
    elements.resTime.textContent = '0ms';
    elements.rawResponseDisplay.textContent = `Error: ${err.message}\n\nStack: ${err.stack}`;
    elements.rawResponseDisplay.style.display = 'block';
}
