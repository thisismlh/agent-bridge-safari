#!/bin/sh
# Pads the source screenshots in docs/site/screenshots/src onto 2880x1800 canvases for
# App Store Connect (Mac screenshots must be one of the accepted sizes).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root
SRC="$ROOT/docs/site/screenshots/src"; OUT="$ROOT/docs/site/screenshots/2880x1800"
mkdir -p "$OUT"
for f in "$SRC"/*.png "$SRC"/*.jpg; do
  [ -f "$f" ] || continue
  name="$(basename "${f%.*}")"
  cp "$f" "$OUT/$name.png"
  # fit inside 2600x1520, then pad to 2880x1800 on a neutral background
  sips -Z 2600 "$OUT/$name.png" >/dev/null
  sips --padToHeightWidth 1800 2880 --padColor F3F4F6 "$OUT/$name.png" >/dev/null
  sips -s format png "$OUT/$name.png" --out "$OUT/$name.png" >/dev/null
  echo "$OUT/$name.png: $(sips -g pixelWidth -g pixelHeight "$OUT/$name.png" | awk '/pixel/ {printf "%s ", $2}')"
done
