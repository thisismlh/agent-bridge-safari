# Privacy Policy — Agent Bridge for Safari

Last updated: 2026-10-04

Agent Bridge for Safari is a Mac app and Safari extension that lets Claude Code, running
on the same Mac, read and control Safari tabs when you ask it to.

## What the app does with data

- **Everything stays on your Mac.** The app runs a local bridge that listens only on
  127.0.0.1. It does not connect to any server of ours. We have no servers.
- **Page content goes to Claude Code when you use a tool.** When Claude Code calls a
  browser tool, the extension reads the current page (its text, structure, console
  output, network request metadata, or a screenshot) and passes it through the bridge
  to Claude Code on your Mac. What Claude Code does with it is governed by Anthropic's
  privacy policy for Claude Code, not by this app.
- **Nothing is stored.** The app keeps console and network entries for open tabs in
  memory and discards them when a tab navigates or closes. It writes one small file in
  its own sandbox container with the bridge's port, and keeps no history, logs, or
  analytics.
- **No tracking.** The app contains no analytics, advertising, or crash-reporting SDKs.

## Permissions the extension asks for

The Safari extension asks for access to every website so that Claude Code can work on
whatever page you point it at. You can limit this per site in Safari > Settings >
Extensions, and turn the extension off there at any time.

## Contact

Questions: open an issue at https://github.com/thisismlh/agent-bridge-safari/issues.
