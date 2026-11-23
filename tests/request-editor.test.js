// Tests for the request editor's response preview sandbox and the panel markup it relies on
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { updatePreview, PREVIEW_SANDBOX, PREVIEW_SANDBOX_WITH_SCRIPTS } from '../js/ui/request-editor.js';
import { elements } from '../js/ui/main-ui.js';

const panelHtml = () => readFileSync(resolve(process.cwd(), 'panel.html'), 'utf8');

describe('response preview sandbox', () => {
  let iframe;
  let checkbox;

  beforeEach(() => {
    document.body.innerHTML =
      '<input type="checkbox" id="preview-allow-scripts">' +
      '<iframe id="response-preview-iframe" sandbox="allow-forms"></iframe>';
    iframe = document.getElementById('response-preview-iframe');
    checkbox = document.getElementById('preview-allow-scripts');
    elements.responsePreviewIframe = iframe;
    elements.previewAllowScriptsCheckbox = checkbox;
  });

  const htmlResponse =
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n' +
    '<!doctype html><html><body><img src="https://tracker.example/pixel.png"><form action="https://x.example"></form></body></html>';

  it('renders HTML in an opaque origin: never allow-same-origin, never top navigation', () => {
    updatePreview(htmlResponse);
    expect(iframe.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX);
    expect(iframe.srcdoc).toContain('<img src="https://tracker.example/pixel.png">');

    checkbox.checked = true;
    updatePreview(htmlResponse);
    expect(iframe.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX_WITH_SCRIPTS);
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');

    for (const flags of [PREVIEW_SANDBOX, PREVIEW_SANDBOX_WITH_SCRIPTS]) {
      expect(flags).not.toMatch(/allow-same-origin/);
      expect(flags).not.toMatch(/allow-top-navigation/);
    }
  });

  it('applies the sandbox before the empty and non-HTML previews as well', () => {
    checkbox.checked = true;
    updatePreview('HTTP/1.1 200 OK\n\n{"a":"<script>alert(1)</script>"}');
    expect(iframe.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX_WITH_SCRIPTS);
    expect(iframe.srcdoc).not.toContain('<script>');
    expect(iframe.srcdoc).toContain('white-space: pre-wrap');

    checkbox.checked = false;
    updatePreview('');
    expect(iframe.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX);
    expect(iframe.srcdoc).toContain('No content to preview');
  });

  it('ships panel.html with an opaque-origin preview frame', () => {
    const match = panelHtml().match(/<iframe id="response-preview-iframe"[^>]*\ssandbox="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(PREVIEW_SANDBOX);
  });
});

describe('panel markup after the AI chat removal', () => {
  it('has no AI chat, provider settings, explanation or AI regex surfaces', () => {
    const html = panelHtml();
    for (const id of [
      'llm-chat-pane', 'llm-chat-toggle-btn', 'llm-chat-input', 'settings-btn', 'settings-modal',
      'ai-provider', 'anthropic-api-key', 'gemini-api-key', 'local-api-url', 'explanation-modal',
      'explain-btn', 'suggest-attack-btn', 'ctx-explain-ai', 'response-search-ai-btn', 'ai-export-menu'
    ]) {
      expect(html, `id="${id}" should be gone`).not.toContain(`id="${id}"`);
    }
    expect(html).not.toMatch(/lib\/marked\.min\.js|lib\/highlight\.min\.js|github-dark\.min\.css/);
    // The Jev classification entry stays in the header menu
    expect(html).toContain('id="jev-classify-btn"');
  });

  it('keeps a single pane resize handle between request and response', () => {
    const html = panelHtml();
    expect(html.match(/pane-resize-handle/g)).toHaveLength(1);
    expect(html).not.toContain('chat-resize-handle');
  });
});
