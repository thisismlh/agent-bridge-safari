# Distribution: self-contained app and plugin marketplace

## Goal

Make the Safari integration installable by strangers: a Mac app that contains the
Safari extension and hosts the bridge itself (no Node), ready for notarization or
App Review, and a Claude Code plugin marketplace that installs the mod with one command.

## Bridge inside the app

The container app replaces `bridge/bridge.mjs` in production. Same protocol, ported to
Swift over POSIX sockets with GCD, two listeners on 127.0.0.1:

- extension side: `POST /ext/poll`, `POST /ext/result`, guarded by
  `Origin: safari-web-extension://…` and `Content-Type: application/json`.
- Claude Code side: `POST /call`, `GET /status`, guarded by `Authorization: Bearer <token>`
  and `Content-Type: application/json`.

The App Sandbox cannot write `~/.claude`, so the Unix socket goes away. Instead the app
writes a discovery file in its own container:
`~/Library/Containers/com.michaelhelms.claude-code-safari/Data/Library/Application Support/bridge.json`
with `{ "port", "token", "pid", "version" }`. The mod reads it (the mod is not sandboxed),
and the extension asks the app's native messaging handler for the port with
`browser.runtime.sendNativeMessage`, falling back to 47831. The port is 47831 when free,
otherwise the next free one.

Instance tracking, sticky primary by reach/tabs/recency, pickup timeout, random ids and
timed-out command removal are ported unchanged. The Node bridge stays for tests and for
running the extension unpacked without the app; the mod prefers the app.

## Mod changes

`ensureBridge` order: discovery file reachable → use it; else launch the app by bundle id
(`open -g -b com.michaelhelms.claude-code-safari`) and wait up to 5 s; else the Node
bridge if node or bun exists; else AppleScript fallback. `/safari` reports which bridge
answered. `/safari install` opens the app, which opens Safari's extension settings.

## App UI

One SwiftUI window: bridge status (port), extension status (version, instances),
Claude Code status (last call), buttons "Open Safari Extension Settings"
(SFSafariApplication.showPreferencesForExtension), "Launch at Login" toggle
(SMAppService), "Copy Claude Code setup command". A menu bar extra mirrors the
status. The app keeps running in the background when its window closes.

## Entitlements and review readiness

App: App Sandbox, network client and server. Extension: App Sandbox, network client.
Both: hardened runtime. `PrivacyInfo.xcprivacy` declaring no tracking and no required
reason APIs beyond file timestamps. `scripts/build-extension.sh` gains a `release` mode
that archives, signs with Developer ID when available, and prints the notarization
commands.

## Marketplace

Repo root gets `.claude-plugin/marketplace.json` naming the `safari` plugin at
`./safari`. `safari/.claude-plugin/plugin.json` gains author, repository, license,
keywords. MIT license file. README for strangers: install the app, enable the
extension, add the marketplace, install the plugin.

## Out of scope

App Store screenshots and copy, the developer account, and the submissions themselves.
