# rep+

> Burp-style HTTP Repeater for Chrome DevTools with built-in AI

rep+ is a lightweight Chrome DevTools extension inspired by Burp Suite's Repeater, now supercharged with AI. I often need to poke at a few requests without spinning up the full Burp stack, so I built this extension to keep my workflow fast, focused, and intelligent with integrated LLM support.

> CLI companion: [rep-cli](https://github.com/sijan2/rep-cli) - Analyze captured traffic with Claude Code

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
browser. Captures are streamed to the native host in bounded batches and
written atomically to `~/.local/share/rep-cli/live.json`.

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
