# rep+

Chrome, Arc and Dia extension that gives [rep-cli](https://github.com/sijan2/rep-cli)
control of your signed-in browser: tabs, page reads, network capture with
response bodies, and a DevTools panel to inspect and replay requests.

## Install

1. Clone this repository.
2. Open `chrome://extensions` (or `arc://extensions`, `dia://extensions`), turn on
   Developer mode, choose **Load unpacked**, select the clone.
3. Connect the CLI: `rep browser install --extension-path /path/to/rep`, then
   `rep browser doctor`.

The extension never stores API keys; model calls run in the local CLI and host.

## Develop

```sh
npm install
npm test
```

After editing, reload with `rep browser reload-extension`.

Privacy: [PRIVACY.md](PRIVACY.md). License: [LICENSE](LICENSE).
