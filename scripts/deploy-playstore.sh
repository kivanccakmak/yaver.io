#!/bin/bash
set -e

cd "$(dirname "$0")/../mobile/android"

# `expo prebuild --clean` regenerates gradle.properties from Expo's
# template, wiping any heap bump we made by hand. Without an 8g heap
# the dex merge step OOMs ~9 min into bundleRelease. Force the bump
# both as an env var (so this run is safe even if gradle.properties
# stayed default) and back into gradle.properties (so subsequent
# `gradle` invocations from outside this script also see it).
export GRADLE_OPTS="${GRADLE_OPTS:-} -Xmx8g -XX:MaxMetaspaceSize=1g"
if grep -q '^org.gradle.jvmargs=' gradle.properties 2>/dev/null; then
  if ! grep -qE '^org\.gradle\.jvmargs=.*-Xmx(8|16|32)g' gradle.properties; then
    sed -i.bak 's/^org\.gradle\.jvmargs=.*/org.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError/' gradle.properties
    rm -f gradle.properties.bak
    echo "Bumped gradle.properties JVM heap to 8g."
  fi
fi

# Pull Android signing creds + Play service account path from the Yaver
# vault (project="mobile" + globals). Vault values win when present;
# values that don't exist in the vault pass through from the parent env.
# CI workflows that rely on GitHub-secret env vars just don't store them
# in the vault (or run against a host that has no vault).
if command -v yaver >/dev/null 2>&1; then
  eval "$(yaver vault env --project mobile 2>/dev/null || true)"
fi

# Vault-locked fallback (mirrors deploy-testflight.sh's
# ~/.appstoreconnect/yaver.env and deploy-web.sh's auto-source). After the
# auth token rotates >1x, `yaver vault env` returns "wrong passphrase or
# corrupted vault"; `yaver deploy all` runs this non-interactively so
# YAVER_VAULT_PASSPHRASE can't be supplied. ~/.androidplay/yaver.env is
# gitignored — pre-seed it with the Play exports the build/upload need
# (PLAY_STORE_KEY_FILE, ANDROID_RELEASE_SHA256, any keystore overrides).
# Vault values still win when readable; this only fills the gap.
if [ -f "$HOME/.androidplay/yaver.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "$HOME/.androidplay/yaver.env"; set +a
fi

REPO_ROOT="$(cd ../.. && pwd)"
if [ ! -f "keystore.properties" ] || [ ! -f "$REPO_ROOT/keys/yaver-upload.keystore" ]; then
  echo "Android release signing material missing; running scripts/bootstrap-android-signing.sh..."
  if ! (cd "$REPO_ROOT" && ./scripts/bootstrap-android-signing.sh); then
    echo "ERROR: Android release signing material is missing and bootstrap failed." >&2
    echo "Expected $REPO_ROOT/keys/yaver-upload.keystore and mobile/android/keystore.properties before building." >&2
    exit 1
  fi
fi

STORE_FILE=$(awk -F= '/^storeFile=/ {print substr($0, index($0, "=") + 1)}' keystore.properties | tail -1)
STORE_PASSWORD=$(awk -F= '/^storePassword=/ {print substr($0, index($0, "=") + 1)}' keystore.properties | tail -1)
if [ -z "$STORE_FILE" ] || [ -z "$STORE_PASSWORD" ]; then
  echo "ERROR: mobile/android/keystore.properties is missing storeFile or storePassword." >&2
  exit 1
fi
case "$STORE_FILE" in
  /*) KEYSTORE_FILE="$STORE_FILE" ;;
  *) KEYSTORE_FILE="$(cd app && pwd)/$STORE_FILE" ;;
esac
if [ ! -f "$KEYSTORE_FILE" ]; then
  echo "ERROR: Android release keystore file not found at $KEYSTORE_FILE." >&2
  echo "Run ./scripts/bootstrap-android-signing.sh or restore the local gitignored keys/yaver-upload.keystore file." >&2
  exit 1
fi
if command -v keytool >/dev/null 2>&1; then
  if ! keytool -list -keystore "$KEYSTORE_FILE" -storepass "$STORE_PASSWORD" >/dev/null 2>&1; then
    echo "ERROR: Android release keystore exists but keytool cannot open it with keystore.properties." >&2
    echo "Re-run ./scripts/bootstrap-android-signing.sh so the keystore and passwords come from the same vault snapshot." >&2
    exit 1
  fi
fi

if [ -x "./gradlew" ]; then
  GRADLE="./gradlew"
elif command -v gradle >/dev/null 2>&1; then
  GRADLE="gradle"
else
  echo "ERROR: No Gradle runner found."
  echo "Expected ./mobile/android/gradlew or a global 'gradle' binary."
  exit 1
fi

MIN_FREE_GB="${YAVER_PLAYSTORE_MIN_FREE_GB:-16}"
AVAILABLE_KB=$(df -Pk . | awk 'NR==2 {print $4}')
MIN_FREE_KB=$((MIN_FREE_GB * 1024 * 1024))
if [ -n "$AVAILABLE_KB" ] && [ "$AVAILABLE_KB" -lt "$MIN_FREE_KB" ]; then
  AVAILABLE_GB=$((AVAILABLE_KB / 1024 / 1024))
  echo "ERROR: Play deploy needs at least ${MIN_FREE_GB} GiB free on the Android build volume; only ${AVAILABLE_GB} GiB is available." >&2
  echo "Clean generated artifacts (mobile/android/app/build, mobile/android/.gradle, node_modules native .cxx/build outputs, or Gradle caches) or run the Play deploy on CI." >&2
  exit 1
fi

# Bump versionCode
GRADLE_FILE="app/build.gradle"
CURRENT_VERSION_CODE=$(grep 'versionCode ' "$GRADLE_FILE" | head -1 | sed 's/[^0-9]//g')
OVERRIDE_VERSION_CODE="${ANDROID_VERSION_CODE:-}"
REMOTE_MAX_VERSION_CODE=""

if [ -z "$OVERRIDE_VERSION_CODE" ] && [ -n "${PLAY_STORE_KEY_FILE:-}" ] && [ -f "${PLAY_STORE_KEY_FILE}" ]; then
REMOTE_MAX_VERSION_CODE=$(PLAY_STORE_KEY_FILE="$PLAY_STORE_KEY_FILE" python3 - <<'PY'
import os
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

key = os.environ.get("PLAY_STORE_KEY_FILE")
if not key:
    raise SystemExit("")

creds = Credentials.from_service_account_file(
    key,
    scopes=["https://www.googleapis.com/auth/androidpublisher"],
)
service = build("androidpublisher", "v3", credentials=creds)
edit = service.edits().insert(body={}, packageName="io.yaver.mobile").execute()
edit_id = edit["id"]
try:
    bundles = service.edits().bundles().list(
        packageName="io.yaver.mobile",
        editId=edit_id,
    ).execute().get("bundles", [])
    max_version = max((int(bundle["versionCode"]) for bundle in bundles), default=0)
    print(max_version)
finally:
    service.edits().delete(packageName="io.yaver.mobile", editId=edit_id).execute()
PY
)
fi

if [ -n "$OVERRIDE_VERSION_CODE" ]; then
NEW_VERSION_CODE="$OVERRIDE_VERSION_CODE"
elif [ -n "$REMOTE_MAX_VERSION_CODE" ] && [ "$REMOTE_MAX_VERSION_CODE" -ge "$CURRENT_VERSION_CODE" ]; then
NEW_VERSION_CODE=$((REMOTE_MAX_VERSION_CODE + 1))
else
NEW_VERSION_CODE=$((CURRENT_VERSION_CODE + 1))
fi
sed -i '' "s/versionCode $CURRENT_VERSION_CODE/versionCode $NEW_VERSION_CODE/" "$GRADLE_FILE"
echo "versionCode $CURRENT_VERSION_CODE -> $NEW_VERSION_CODE"

# On-device sandbox payload: cross-compile the Go agent (+ proot when a source is
# configured) into jniLibs so the shipped AAB can host the phone-as-Linux-box
# (SandboxService → libyaver.so + proot rootfs). Skipped only when explicitly
# opted out or when Go isn't on PATH (a vanilla APK still builds fine; the
# on-device box just stays disabled). proot needs PROOT_SRC or YAVER_PROOT_URL —
# without it the script ships agent-only and says so. cwd is mobile/android here.
if [ "${YAVER_SKIP_SANDBOX:-0}" != "1" ]; then
  if command -v go >/dev/null 2>&1; then
    echo "Building on-device sandbox payload (jniLibs)..."
    if ../../scripts/build-android-sandbox.sh; then
      [ -f "app/src/main/jniLibs/.sandbox-payload.txt" ] && \
        sed 's/^/  sandbox: /' "app/src/main/jniLibs/.sandbox-payload.txt" || true
    else
      echo "WARN: sandbox payload build failed — continuing without on-device agent." >&2
    fi
  else
    echo "WARN: 'go' not found — skipping on-device sandbox payload (set YAVER_SKIP_SANDBOX=1 to silence)." >&2
  fi
fi

# Build release AAB.
# We deliberately do NOT `gradlew clean` here. A clean wipes every
# react-native-<lib>/android/build/generated/source/codegen/jni/
# directory, but the autolinking-generated CMakeLists.txt still
# references all of them at configure time — so the next bundleRelease
# blows up with "add_subdirectory given source ... which is not an
# existing directory" before any codegen task gets a chance to run.
# Letting Gradle do an incremental build keeps the JNI dirs around
# and avoids the chicken-and-egg.
# Build worklets prefab first — reanimated CMake configure depends on it.
echo "Building release AAB..."
"$GRADLE" :react-native-worklets:prefabReleasePackage

# Reanimated 4.x imports libworklets.so from the legacy AGP
# intermediates/cmake/release path, while the current worklets/AGP build emits
# it under intermediates/cxx/RelWithDebInfo/<hash>/obj. Bridge the exact ABI
# files after building worklets so bundleRelease cannot fail later with
# "libworklets.so missing and no known rule to make it".
WORKLETS_ANDROID="../../mobile/node_modules/react-native-worklets/android"
WORKLETS_EXPECTED="$WORKLETS_ANDROID/build/intermediates/cmake/release/obj"
for abi in arm64-v8a armeabi-v7a x86 x86_64; do
  src=$(find "$WORKLETS_ANDROID/build/intermediates/cxx/RelWithDebInfo" -path "*/obj/$abi/libworklets.so" -print -quit 2>/dev/null || true)
  if [ -n "$src" ]; then
    mkdir -p "$WORKLETS_EXPECTED/$abi"
    cp "$src" "$WORKLETS_EXPECTED/$abi/libworklets.so"
  fi
done
if [ ! -f "$WORKLETS_EXPECTED/arm64-v8a/libworklets.so" ]; then
  echo "ERROR: react-native-worklets built no arm64 libworklets.so; cannot build Reanimated release." >&2
  exit 1
fi

"$GRADLE" bundleRelease

AAB_PATH="app/build/outputs/bundle/release/app-release.aab"

if [ ! -f "$AAB_PATH" ]; then
  echo "ERROR: AAB not found at $AAB_PATH"
  exit 1
fi

echo ""
echo "Release AAB built successfully!"
echo "  Path: $(pwd)/$AAB_PATH"
echo "  versionCode: $NEW_VERSION_CODE"
echo ""
echo "Upload to Google Play Console:"
echo "  1. Go to https://play.google.com/console"
echo "  2. Select 'Yaver' app (io.yaver.mobile)"
echo "  3. Go to Testing > Internal testing"
echo "  4. Create new release and upload the AAB"
echo ""
echo "AAB path for upload:"
echo "  $(pwd)/$AAB_PATH"
