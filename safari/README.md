# agent-bridge-safari (Claude Code plugin)

Gives Claude Code tools to drive Safari on this Mac: list and open tabs, navigate, read
a page as an accessibility tree with element refs, find, click, type, fill forms, upload
files, scroll, hover, press keys, read console output and network requests, take
viewport screenshots, run JavaScript, and wait for content. It also adds the `/safari`
command for status and for handing a request straight to the tools.

The tools talk to the **Agent Bridge for Safari** Mac app, which contains the Safari
extension and a local bridge on 127.0.0.1. Install the app from
https://github.com/thisismlh/agent-bridge-safari/releases/latest, open it once, and turn
the extension on in Safari > Settings > Extensions. Claude Code launches the app on
demand and pairs with it through the `agentbridge://` URL scheme with a per-session
token; nothing leaves the Mac.

Without the app the plugin falls back to AppleScript, which needs Safari > Settings >
Developer > "Allow JavaScript from Apple Events" and offers no console, network or
upload tools.

## Commands

- `/safari`: bridge and extension status.
- `/safari start`: start the bridge. `/safari install`: open the app.
- `/safari <request>`: hand the request to Claude with the Safari tools, for example
  `/safari open localhost:3000 and check the console for errors`.

## Development

The Mac app, the Safari extension and the bridge live in `../mac` of the repository.
`bun ../mac/scripts/sync-runtime.ts` copies the page runtime into `hooks/page-script.ts`
after editing it. Check the plugin with `bunx tsc -p . && bun test tests/` and validate
with `claude plugin validate .`.
