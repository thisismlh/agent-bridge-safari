# Safari mod for Claude Code

Lets Claude drive Safari the way Claude in Chrome drives Chrome: list tabs, navigate,
read the page as an accessibility tree with element refs, find, click, type, fill
forms, scroll, hover, press keys, run JavaScript, and take viewport screenshots.

It is a Claude Code mod: a hooks module that registers tools named
`mcp__safari__<tool>` and serves them by sending AppleScript to Safari. No Xcode, no
signing, no extension install.

## Two transports

1. **Safari extension** (preferred). A Safari Web Extension in `extension/` talks to
   the mod through a local bridge daemon (`bridge/bridge.mjs`). Gives page access,
   screenshots, console and network capture, file uploads and stable tab ids with no
   macOS permissions.
2. **AppleScript fallback**. Used automatically when the extension is not connected.
   Needs Safari's Develop > "Allow JavaScript from Apple Events", and Screen Recording
   for screenshots.

## One-time setup (extension)

1. Build and register the app: `./scripts/build-extension.sh`, then `/safari install`
   in Claude Code (or open `app/Claude Code for Safari.app`).
2. Safari > Settings > Extensions > turn on "Claude Code for Safari" and allow it on
   every website.
3. Unsigned builds only: Safari > Settings > Developer > "Allow unsigned extensions"
   (Safari 27 moved it there from the Develop menu; it resets when Safari restarts).
   Sign in to Xcode with an Apple ID and build with
   `TEAM=4689L493Z5 ./scripts/build-extension.sh` (your Personal Team id; `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` lists it) to make it permanent.
   Alternative for development: Settings > Developer > "Add Temporary Extension…" and
   pick the `extension/` folder. That loads it without the app until Safari quits.

After rebuilding, Safari keeps running the old extension code until it reloads it:
quit and reopen Safari (app build), or re-add the temporary extension. `/safari`
shows the extension version the bridge sees.

`/safari` shows bridge and extension status. Real keyboard shortcuts through
`press_key` (anything other than Enter, Tab, Escape) still need Accessibility
permission for the app running Claude Code.

## Loading

In the session that built it, the mod hot-reloads from the session's mods folder.
Anywhere else:

```bash
claude --plugin-dir "/Users/michaelhelms/Projects/Safari Plug in/safari"
```

or add that path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Tools

| Tool | What it does |
| --- | --- |
| tabs_context | Windows and tabs with `tabId` (`<windowId>:<tabIndex>`) |
| tabs_create, tabs_close | Open or close a tab |
| navigate | Load a URL, or `back`, `forward`, `reload`; waits for load |
| read_page | Accessibility tree; interactive elements carry `[ref_N]` |
| find | Elements whose role, name, value or href match a query |
| get_page_text | Visible text, main content first |
| click, hover | By ref or by viewport CSS-pixel coordinates |
| type | Types into the focused element or a ref, firing key and input events |
| press_key | `Return`, `Tab`, `Escape` in the page; other keys and shortcuts via macOS |
| upload_file | Attach local files to a file input (extension only) |
| console_messages | Console output captured in a tab (extension only) |
| network_requests | Requests observed in a tab (extension only) |
| form_input | Set text, checkbox, radio, select or contenteditable by ref |
| scroll | By direction and ticks, or scroll a ref into view |
| screenshot | Viewport PNG scaled to CSS pixels, so coordinates map to click |
| javascript | Evaluate an expression in the page and return JSON |
| wait | Seconds, or until a selector or text appears |

Not available in Safari: trusted mouse and keyboard events (no debugger API), GIF recording.

## Development

`hooks/register.ts` is the only file that touches the engine object `$`; it builds an
`Io` object of closures (`hooks/io.ts`) for the helper modules, because the engine's
validator refuses a mod that passes `$` across an import. Validate with the engine
the desktop app runs, which is newer than the CLI on PATH:

```bash
"$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude plugin validate safari
```

```bash
cd safari && bunx tsc -p . && bun test tests/ bridge/
```

After editing `extension/page-runtime.js`, run `bun scripts/sync-runtime.ts` so the
AppleScript transport gets the same code.

`scripts/live.ts` drives a tool against the real Safari through a fake engine:

```bash
bun scripts/live.ts navigate '{"url":"https://example.com"}'
```
