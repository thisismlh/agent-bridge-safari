# Agent Bridge for Safari

Browser automation for Safari inside Claude Code: open tabs, read pages as an
accessibility tree, click, type, fill forms, upload files, read the console and network
log, take screenshots, and run JavaScript. The same kind of thing Claude Code does with
Chrome, built for Safari.

Two parts:

- **Agent Bridge for Safari.app**: a small Mac app that contains the Safari extension and
  the local bridge between Safari and Claude Code. It runs in the menu bar.
- **The `safari` plugin** for Claude Code, which registers the browser tools and the
  `/safari` command.

Everything stays on your Mac. The bridge listens on 127.0.0.1 only, accepts the Safari
extension by its origin, and accepts Claude Code only with a per-session token.

Works with Claude Code through its plugin, and with any agent that speaks the Model
Context Protocol (MCP): OpenAI Codex CLI, Cursor, Zed, Windsurf and others.

## Install

1. Download the app from the [latest release](https://github.com/thisismlh/agent-bridge-safari/releases/latest),
   unzip it, move it to Applications, and open **Agent Bridge for Safari.app** once. Click "Open Safari Extension Settings…",
   turn on the extension, and allow it on every website.
2. In Claude Code:

   ```
   /plugin marketplace add thisismlh/agent-bridge-safari
   /plugin install safari@agent-bridge-safari
   ```

3. Run `/safari`. It should report the bridge running in the app and the extension
   connected. Claude Code launches the app on demand if it isn't running; tick
   "Launch at login" in the app to keep it ready.

## Other agents (MCP)

The app contains an MCP server. Point any MCP client at the app's executable with the
`--mcp` flag; it launches and pairs with the app on its own.

```
/Applications/Agent Bridge for Safari.app/Contents/MacOS/Agent Bridge for Safari --mcp
```

- **Codex CLI:** `codex mcp add safari -- "/Applications/Agent Bridge for Safari.app/Contents/MacOS/Agent Bridge for Safari" --mcp`
- **Claude Code without the plugin:** `claude mcp add safari -- "/Applications/Agent Bridge for Safari.app/Contents/MacOS/Agent Bridge for Safari" --mcp`
- **Cursor, Zed, Windsurf and others:** add a stdio server with that command and the single argument `--mcp` to the client's MCP settings, for example in Cursor's `mcp.json`:

  ```json
  { "mcpServers": { "safari": { "command": "/Applications/Agent Bridge for Safari.app/Contents/MacOS/Agent Bridge for Safari", "args": ["--mcp"] } } }
  ```

The MCP server exposes the same tools as the plugin. The plugin adds the `/safari`
command and an AppleScript fallback when the app isn't installed.

## What the agent can do

| Tool | What it does |
| --- | --- |
| tabs_context, tabs_create, tabs_close | List, open and close tabs |
| navigate | Load a URL, or go back, forward, reload |
| read_page, find, get_page_text | Read the page as a tree with element refs, search it, or extract its text |
| click, hover, type, press_key, form_input, scroll | Drive the page |
| upload_file | Attach local files to a file input |
| screenshot | Viewport PNG in CSS pixels, optionally saved to disk |
| console_messages, network_requests | What the page logged and requested since its last navigation |
| javascript | Evaluate an expression in the page |
| wait | Wait for time, a selector, or text |

Not possible in Safari: trusted mouse and keyboard events (Safari has no debugger API;
clicks and typing are synthetic, which works on most sites) and GIF recording.

## Without the app

The plugin also works with no app installed, through AppleScript, if Safari >
Settings > Developer > "Allow JavaScript from Apple Events" is on. That path has no
console, network or upload support and needs Screen Recording permission for
screenshots.

## Building from source

See [safari/README.md](safari/README.md). The Xcode project is in `safari/xcode`,
`./scripts/build-extension.sh` builds and signs the app, and
`./scripts/build-extension.sh release` archives it and prints the notarization steps.

MIT licensed.
