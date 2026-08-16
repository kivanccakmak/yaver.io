#!/bin/bash
set -euo pipefail

# Build the sandboxed Mac App Store variant of Yaver Desktop and optionally
# upload it to the macOS TestFlight train. The direct DMG is intentionally a
# different product lane: it embeds the Go agent; this MAS package does not.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_DIR="$ROOT/electron"
UPLOAD=0
DEV_BUILD=0

usage() {
  cat <<'EOF'
Usage: scripts/deploy-macos-testflight.sh [--upload] [--mas-dev]

  (no flag)  Build and locally verify the signed MAS .pkg; no external upload.
  --upload   Validate and upload the .pkg to App Store Connect / macOS TestFlight.
  --mas-dev  Build a locally runnable sandboxed development variant (no upload).

Required for MAS distribution:
  YAVER_MAS_PROVISIONING_PROFILE       io.yaver.gui App Store profile path
  Mac App Distribution identity        installed, or CSC_LINK + CSC_KEY_PASSWORD
  Mac Installer Distribution identity  installed, or CSC_INSTALLER_LINK +
                                       CSC_INSTALLER_KEY_PASSWORD

Also required for --upload:
  APP_STORE_KEY_PATH, APP_STORE_KEY_ID, APP_STORE_KEY_ISSUER

Use the canonical entrypoint: ./deploy/deploy.sh desktop-mas (build only) or,
after explicit release approval, ./deploy/deploy.sh desktop-testflight.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --upload) UPLOAD=1 ;;
    --mas-dev) DEV_BUILD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ERROR: unknown option '$1'." >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: macOS TestFlight packaging requires a Mac with full Xcode." >&2
  exit 2
fi
for tool in node npm xcrun codesign pkgutil plutil security; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is missing." >&2
    exit 2
  fi
done
XCODEBUILD_PATH="$(xcrun -find xcodebuild 2>/dev/null || true)"
if [ -z "$XCODEBUILD_PATH" ] || [[ "$XCODEBUILD_PATH" != *"/Xcode.app/"* ]]; then
  echo "ERROR: full Xcode is not selected. Fix: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 2
fi

if [ -f "$HOME/.appstoreconnect/yaver.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.appstoreconnect/yaver.env"
  set +a
fi

PROFILE_VAR="YAVER_MAS_PROVISIONING_PROFILE"
if [ "$DEV_BUILD" = "1" ]; then
  PROFILE_VAR="YAVER_MAS_DEV_PROVISIONING_PROFILE"
fi
PROFILE_PATH="${!PROFILE_VAR:-}"
if [ -z "$PROFILE_PATH" ] || [ ! -f "$PROFILE_PATH" ]; then
  echo "ERROR: $PROFILE_VAR must point to an existing io.yaver.gui provisioning profile." >&2
  echo "Create/download it in Apple Developer Certificates, Identifiers & Profiles, then retry." >&2
  exit 2
fi

# Decode the profile without touching the login keychain. This catches the
# expensive false-green where a profile file exists but belongs to another app
# or lacks App Sandbox; electron-builder would otherwise fail much later.
PROFILE_PLIST="$(mktemp -t yaver-mas-profile.XXXXXX)"
cleanup() { rm -f "$PROFILE_PLIST"; }
trap cleanup EXIT
if ! security cms -D -i "$PROFILE_PATH" > "$PROFILE_PLIST" 2>/dev/null; then
  echo "ERROR: $PROFILE_VAR is not a readable Apple provisioning profile." >&2
  exit 2
fi
PROFILE_APP_ID="$(plutil -extract Entitlements.application-identifier raw -o - "$PROFILE_PLIST" 2>/dev/null || true)"
PROFILE_SANDBOX="$(plutil -extract Entitlements.com.apple.security.app-sandbox raw -o - "$PROFILE_PLIST" 2>/dev/null || true)"
if [[ "$PROFILE_APP_ID" != *".io.yaver.gui" ]]; then
  echo "ERROR: provisioning profile application-identifier does not end in .io.yaver.gui." >&2
  exit 2
fi
if [ "$PROFILE_SANDBOX" != "true" ] && [ "$PROFILE_SANDBOX" != "1" ]; then
  echo "ERROR: provisioning profile does not grant com.apple.security.app-sandbox." >&2
  exit 2
fi

if [ "$UPLOAD" = "1" ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "ERROR: macOS TestFlight upload requires a clean committed worktree." >&2
    exit 2
  fi
  if [ "$(git -C "$ROOT" branch --show-current)" != "main" ]; then
    echo "ERROR: macOS TestFlight upload must run from reviewed main." >&2
    exit 2
  fi
  : "${APP_STORE_KEY_PATH:?Set APP_STORE_KEY_PATH to the App Store Connect .p8 key}"
  : "${APP_STORE_KEY_ID:?Set APP_STORE_KEY_ID}"
  : "${APP_STORE_KEY_ISSUER:?Set APP_STORE_KEY_ISSUER}"
  if [ ! -f "$APP_STORE_KEY_PATH" ]; then
    echo "ERROR: APP_STORE_KEY_PATH does not name an existing .p8 file." >&2
    exit 2
  fi
fi

# A sortable UTC timestamp is valid CFBundleVersion syntax and avoids reusing
# a local package build number. An operator can pin an ASC-derived value.
YAVER_MAC_BUILD_NUMBER="${YAVER_MAC_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
export YAVER_MAC_BUILD_NUMBER
export "$PROFILE_VAR=$PROFILE_PATH"

BUILD_LABEL="App Store"
if [ "$DEV_BUILD" = "1" ]; then
  BUILD_LABEL="sandbox development"
fi
echo "Building Yaver macOS ${BUILD_LABEL} package ${YAVER_MAC_BUILD_NUMBER} (client-only; embedded agent excluded)…"
(cd "$ELECTRON_DIR" && npm ci)
if [ "$DEV_BUILD" = "1" ]; then
  (cd "$ELECTRON_DIR" && npm run dist:mas-dev)
else
  (cd "$ELECTRON_DIR" && npm run dist:mas)
fi

APP_PATH="$(find "$ELECTRON_DIR/dist-mas" -type d -name 'Yaver.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: electron-builder reported success but no Yaver.app exists under electron/dist-mas." >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
if [ -e "$APP_PATH/Contents/Resources/bin/yaver" ] || [ -e "$APP_PATH/Contents/Resources/bin/yaver.exe" ]; then
  echo "ERROR: MAS package contains the embedded agent; refusing a dishonest sandboxed build." >&2
  exit 1
fi
SIGNED_ENTITLEMENTS="$(codesign -d --entitlements :- "$APP_PATH" 2>/dev/null || true)"
if [[ "$SIGNED_ENTITLEMENTS" != *"com.apple.security.app-sandbox"* ]]; then
  echo "ERROR: signed app lacks the mandatory App Sandbox entitlement." >&2
  exit 1
fi

if [ "$DEV_BUILD" = "1" ]; then
  echo "Verified local MAS development app: $APP_PATH"
  exit 0
fi

PKG_PATH="$(find "$ELECTRON_DIR/dist-mas" -maxdepth 2 -type f -name '*.pkg' -print -quit)"
if [ -z "$PKG_PATH" ]; then
  echo "ERROR: no signed App Store .pkg was produced under electron/dist-mas." >&2
  exit 1
fi
pkgutil --check-signature "$PKG_PATH"
echo "Verified App Store package: $PKG_PATH"

if [ "$UPLOAD" != "1" ]; then
  echo "Build-only complete. No App Store Connect state was changed."
  exit 0
fi

# altool finds API keys by filename in ./private_keys. Use an owner-only temp
# directory instead of copying secrets into the repo or permanently mutating
# ~/.appstoreconnect.
UPLOAD_AUTH_DIR="$(mktemp -d -t yaver-asc-upload.XXXXXX)"
chmod 700 "$UPLOAD_AUTH_DIR"
mkdir -m 700 "$UPLOAD_AUTH_DIR/private_keys"
cp "$APP_STORE_KEY_PATH" "$UPLOAD_AUTH_DIR/private_keys/AuthKey_${APP_STORE_KEY_ID}.p8"
chmod 600 "$UPLOAD_AUTH_DIR/private_keys/AuthKey_${APP_STORE_KEY_ID}.p8"
cleanup_upload() { rm -f "$UPLOAD_AUTH_DIR/private_keys/AuthKey_${APP_STORE_KEY_ID}.p8"; rmdir "$UPLOAD_AUTH_DIR/private_keys" "$UPLOAD_AUTH_DIR" 2>/dev/null || true; }
trap 'cleanup_upload; cleanup' EXIT

echo "Validating package with App Store Connect…"
(cd "$UPLOAD_AUTH_DIR" && xcrun altool --validate-app --file "$PKG_PATH" --type macos \
  --apiKey "$APP_STORE_KEY_ID" --apiIssuer "$APP_STORE_KEY_ISSUER")
echo "Uploading package to macOS TestFlight…"
(cd "$UPLOAD_AUTH_DIR" && xcrun altool --upload-app --file "$PKG_PATH" --type macos \
  --apiKey "$APP_STORE_KEY_ID" --apiIssuer "$APP_STORE_KEY_ISSUER")
echo "Upload accepted. App Store Connect will process build $YAVER_MAC_BUILD_NUMBER before it appears in TestFlight."
