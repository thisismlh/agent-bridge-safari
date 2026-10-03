#!/bin/sh
# Builds the Safari extension container app. Uses your Apple ID team when Xcode has
# one (TEAM=XXXXXXXXXX ./scripts/build-extension.sh), ad-hoc signing otherwise.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/xcode/Claude Code for Safari"
if [ -n "$TEAM" ]; then
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
