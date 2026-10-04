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

# ---- release mode: `./scripts/build-extension.sh release`
# Archives a Release build, signs with Developer ID when the certificate exists, and
# prints the notarization steps. Requires the paid Apple Developer Program.
if [ "$1" = "release" ]; then
  cd "$ROOT/xcode/Claude Code for Safari"
  OUT="$ROOT/dist"; rm -rf "$OUT"; mkdir -p "$OUT"
  if security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
    STYLE="CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=\"Developer ID Application\" DEVELOPMENT_TEAM=$TEAM"
    echo "Signing release with Developer ID"
  else
    STYLE="CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=$TEAM"
    echo "No Developer ID certificate found: release build signed for local use only"
  fi
  # shellcheck disable=SC2086
  eval xcodebuild -project '"Claude Code for Safari.xcodeproj"' -scheme '"Claude Code for Safari"' -configuration Release \
    -archivePath '"$OUT/Claude Code for Safari.xcarchive"' archive $STYLE -allowProvisioningUpdates | grep -E "error:|ARCHIVE" || true
  ditto "$OUT/Claude Code for Safari.xcarchive/Products/Applications/Claude Code for Safari.app" "$OUT/Claude Code for Safari.app"
  ditto -c -k --keepParent "$OUT/Claude Code for Safari.app" "$OUT/Claude-Code-for-Safari.zip"
  cat <<STEPS
Release app: $OUT/Claude Code for Safari.app
Zip for notarization: $OUT/Claude-Code-for-Safari.zip

Notarize (one-time: xcrun notarytool store-credentials "AC_PASSWORD" --apple-id <id> --team-id $TEAM --password <app-specific password>):
  xcrun notarytool submit "$OUT/Claude-Code-for-Safari.zip" --keychain-profile "AC_PASSWORD" --wait
  xcrun stapler staple "$OUT/Claude Code for Safari.app"
  ditto -c -k --keepParent "$OUT/Claude Code for Safari.app" "$OUT/Claude-Code-for-Safari.zip"
App Store instead: open the .xcarchive in Xcode > Organizer > Distribute App.
STEPS
fi
