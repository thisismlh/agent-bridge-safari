# Safari browser control mod

## Goal

Give Claude Code a set of Safari tools that match the everyday Claude in Chrome tools
(tabs, navigate, read page, find, click, type, fill forms, scroll, run JavaScript,
screenshot), installed as a Claude Code mod with no Xcode build, no signing, and no
extension install.

## Approach

A hooks module registers one tool per capability under `mcp__safari__<name>`.
Each tool is served by a `tool.call` hook that runs `osascript -l JavaScript`
(JXA) through `$.process.run`. JXA addresses Safari windows and tabs and injects a
page script with `doJavaScript`. Screenshots use `screencapture -l <windowId>`.

Alternatives rejected: a Safari Web Extension plus native host (weeks of setup, same
page-level reach); driving Safari with System Events alone (no DOM access).

## Prerequisite

Safari > Settings > Advanced > "Show features for web developers", then
Develop > "Allow JavaScript from Apple Events". Without it every page tool fails with
a message naming that setting. Tabs, navigate, and screenshot work without it.

## Components

- `hooks/register.ts`: registers tools at `session.start`, serves `tool.call`.
- `hooks/safari.ts`: the JXA bridge. One function `jxa(source)` and helpers to
  resolve a tab (`windowId:tabIndex`, default current tab of front window) and run
  page JavaScript in it, with the readiness wait.
- `hooks/page-script.ts`: the injected page runtime as a string. Builds the
  accessibility-style tree, assigns `ref_N` ids kept on `window.__claude`, and
  implements click, type, form fill, scroll, and find. Refs reset per navigation.
- `hooks/format.ts`: pure helpers (tab id parse, tree text formatting), unit tested.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| tabs_context | none | windows and tabs with `tabId`, url, title, active flag |
| tabs_create | url? | new tabId |
| tabs_close | tabId | ok |
| navigate | url or back/forward/reload, tabId? | final url and title after load |
| read_page | tabId?, filter (all/interactive), max_chars | tree lines with `[ref_N]` |
| find | query, tabId? | up to 20 matching refs |
| get_page_text | tabId?, max_chars | main content text |
| click | ref or x,y (CSS px), tabId?, modifiers? | what was clicked |
| type | text, ref?, tabId? | ok |
| press_key | keys (e.g. "Return", "cmd+a"), tabId? | ok, via System Events |
| form_input | ref, value, tabId? | ok |
| scroll | direction/amount or ref, tabId? | new scroll position |
| screenshot | tabId? | PNG image scaled to CSS pixels plus viewport size |
| javascript | expression, tabId? | JSON result |
| wait | seconds, or selector/text with timeout | ok or timed out |

Coordinates are CSS pixels of the viewport, matching the screenshot's scale, so a
point read off a screenshot can be clicked directly.

## Error handling

Every tool returns `isError` with one plain sentence: Safari not running (the mod
launches it), no window, bad tabId, JavaScript bridge disabled (with the setting
name), page JavaScript threw (message), timeout. No stack traces reach the model.

## Testing

Unit tests under `claude plugin test` for the pure helpers. End-to-end verification
by calling each tool against example.com and a form page from the session.

## Out of scope

Console log and network request capture (needs an extension), file upload, GIF
recording.
