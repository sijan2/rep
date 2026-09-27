# rep+

> Burp-style HTTP Repeater for Chrome DevTools with built-in AI

rep+ is a lightweight Chrome DevTools extension inspired by Burp Suite's Repeater, now supercharged with AI. I often need to poke at a few requests without spinning up the full Burp stack, so I built this extension to keep my workflow fast, focused, and intelligent with integrated LLM support.

> CLI companion: [rep-cli](https://github.com/sijan2/rep-cli) - Analyze captured traffic with Claude Code

## Jev traffic classification

Select a captured request, open the AI menu, and choose **Classify traffic with
Jev**. The result shows one of `api`, `document`, `static`, `analytics`, or
`other`, plus the provider's confidence and category probabilities. Confidence
below 80% is marked for review. Classification does not resend the request.

Install the matching updated `rep-cli` and `rep-host`, then point them at a local
environment file containing `JEV="your-key"`:

```bash
rep jev config --env-file /absolute/path/to/.env
rep jev status -j
rep jev doctor -j
```

Configuration stores the file's absolute path in `~/.config/rep-cli/jev.json`
(or under `XDG_CONFIG_HOME`); the credential remains in the environment file.
`status` checks local configuration; `doctor` makes a small synthetic API call.
Reload the extension after updating its code and native host.

Only the selected request's minimized URL, method, resource type, status, and
content type are sent for classification. Both the extension and native host
sanitize metadata. Headers, bodies, URL credentials, queries, and fragments are
excluded; the host also redacts unknown path segments. Jev credentials are read
by the native host, never stored in the extension. Results and provider errors
are displayed as plain text. The action uses a correlated native response and
reports a timeout after 35 seconds if the host is unavailable.

Malformed results are rejected, including incomplete probability distributions,
invalid numeric values, a category that is not a highest-probability choice, or
an invalid review flag. Verification on 2026-09-19: `npm test` passes all 212
extension tests, including 24 Jev tests. `npm run package` also passes and
excludes environment files from the archive.

## Agent/browser bridge

The MV3 background worker owns one persistent Native Messaging connection to
`rep-host`. The CLI can control the running browser without opening DevTools:

```bash
rep browser status --browser arc -j
rep browser reload-extension --browser arc
rep browser create about:blank --browser arc -j
rep browse https://github.com --browser arc -j
rep browse https://github.com/settings/profile --tab <id> --referrer https://github.com/ -j
rep browser fetch https://github.com/settings/profile --browser arc -j
rep browser action @action.js --tab <id> --settle 1500ms --max-result 65536 -j
rep browser watch start --browser arc -j
rep browser watch stop --browser arc -j
rep browser attach --tab <id> -j
rep browser cdp DOM.getDocument --tab <id> -j
rep browser eval 'document.title' --tab <id> -j
rep browser detach --tab <id> -j
rep browser download <captured-get-id> /absolute/path/artifact.bin -j
```

Navigation, fetch, Runtime, DOM, Input, Page, and Network commands run against
the real Arc/Chrome profile via `chrome.debugger`. HttpOnly cookies stay in the
browser. Captured records cross a bounded, acknowledged native-send queue,
are spooled to private files, and are sealed for exact retrieval.
Scoped CLI captures publish beneath their workspace/task directory; legacy
global capture uses `~/.local/share/rep-cli/live.json`.

Explicit CDP captures now retain HTTP protocol/connection/timing/security
metadata and WebSocket lifecycle plus ordered sent/received message events.
Text and binary payloads have explicit encoding and completeness metadata.
These are browser-exposed messages; the collector does not reconstruct wire
fragmentation, compression, masking or QUIC packets. WebTransport lifecycle is
captured through CDP. Add `--protocol-payloads` to CLI open/browse/fetch/action
for WebTransport datagrams/streams and WebRTC data-channel messages. This wraps
page APIs during that explicit capture and restores them afterward. Evidence
declares page-controlled provenance, effective limits and gaps. Raw packets and
original encoded RTP frames remain outside this collector.

Add `--webrtc-media` to record existing WebRTC audio/video tracks independently
of `--protocol-payloads`. The browser's native MediaRecorder records clones of
tracks on newly observed peer connections. Capture does not request camera or
microphone access, alter application transforms, or stop original tracks. Track
enabled changes are mirrored to the clones. Each track produces a separate
`webrtc_media` record with `reencoded_media` semantics and coverage of the
`recorded_media_interval`; its ordered chunks can be exported with
`rep media RECORD --saved HASH --save /absolute/path/recording.webm`.

Media capture allows eight concurrent recorders per observed realm, a
60-second timer and 4 MiB per track, with 250 ms chunk requests. Shared capture byte
and event limits still apply. Limits, recorder errors, unavailable APIs and
interrupted contexts produce explicit gaps. Normal stopping waits for the
recorder's final chunk and releases only the clones. Native encoders add CPU
cost and may buffer data beyond the observer's byte limits. These recordings
contain reencoded media. Original RTP packets and earlier call history are
outside their coverage. Timer delivery and cleanup depend on a responsive realm.

Default collector budgets are 64 MiB of aggregate archived payload bytes,
10,000 request/connection records, 10,000 stream events and a 16 MiB native
send backlog. Capture counters and reason fields disclose omissions. Browser
and CDP delivery may still allocate transient copies, so these are not strict
process memory caps. See the CLI's `rep describe stream` and
[capture documentation](https://github.com/sijan2/rep-cli/blob/main/docs/body-capture.md).

Captured actions evaluate inside the real renderer while one isolated CDP
session records their resulting requests and bounded bodies. Action results
have a separate byte cap so binary data cannot flood Native Messaging. A
bounded observation gate keeps the capture open for delayed callbacks before
the normal network-idle interval can seal it.

The bridge can create an inactive task-owned tab without navigation capture.
The CLI uses that primitive for browser-bound downloads: it calls
`Network.loadNetworkResource`, drains the IO stream in bounded chunks, and
closes the stream, attachment, and tab before publishing the validated file.
This path does not require Arc's browser-process remote-debugging port.
The extension can also reload its unpacked source through the same bridge with
`rep browser reload-extension`; the CLI waits for a replacement host to
reconnect.

For signed navigation/fetch URLs, the CLI accepts a mode-0600 `@file` operand;
the extension receives the URL over the local bridge without putting its query
in the process argument list. `@file` requests return only safe metadata and
capture IDs: request/final URLs, response headers, response bodies, and
URL-bearing errors are omitted from RPC output while the full request remains
in the sealed local capture. `browser fetch --headers-only` cancels a large
response body after headers while retaining the captured request handle for a
subsequent browser-streamed download. That cancellation, and a browser-managed
attachment handoff, are labeled intentional and excluded from
`failed_requests` without masking genuine transport errors.

Captured request descriptors preserve chronology with an explicit `sequence`.
The CLI may also derive a secret-free `terminal_outcome` from the sealed
capture, reporting a completed framework/HTTP redirect or download chain by
request IDs and terminal status while listing later form failures separately.

Ambient watch observes ordinary requests across materialized tabs, including
redirect hops and network failures. It stays dormant when disabled and resumes
an unfinished session after an extension restart or unexpected native-host
reconnect. Watch transitions are idempotent. Explicit navigation, fetch, and
action capture use CDP for response bodies and remain isolated from ambient
traffic.

For Arc browser-process control and UI-free extension reloads:

```bash
rep arc launch --restart -j
rep arc cdp Target.getTargets -j
rep arc cdp Runtime.evaluate --target <target-id> --params '{"expression":"document.title"}' -j
rep arc reload-extension -j
```
