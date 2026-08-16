#!/bin/bash
# build-icons.sh — regenerate the desktop GUI's per-platform icons from the
# canonical brand asset (web/public/icon-512.png).
#
# Produces, under electron/assets/:
#   icon.png  (512x512 source of truth for Linux + fallback)
#   icon.icns (macOS, via iconutil iconset)
#   icon.ico  (Windows multi-size, via Python PIL when available)
#
# Usage: ./scripts/build-icons.sh   (run from electron/)
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="../web/public/icon-512.png"
ASSETS="assets"

if [ ! -f "$SRC" ]; then
  echo "ERROR: canonical brand asset not found at $SRC" >&2
  exit 1
fi

sips -g pixelWidth "$SRC" >/dev/null 2>&1 || {
  echo "ERROR: sips (macOS) required to process the source icon" >&2
  exit 1
}

echo "Copying canonical brand icon → $ASSETS/icon.png"
cp "$SRC" "$ASSETS/icon.png"

# --- macOS .icns ------------------------------------------------------------
ICONSET="$ASSETS/icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" "$ASSETS/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
done
for s in 16 32 128 256 512; do
  d=$((s * 2))
  sips -z "$d" "$d" "$ASSETS/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
done
iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
rm -rf "$ICONSET"
echo "  → $ASSETS/icon.icns"

# --- Windows .ico (best-effort; PIL optional) --------------------------------
if python3 -c "import PIL" >/dev/null 2>&1; then
  python3 - "$ASSETS/icon.png" "$ASSETS/icon.ico" <<'PY'
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGBA")
img.save(sys.argv[2], format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY
  echo "  → $ASSETS/icon.ico"
else
  if command -v magick >/dev/null 2>&1; then
    magick "$ASSETS/icon.png" -define icon:auto-resize=256,128,64,48,32,24,16 "$ASSETS/icon.ico"
    echo "  → $ASSETS/icon.ico (ImageMagick)"
  else
    echo "  WARN: Python PIL/ImageMagick unavailable — skipping icon.ico (electron-builder will convert icon.png)" >&2
  fi
fi

echo "done."
