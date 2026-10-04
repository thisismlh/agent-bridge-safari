# Support — Agent Bridge for Safari

## Setup

1. Open Agent Bridge for Safari.app. Click "Open Safari Extension Settings…", turn on the
   extension, and allow it on every website.
2. In Claude Code run:

   ```
   /plugin marketplace add thisismlh/agent-bridge-safari
   /plugin install safari@agent-bridge-safari
   ```

3. Run `/safari`. It should say the bridge is running in the app and the extension is
   connected.

## Common problems

**`/safari` says the extension is not connected.** Open the app and check its status
window. If the extension shows as off, turn it on in Safari > Settings > Extensions. If it
is on but not connected, quit and reopen Safari.

**Tools say a tab id is unknown.** Safari renumbers tabs when the extension reloads. Ask
Claude to call `tabs_context` again.

**A page cannot be read.** Safari's own pages (Start Page, settings, PDFs) and pages that
block extensions cannot be scripted. Navigate to a normal web page first.

**Console output is empty.** Pages with a strict Content-Security-Policy block the console
hook. Everything else keeps working.

**The app disappeared from Safari's Extensions list.** This happens if the app is
replaced by an unsigned build. Reinstall the signed app and reopen Safari.

## Uninstall

Turn the extension off in Safari > Settings > Extensions, quit the app from its menu bar
item, and move the app to the Trash. In Claude Code, run `/plugin uninstall safari`.

## Contact

https://github.com/thisismlh/agent-bridge-safari/issues
