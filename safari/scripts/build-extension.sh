#!/bin/sh
# Builds the Safari extension container app. Uses your Apple ID team when Xcode has
# one (TEAM=XXXXXXXXXX ./scripts/build-extension.sh), ad-hoc signing otherwise.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/xcode/Claude Code for Safari"
# Default to the Apple Development team Xcode knows when no TEAM is given, so a signed
# build never silently turns into an ad-hoc one (Safari drops unsigned extensions).
if [ -z "$TEAM" ]; then
  TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -o 'teamID = [A-Z0-9]*' | head -1 | awk '{print $3}')
fi
if [ -n "$TEAM" ]; then
  echo "Signing with team $TEAM"
  SIGN="CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=$TEAM"
else
  SIGN='CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER='
fi
# shellcheck disable=SC2086
xcodebuild -project "Claude Code for Safari.xcodeproj" -scheme "Claude Code for Safari" -configuration Debug \
  -derivedDataPath ../DerivedData build $SIGN -allowProvisioningUpdates | grep -E "error:|warning: .*sign|BUILD" || true
echo "App: $(cd ../DerivedData/Build/Products/Debug && pwd)/Claude Code for Safari.app"
rm -rf "$ROOT/app" 2>/dev/null; mkdir -p "$ROOT/app"
ditto "../DerivedData/Build/Products/Debug/Claude Code for Safari.app" "$ROOT/app/Claude Code for Safari.app"
echo "Copied to app/Claude Code for Safari.app"
