# App Store / download listing

**Name:** Claude Code for Safari
**Subtitle:** Let Claude Code drive your Safari tabs
**Category:** Developer Tools
**Price:** Free
**Privacy policy URL:** https://github.com/thisismlh/claude-code-safari/blob/main/docs/site/privacy.md
**Support URL:** https://github.com/thisismlh/claude-code-safari/blob/main/docs/site/support.md

## Description

Claude Code for Safari connects Claude Code to Safari on your Mac, so Claude can test
your web app, fill in forms, read console errors, and pull data from pages, all in the
browser you already use and are already signed in to.

With the extension on, Claude Code can:

- Open, list and close tabs, and navigate
- Read a page as an accessibility tree with element references, or extract its text
- Click, type, press keys, fill forms and upload files
- Read the page's console output and network requests
- Take viewport screenshots and run JavaScript in the page

Everything stays on your Mac. The app runs a small local bridge on 127.0.0.1 that only
the Safari extension and Claude Code can reach. No accounts, no servers, no analytics.

Requires Claude Code and the free `safari` plugin:

    /plugin marketplace add thisismlh/claude-code-safari
    /plugin install safari@claude-code-safari

## Keywords

claude, claude code, safari, browser automation, web testing, developer tools, ai agent

## What's New (1.0)

First release.

## Review notes (for App Review)

The app hosts a loopback HTTP bridge (127.0.0.1) between the bundled Safari extension and
Claude Code, a developer CLI from Anthropic that the user runs separately. The extension
requests access to all websites because the user directs Claude Code at arbitrary pages.
Nothing is transmitted off the device by this app. To test: install Claude Code
(https://code.claude.com), run the two plugin commands above, open any web page in
Safari, and ask Claude Code to "read the current Safari page".

## Screenshots

App Store requires 1280×800, 1440×900, 2560×1600 or 2880×1800. `docs/site/screenshots/`
holds the sources; `scripts/listing-screenshots.sh` pads them to 2880×1800.
