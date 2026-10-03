# Safari mod for Claude Code

Lets Claude drive Safari the way Claude in Chrome drives Chrome: list tabs, navigate,
read the page as an accessibility tree with element refs, find, click, type, fill
forms, scroll, hover, press keys, run JavaScript, and take viewport screenshots.

It is a Claude Code mod: a hooks module that registers tools named
`mcp__safari__<tool>` and serves them by sending AppleScript to Safari. No Xcode, no
signing, no extension install.

## One-time setup

1. **Safari JavaScript bridge** (required for every page tool)
   Safari > Settings > Advanced > turn on "Show features for web developers".
   Then menu bar Develop > "Allow JavaScript from Apple Events".
2. **Automation**: the first call prompts macOS to let the app running Claude Code
   control Safari. Allow it. (System Settings > Privacy & Security > Automation.)
3. **Screenshots**: System Settings > Privacy & Security > Screen Recording, allow the
   app running Claude Code, then restart it.
4. **press_key**: System Settings > Privacy & Security > Accessibility, allow the app
   running Claude Code.

Tabs, navigate, and tabs_create work with no setup.

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
| press_key | Real key presses via macOS, e.g. `Return`, `cmd+a`, `shift+Tab` |
| form_input | Set text, checkbox, radio, select or contenteditable by ref |
| scroll | By direction and ticks, or scroll a ref into view |
| screenshot | Viewport PNG scaled to CSS pixels, so coordinates map to click |
| javascript | Evaluate an expression in the page and return JSON |
| wait | Seconds, or until a selector or text appears |

Not available without a real Safari extension: console log and network request capture.

## Development

```bash
cd safari && bunx tsc -p . && bun test tests/
```

`scripts/live.ts` drives a tool against the real Safari through a fake engine:

```bash
bun scripts/live.ts navigate '{"url":"https://example.com"}'
```
