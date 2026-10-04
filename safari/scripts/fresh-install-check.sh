#!/bin/sh
# Dry run of a fresh install, as a new user would do it. Run after `build-extension.sh release`.
# It installs the release app into /Applications, launches it, waits for the bridge, and prints
# the Claude Code steps to finish by hand.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Claude Code for Safari.app"
[ -d "$APP" ] || { echo "No release build at $APP. Run: TEAM=<team> ./scripts/build-extension.sh release"; exit 1; }

echo "1. Stopping any running copy and removing dev registrations"
pkill -f "Claude Code for Safari.app/Contents/MacOS" 2>/dev/null || true
sleep 1

echo "2. Installing to /Applications (replaces an existing copy)"
rm -rf "/Applications/Claude Code for Safari.app"
ditto "$APP" "/Applications/Claude Code for Safari.app"
pluginkit -e use -i com.michaelhelms.claude-code-safari.Extension 2>/dev/null || true

echo "3. Launching"
open "/Applications/Claude Code for Safari.app"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:47831/status | grep -q 403; then echo "   bridge answering on 47831"; break; fi
done

cat <<STEPS

4. In Safari: Settings > Extensions > turn on "Claude Code for Safari", allow on every website.
   (Only one entry should be listed. If two appear, the other is a stale dev build: untick it.)

5. In a NEW Claude Code session (not the one with the dev-mods folder), run:
     /plugin marketplace add thisismlh/claude-code-safari
     /plugin install safari@claude-code-safari
     /safari
   Expected: "Bridge: running in the Claude Code for Safari app", "Extension: connected".

6. Ask Claude: "Open example.com in Safari and read the page." Then: "Take a screenshot."

7. Quit Safari, reopen it, run /safari again: still connected, no re-enable needed (signed build).

Record anything that did not match in docs/site/support.md.
STEPS
