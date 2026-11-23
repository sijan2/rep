# Privacy Policy for rep+

**Last Updated**: 2026-11-04

This document describes what the rep+ extension and the local `rep-host` process it talks to
actually do with your data, as implemented in this version of the code. Where an earlier
version behaved differently, the difference is called out.

## Summary

- rep+ has no servers. Nothing is sent to the authors. There is no analytics or telemetry.
- Captured traffic stays in the DevTools panel's memory unless you export it or turn on
  **Live Export**, which hands it to the local `rep-host` process on your machine.
- `rep-host` and the `rep` CLI write captures to disk, **unredacted** and **without automatic
  expiry**. Read the "On-disk captures" section before capturing authenticated traffic.
- The only network egress to a third party is the opt-in Jev traffic classification, which
  sends a minimized request summary (never headers, bodies or query values) to TypeSafe
  through `rep-host`.
- The AI chat, "Explain request", "Suggest attack vectors", attack-surface analysis and the
  AI regex helper were removed. The extension no longer talks to Anthropic, Google or a local
  model endpoint, and it no longer stores any model-provider API key.

## What the panel captures

- **Current-tab capture** uses `chrome.devtools.network` for the tab you are inspecting. Each
  request is kept as the page sent it: method, URL, every request header (including `Cookie`
  and `Authorization`), the request body, and the response status, headers and body.
  Static resources (images, fonts, stylesheets, media, PDFs) are skipped.
- **Multi-tab / ambient capture** is optional. Enabling it requests the `webRequest`
  permission and `<all_urls>` host access, after which the background service worker observes
  requests from all tabs (headers and bodies via `webRequest`) and forwards them to the panel
  and, if Live Export is on, to `rep-host`. The on/off state is kept in `chrome.storage.local`
  (`repAmbientWatching`, `repAmbientSessionId`). You can revoke the permission at any time in
  Chrome's extension settings.
- Captured requests live in the panel's memory and disappear when DevTools closes. Editor
  edits and replay responses are kept per request for the lifetime of the panel.

## Replaying requests (Send and Bulk Replay)

- Send runs `fetch()` from the panel's `chrome-extension://` origin with
  `credentials: 'include'`. The browser attaches **its own cookie jar** for the target site; the
  panel cannot send a `Cookie`, `Origin` or `Referer` value you typed. If you edit, add or
  remove one of those headers, Send refuses and explains why instead of silently sending
  something else.
- Request bodies are replayed byte for byte as captured (no JSON re-formatting).
- Every Send adds an `X-Rep-Plus-Replay: true` header and `Cache-Control: no-cache, no-store,
  must-revalidate`, `Pragma: no-cache` and `Expires: 0` headers. The target server sees these.
- Replaying to origins other than the inspected page needs the optional `<all_urls>` host
  permission; the panel asks for it the first time a cross-origin send fails.
- Bulk Replay sends the generated variants the same way, from the same extension origin.
- The response **Preview** renders the response body in an iframe sandboxed to an opaque
  origin (never `allow-same-origin`). Scripts run only if you tick "Allow Scripts" and are still
  confined to that opaque origin.

## Export, import and screenshots

- Export writes a JSON file you choose, containing the full captured requests and responses,
  including header values. Import reads such a file back into the panel.
- Screenshots are rendered locally (html2canvas) and saved by you. The redaction tool only
  edits the image you save.

## Live Export and browser control (the `rep` CLI)

rep+ is also the browser half of the `rep` CLI. These parts use the `nativeMessaging`,
`debugger`, `tabs`, `storage` and `alarms` permissions:

- **Live Export** (the "CLI" button; state in `chrome.storage.local` `liveExportEnabled`) sends
  every captured request to the local `rep-host` native-messaging process: method, URL, page
  URL, resource type, all request headers (including `Cookie` and `Authorization` values), the
  request body, and the response status, headers and body. **Nothing is redacted in the
  extension.**
- **Browser control.** `rep-host` connects to the extension over native messaging. On the
  CLI's request the service worker attaches `chrome.debugger` to tabs (Chrome shows its
  "is debugging this browser" bar), creates, navigates, inspects, screenshots or closes tabs,
  and captures their traffic. Captured requests, responses and screenshots go to `rep-host`.
- `alarms` is declared in the manifest for the service worker's scheduled work; this version
  does not set any alarm.

## On-disk captures and retention (`rep-host` / `rep-cli`)

Everything above that reaches `rep-host` is written to the local rep-cli data directory,
`$XDG_DATA_HOME/rep-cli` or `~/.local/share/rep-cli`:

- `live.json` (the global view, capped at 10,000 requests) and, for scoped work,
  `workspaces/<workspace>/tasks/<task>/live.json`, `sessions.jsonl` (one line per capture
  session, appended) and `store.json`.
- Capture snapshots under `bridges/captures-<pid>-<nonce>/<hash>.json` (or `$REP_BRIDGE_DIR`),
  kept for one hour, at most 32 at a time, and removed when the host exits or next starts.
- Files are created with mode `0600` inside `0700` directories.

What these files contain and how long they live:

- Header values are stored **as captured**. That includes `Cookie`, `Set-Cookie`,
  `Authorization`, CSRF tokens and request signatures, plus request and response bodies.
  Anything the page sent while you were signed in is in these files.
- `live.json` and `sessions.jsonl` are **not expired automatically**. A retention module exists
  in rep-cli but no command runs it in this version. Delete the files yourself when you are
  done, or avoid Live Export and browser-control captures for sessions you do not want on disk.
- The CLI reads these files and can print the stored values, including credentials, in its
  output. Treat the data directory, and any task you export, as containing live credentials.

## Jev / TypeSafe egress (optional, click to send)

- In the panel, "Classify traffic with Jev" sends a **minimized** record of the selected
  request to `rep-host` over native messaging: method, URL with credentials, query string and
  fragment removed and unknown path segments replaced by `redacted`, resource type, response
  status and content type. Headers, bodies and query values are never included.
- `rep-host` forwards that record to TypeSafe's Jev API (`https://api.typesafe.ai/v1/systemone`).
  The Jev key is read by the CLI and host from the `JEV`, `JEV_API_KEY` or `TYPESAFE_API_KEY`
  environment variable or from an env file whose path you register with
  `rep jev config --env-file PATH`; only that path is stored, in `rep-cli/jev.json` under your
  user config directory. **The key never enters the extension.**
- Other `rep` CLI commands can send more to Jev when a key is configured: `browser state`
  sends a screenshot of the current tab when its page-state signals are ambiguous, and
  `browser select` / `browser step` send the bounded role, name and context text of the
  controls they choose between. Without a configured key none of this leaves your machine.
  See the rep-cli documentation for the exact commands.
- TypeSafe's handling of what it receives is governed by TypeSafe's own privacy policy.

## What is stored in the browser

- `localStorage` of the panel: `themePreference`, `rep_layout_preference`,
  `rep_remove_duplicates`, `rep_sidebar_hidden` and a fallback copy of `liveExportEnabled`.
  **No API keys.**
- `chrome.storage.local`: `liveExportEnabled`, `repAmbientWatching` and `repAmbientSessionId`.
- Earlier versions of rep+ stored model-provider keys in the panel's `localStorage`
  (`anthropic_api_key`, `gemini_api_key`, `local_api_url`, `ai_provider` and the related model
  names) and an attack-surface cache. This version deletes those entries when the panel opens.
  If you used those features, also revoke or rotate the keys with the provider.

## What we do not do

- No data is sent to the authors of rep+; there are no analytics, telemetry or crash reports.
- No requests are made to Anthropic, Google or a local model endpoint, and the manifest no
  longer asks for `localhost:11434`.
- No browsing history is collected beyond the requests you choose to capture.

## Permissions

| Permission | Why |
| --- | --- |
| `debugger` | Browser control and captures requested by the `rep` CLI; attached only while a command needs it |
| `tabs` | Listing, creating, navigating and closing tabs for CLI commands |
| `nativeMessaging` | The local `rep-host` process (Live Export, Jev, browser control) |
| `storage` | Preferences and the capture on/off state |
| `alarms` | Declared for scheduled service-worker work; unused by this version |
| `webRequest` (optional) | Multi-tab / ambient capture |
| `<all_urls>` (optional) | Multi-tab capture and cross-origin replay from the panel |

## Your controls

- Clear the panel's list with "Clear all", or close DevTools, to drop in-memory captures.
- Turn Live Export off before capturing anything you do not want written to disk.
- Delete `~/.local/share/rep-cli` (or your `$XDG_DATA_HOME/rep-cli`) to remove on-disk captures.
- Revoke the optional permissions in `chrome://extensions`.
- Uninstalling the extension removes its browser storage but not rep-cli's files on disk.

## Changes to this policy

The "Last Updated" date at the top changes whenever this document changes. The document is
meant to track the code; if you find a mismatch, please open an issue.

## Contact and source

Questions: open an issue on [GitHub](https://github.com/bscript/rep/issues).
rep+ is open source; the code at [github.com/bscript/rep](https://github.com/bscript/rep) is
the authoritative description of its behavior.
