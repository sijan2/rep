# Privacy Policy for rep+

**Last Updated**: 2025

## Overview

rep+ is a Chrome DevTools extension that helps developers and security researchers capture, modify, and replay HTTP requests. This privacy policy explains how we handle your data.

## Data Collection

### What We Collect

**We do NOT collect any personal data or browsing information.**

rep+ operates entirely locally in your browser. All data is stored locally using Chrome's `localStorage` API and is never transmitted to external servers (except as described below for AI features).

### Local Storage

The following data is stored locally on your device:

- **Captured HTTP Requests**: Stored in memory only, cleared when you close DevTools
- **CLI Live Captures** (Optional): Browser-bridge captures are written by the local `rep-host` native-messaging process to the user's local rep-cli data directory
- **User Preferences**: Theme preference, dismissed banners
- **AI API Keys** (Optional): If you choose to use AI features, your API keys are stored locally in `localStorage`
- **Export Data**: Any exported request data is stored locally if you choose to save it

### What We DON'T Collect

- ❌ No browsing history
- ❌ No personal information
- ❌ No analytics or tracking
- ❌ No telemetry data
- ❌ No usage statistics
- ❌ No data sent to our servers

## Third-Party Services

### AI Features (Optional)

If you choose to use the AI-powered features (Request Explanation, Attack Vector Suggestions), rep+ uses third-party AI services:

- **Anthropic Claude API**: When you use Claude for explanations
- **Google Gemini API**: When you use Gemini for explanations

**Important Notes:**
- You must provide your own API keys (stored locally in your browser)
- Your API keys are never shared with us
- Request/response data is sent directly to the AI provider you choose
- We have no access to this data
- Please review Anthropic's and Google's privacy policies for how they handle your data

### Browser-Control Permissions

The CLI browser bridge requires these extension permissions:

- **`debugger`**: Attaches Chrome DevTools Protocol sessions only when you invoke a browser-control or capture command
- **`tabs`**: Lists browser tabs and creates or closes task-owned tabs for explicit commands
- **`nativeMessaging`**: Exchanges local RPC and capture data with the installed `rep-host` process
- **`storage`**: Stores extension preferences and ambient-capture state locally

### Optional Permissions

rep+ requests optional permissions only when you explicitly enable features:

- **`webRequest` + `<all_urls>`**: Requested when you enable multi-tab capture or grant cross-origin request access
- These permissions allow the extension to capture requests from all tabs and replay requests to arbitrary HTTP(S) origins
- You can revoke these permissions at any time through Chrome's extension settings
- Without these permissions, DevTools capture for the currently inspected tab and explicit CLI control through `debugger` remain available; optional multi-tab/ambient capture is unavailable

## Data Security

- All data is stored locally in your browser
- No data is transmitted to external servers (except AI API calls you initiate)
- API keys are stored in browser localStorage (encrypted by Chrome)
- You can clear all data by clearing browser storage or uninstalling the extension

## Your Rights

- **Access**: All data is stored locally - you can access it through Chrome DevTools
- **Deletion**: Clear browser storage or uninstall the extension to delete all data
- **Control**: You control which permissions to grant and which features to use

## Changes to This Policy

We may update this privacy policy. The "Last Updated" date at the top indicates when changes were made.

## Contact

For questions about this privacy policy, please open an issue on [GitHub](https://github.com/bscript/rep/issues).

## Open Source

rep+ is open source. You can review the code to verify our privacy claims:
- [GitHub Repository](https://github.com/bscript/rep)
