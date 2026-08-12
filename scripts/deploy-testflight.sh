#!/bin/bash
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Keep the Apple Watch companion target present in the committed iOS project.
# The phone bridge is injected by Expo prebuild; this target is what makes the
# real paired watch app install alongside the iPhone app.
node "$ROOT/scripts/add-watch-ios-target.js"

# Same deal for the Live Activity widget extension: it is what puts Yaver on the
# CarPlay Dashboard (and the Lock Screen / Dynamic Island / Watch Smart Stack).
# Idempotent — a no-op when the target is already in the committed pbxproj.
node "$ROOT/scripts/add-liveactivity-ios-target.js"

# Embedded-target version guard (2026-08-12 snowball): the two target-injection
# scripts used to rewrite MARKETING_VERSION/CURRENT_PROJECT_VERSION to their
# 1.0.0 scaffold defaults on EVERY run, clobbering the committed 1.18.167 in
# the working tree. The archive then shipped a watch/Live-Activity extension
# versioned 1.0.0 under an app versioned 1.18.167 — and nothing in the deploy
# pipeline said a word. The scripts are fixed to preserve committed versions,
# but a future regression must not ship silently: fail fast when ANY
# MARKETING_VERSION in the pbxproj differs from the app target's, naming the
# fix. This is a version-alignment check, not a store rule.
MARKETING_VERSIONS="$(grep -E '^\s*MARKETING_VERSION = ' "$ROOT/mobile/ios/Yaver.xcodeproj/project.pbxproj" \
  | sed -E 's/.*MARKETING_VERSION = ([^;]+);.*/\1/' | tr -d ' ' | sort -u)"
if [ "$(printf '%s\n' "$MARKETING_VERSIONS" | wc -l | tr -d ' ')" -ne 1 ]; then
  echo "ERROR: embedded-target version drift in project.pbxproj:" >&2
  echo "  $(printf '%s\n' "$MARKETING_VERSIONS" | tr '\n' ' ')" >&2
  echo "  The watch / Live Activity targets must match the app's MARKETING_VERSION." >&2
  echo "  Fix: scripts/add-watch-ios-target.js and add-liveactivity-ios-target.js" >&2
  echo "  must preserve committed versions (they do as of 2026-08-12); restore the" >&2
  echo "  committed pbxproj if a stale script run clobbered it." >&2
  exit 1
fi

cd "$ROOT/mobile/ios"

hydrate_native_dependency_artifacts() {
  local sqlite_dir="$ROOT/mobile/node_modules/expo-sqlite"
  if [ -d "$sqlite_dir/ios" ]; then
    for file in sqlite3.c sqlite3.h; do
      if [ ! -f "$sqlite_dir/ios/$file" ] && [ -f "$sqlite_dir/vendor/sqlite3/$file" ]; then
        echo "Hydrating ExpoSQLite iOS artifact: $file"
        cp "$sqlite_dir/vendor/sqlite3/$file" "$sqlite_dir/ios/$file"
      fi
    done
  fi

  local audio_dir="$ROOT/mobile/node_modules/react-native-audio-api"
  local audio_external="$audio_dir/common/cpp/audioapi/external"
  if [ -d "$audio_dir" ] && [ ! -d "$audio_external/ffmpeg_ios" ]; then
    if [ -x "$audio_dir/scripts/download-prebuilt-binaries.sh" ]; then
      echo "Hydrating RNAudioAPI prebuilt binaries"
      (cd "$audio_dir" && ./scripts/download-prebuilt-binaries.sh)
    else
      echo "ERROR: RNAudioAPI prebuilt binaries are missing and download-prebuilt-binaries.sh is unavailable." >&2
      exit 1
    fi
  fi

  local missing=0
  for path in \
    "$sqlite_dir/ios/sqlite3.c" \
    "$sqlite_dir/ios/sqlite3.h" \
    "$audio_external/ffmpeg_ios" \
    "$audio_external/iphoneos" \
    "$audio_external/iphonesimulator"; do
    if [ ! -e "$path" ]; then
      echo "ERROR: required native deploy artifact missing: $path" >&2
      missing=1
    fi
  done
  [ "$missing" = 0 ] || exit 1
}

hydrate_native_dependency_artifacts

# Load secrets from the Yaver vault (project="mobile" + globals). Vault
# values win when present; values not in the vault fall through from the
# parent env. Locally: `yaver vault add APP_STORE_KEY_PATH --project mobile`.
# In CI: just don't put the secret in the vault — GitHub Actions env vars
# pass through unchanged.

# App Store Connect credentials. `~/.appstoreconnect/yaver.env` is gitignored
# and pre-seeded with all four exports (see CLAUDE.md "iOS — TestFlight"); in
# CI they arrive as GitHub secrets in the parent env.
#
# This used to be a fallback behind `yaver vault env`. It is now the source.
# The vault call swallowed its own failure, so a locked vault died further down
# at the APP_STORE_KEY_PATH:? guard reading "secret not set" — naming the wrong
# cause, non-interactively, with no chance to supply a passphrase.
if [ -f "$HOME/.appstoreconnect/yaver.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "$HOME/.appstoreconnect/yaver.env"; set +a
fi

# macOS login-password secret for headless login.keychain-db unlocks (the
# single-keychain layout). Owner-only, gitignored, never in CI — the same
# file runner_auth.go reads for the Claude-Code keychain. Sourced here so the
# login-keychain unlock block below can see it without the operator exporting
# it by hand on every deploy.
if [ -f "$HOME/.yaver/local-secrets.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "$HOME/.yaver/local-secrets.env"; set +a
fi

# Headless codesigning: unlock the signing keychain in THIS process.
#
# Why this exists: on a remote/SSH deploy (the Mac mini worker), codesign dies
# with the useless error `errSecInternalComponent` even though
# `security find-identity` happily lists the Distribution cert. Three separate
# things cause it, and you have to fix all three:
#   1. The identity lives in a keychain that is LOCKED. find-identity reads the
#      certificate (public) fine, so it looks healthy — only the private-key
#      access fails. The error names none of this.
#   2. A keychain unlock does NOT reliably survive across SSH invocations, so
#      unlocking in an earlier command and signing in a later one still fails.
#      The unlock has to happen in the same run as the build — i.e. right here.
#   3. Even unlocked, the private key's ACL blocks non-GUI callers unless
#      `set-key-partition-list` has granted `codesign:` access (done once, at
#      keychain-provisioning time).
#
# The GUI-session workarounds people reach for first do not work headlessly:
# `launchctl asuser` needs root, and the login password does not help when the
# cert sits in a *different* keychain with its own password.
#
# Set YAVER_SIGNING_KEYCHAIN (+ _PASSWORD) via the Yaver vault or the gitignored
# ~/.appstoreconnect/yaver.env. Unset = no-op, so local GUI deploys, where the
# login keychain is already unlocked, behave exactly as before.
if [ -n "${YAVER_SIGNING_KEYCHAIN:-}" ]; then
  echo "Unlocking signing keychain: $YAVER_SIGNING_KEYCHAIN"
  if ! security unlock-keychain -p "${YAVER_SIGNING_KEYCHAIN_PASSWORD:?YAVER_SIGNING_KEYCHAIN set but YAVER_SIGNING_KEYCHAIN_PASSWORD is not}" "$YAVER_SIGNING_KEYCHAIN"; then
    echo "ERROR: could not unlock $YAVER_SIGNING_KEYCHAIN — codesign would fail later with the opaque 'errSecInternalComponent'." >&2
    exit 1
  fi
  # Search it first so xcodebuild resolves the Distribution identity from the
  # keychain we just unlocked, not from some other (locked) one that happens to
  # hold the same cert — that shadowing is failure mode #1 above.
  security list-keychains -d user -s "$YAVER_SIGNING_KEYCHAIN" login.keychain
  # No lock-on-sleep: a mini that naps mid-archive must not relock and fail the
  # export an hour into the build.
  security set-keychain-settings -t 100000 -u "$YAVER_SIGNING_KEYCHAIN" || true
fi

# Single-keychain machines (MacBook Air / laptop): the signing identities live
# in login.keychain-db, not a dedicated yaver-ci.keychain-db. In a headless
# (SSH / agent / launchd-Background) session that keychain is LOCKED and
# codesign dies with errSecInternalComponent exactly like a missing key.
# `security find-identity` still lists the certs, so the failure looks like a
# missing cert. Unlock + partition-list in THIS process using the macOS login
# password from ~/.yaver/local-secrets.env (YAVER_LOGIN_PASSWORD, chmod 600,
# owner-only) or the parent env. Same three moves as the Claude-Code keychain
# unlock in runner_auth.go. Unset = no-op (GUI session already has it open).
# Found 2026-08-12: the deploy script only unlocked YAVER_SIGNING_KEYCHAIN, so
# a single-keychain box could never self-unlock headlessly.
LOGIN_KC="${YAVER_LOGIN_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
if [ -n "${YAVER_LOGIN_PASSWORD:-}" ]; then
  if [ -f "$LOGIN_KC" ]; then
    echo "Unlocking login keychain (headless codesign): $LOGIN_KC"
    security unlock-keychain -p "$YAVER_LOGIN_PASSWORD" "$LOGIN_KC"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$YAVER_LOGIN_PASSWORD" "$LOGIN_KC" || true
    security set-keychain-settings -t 100000 -u "$LOGIN_KC" || true
  else
    echo "WARN: YAVER_LOGIN_PASSWORD set but login keychain not found at $LOGIN_KC" >&2
  fi
fi

# App Store Connect API key — set these env vars or in the Yaver vault.
AUTH_KEY="${APP_STORE_KEY_PATH:?APP_STORE_KEY_PATH unset. Likely cause: the Yaver vault is locked (auth token rotated >1x). Recover with ANY of: (1) pre-seed ~/.appstoreconnect/yaver.env (gitignored, 4 exports — see CLAUDE.md \"iOS — TestFlight\"); (2) YAVER_VAULT_PASSPHRASE=<old-token> before deploy; (3) re-add: yaver vault add APP_STORE_KEY_PATH --project mobile --value ...}"
AUTH_KEY_ID="${APP_STORE_KEY_ID:?Set APP_STORE_KEY_ID (env or yaver vault)}"
AUTH_KEY_ISSUER="${APP_STORE_KEY_ISSUER:?Set APP_STORE_KEY_ISSUER (env or yaver vault)}"

# Deploy lease (AUTORUN_STORE.md §6.1) — refuse if a sibling autorun is already
# deploying TestFlight, so two runs can't race the same archive/upload and burn
# the ~18/day cap (the 2026-07-19 incident this store exists to prevent). Also
# refuses when the daily quota is exhausted. Best-effort: skipped if the yaver
# CLI isn't on PATH. Stable id across acquire/release = this script's pid.
DEPLOY_ID="deploy-testflight-$$"
LEASE_HELD=0
DEPLOY_OUTCOME=failure
run_yaver_bounded() {
  local label="$1"; shift
  local limit="${YAVER_DEPLOY_LEASE_TIMEOUT_SECONDS:-20}"
  local log="/tmp/yaver-${label}-${DEPLOY_ID}.log"
  yaver "$@" >"$log" 2>&1 &
  local pid=$!
  local start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - start)) -ge "$limit" ]; then
      echo "WARN: yaver $label timed out after ${limit}s; continuing without blocking deploy teardown." >&2
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
  done
  wait "$pid"
}
if command -v yaver >/dev/null 2>&1; then
  BR="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if run_yaver_bounded deploy-lease-acquire autorun deploy-lease acquire --target testflight --autorun "$DEPLOY_ID" --workdir "$ROOT" --branch "$BR"; then
    LEASE_HELD=1
  else
    rc=$?
    [ "$rc" -eq 3 ] && { echo "Another autorun holds the TestFlight deploy lease — aborting to avoid a race."; exit 3; }
    [ "$rc" -eq 4 ] && { echo "TestFlight daily upload quota exhausted — wait a day."; exit 4; }
    echo "WARN: could not acquire deploy lease (rc=$rc) — continuing without coordination."
  fi
fi
release_lease() {
  [ "$LEASE_HELD" = 1 ] && command -v yaver >/dev/null 2>&1 && \
    run_yaver_bounded deploy-lease-release autorun deploy-lease release --target testflight --autorun "$DEPLOY_ID" --outcome "$DEPLOY_OUTCOME" || true
}
trap release_lease EXIT

# Bump build number.
#
# BUG FIX (2026-07-19): this used to bump from the LOCAL Info.plist only. The
# local number drifts from reality — three autorun clones on one box sat at 445,
# 446, 447 while App Store Connect already had all of 441–447 from a prior day —
# so every upload collided (ITMS "build number already used") and burned a slot
# of the ~18/day TestFlight cap. Bump from max(local, ASC-highest) + 1 so a new
# build can never collide. The ASC query is best-effort: if the crypto libs or
# network aren't there, fall back to local+1 and warn (the export-error handler
# below now surfaces a collision clearly either way).
PLIST="Yaver/Info.plist"
CURRENT_BUILD=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$PLIST")

# This box has SEVERAL python3s (/usr/local, /opt/homebrew, Xcode's), and which
# one answers `python3` depends on PATH order — the same trap mini-deploy.sh
# already pins around for google-auth. On 2026-07-20 the one that answered here
# had no PyJWT, so the ASC lookup returned nothing on every run, the build was
# bumped from local 450 while ASC held 451, and the collision retry burned a slot
# of the ~15-20/day cap. Pick an interpreter that can actually do the query
# rather than the one that happens to be first.
ASC_PY=""
for cand in "${YAVER_PYTHON:-}" python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import jwt, requests' >/dev/null 2>&1; then
    ASC_PY="$cand"; break
  fi
done
if [ -z "$ASC_PY" ]; then
  echo "WARN: no python3 here can import PyJWT+requests, so the App Store Connect"
  echo "      build-number lookup CANNOT run. Bumping from the local plist, which"
  echo "      collides (and burns an upload slot) whenever ASC is ahead of it."
  echo "      Fix: $(command -v python3 || echo python3) -m pip install --break-system-packages PyJWT cryptography requests"
  ASC_MAX=""
else
  # stderr is NOT swallowed: asc-max-build.py explains every degraded lookup
  # there, and hiding that is what let this fail silently for a whole day.
  ASC_MAX=$(APP_STORE_KEY_PATH="$AUTH_KEY" APP_STORE_KEY_ID="$AUTH_KEY_ID" APP_STORE_KEY_ISSUER="$AUTH_KEY_ISSUER" \
    "$ASC_PY" "$ROOT/scripts/asc-max-build.py" || echo "")
fi

if [ -n "$ASC_MAX" ] && [ "$ASC_MAX" -ge "$CURRENT_BUILD" ] 2>/dev/null; then
  echo "ASC highest build is $ASC_MAX (local $CURRENT_BUILD) — bumping from max"
  NEW_BUILD=$((ASC_MAX + 1))
else
  [ -n "$ASC_PY" ] && [ -z "$ASC_MAX" ] && \
    echo "WARN: ASC max build unreadable (reason above) — bumping from local $CURRENT_BUILD"
  NEW_BUILD=$((CURRENT_BUILD + 1))
fi
# PlistBuddy rewrites the whole plist and DROPS XML COMMENTS. Info.plist
# carries a long comment explaining why NSAllowsArbitraryLoads is set (the
# 100.64/10 CGNAT range that NSAllowsLocalNetworking does not exempt) — that
# reasoning was being silently deleted on every single deploy. Patch the one
# value as text instead so the documentation survives.
python3 - "$PLIST" "$NEW_BUILD" <<'PYEOF'
import re, sys
path, new_build = sys.argv[1], sys.argv[2]
with open(path) as f:
    s = f.read()
s2 = re.sub(r'(<key>CFBundleVersion</key>\s*\n\s*<string>)[^<]*(</string>)',
            lambda m: m.group(1) + new_build + m.group(2), s, count=1)
if s2 == s:
    sys.exit("deploy-testflight: could not patch CFBundleVersion in " + path)
with open(path, "w") as f:
    f.write(s2)
PYEOF
echo "Build $CURRENT_BUILD → $NEW_BUILD"
# Record the real build number in the lease (same id re-acquires + overwrites).
[ "$LEASE_HELD" = 1 ] && command -v yaver >/dev/null 2>&1 && \
  run_yaver_bounded deploy-lease-build autorun deploy-lease acquire --target testflight --autorun "$DEPLOY_ID" --workdir "$ROOT" --build "$NEW_BUILD" || true

# Clean stale archive so a failed build can't silently reuse it
ls -la /tmp/Yaver.xcarchive 2>/dev/null || true
rm -rf /tmp/Yaver.xcarchive

# DERIVED DATA MUST OUTLIVE /tmp (2026-08-02).
#
# This passed `-derivedDataPath /tmp/YaverBuild`. macOS purges /tmp, so the
# incremental build cache was gone by the next deploy and EVERY archive was a
# cold build: measured at 2,270 compiled files, 5.8 GB of build products, and
# ~45 minutes of wall clock for a change that touched a handful of TS files.
# The script was already the incremental path in every other respect — no
# `clean`, no `prebuild` — so the one flag was the whole cost.
#
# ~/.yaver/build/ios persists, is owner-only, and is outside the repo so it
# can never be swept by a `git clean`. Override with YAVER_IOS_DERIVED_DATA if
# a run genuinely wants a throwaway cache (a signing-cache bisect, say).
DERIVED="${YAVER_IOS_DERIVED_DATA:-$HOME/.yaver/build/ios}"
mkdir -p "$DERIVED"
CACHE_STATE="warm"
[ -d "$DERIVED/Build" ] || CACHE_STATE="COLD (first archive here — expect the slow one)"

# Archive.
#
# Do not pipe xcodebuild through tee/tail here. On 2026-08-09 a TestFlight
# deploy spent hours alive but silent inside Xcode's build-log machinery after
# `xcodebuild | tee /tmp/arch_full.log | tail -3`; the terminal looked quiet,
# the archive never materialized, and the EXIT trap then hung trying to release
# the lease. Write directly to the log, print bounded heartbeats, and fail
# loudly when the log stops moving.
echo "Archiving... (derived data: $DERIVED — $CACHE_STATE)"
ARCHIVE_LOG=/tmp/arch_full.log
: > "$ARCHIVE_LOG"
xcodebuild -workspace Yaver.xcworkspace -scheme Yaver -configuration Release \
  -archivePath /tmp/Yaver.xcarchive archive \
  DEVELOPMENT_TEAM="${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}" CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION=YES \
  ENABLE_USER_SCRIPT_SANDBOXING=NO -allowProvisioningUpdates \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_KEY_ISSUER" \
  -derivedDataPath "$DERIVED" >"$ARCHIVE_LOG" 2>&1 &
ARCHIVE_PID=$!
ARCHIVE_STARTED=$SECONDS
ARCHIVE_LAST_SIZE=0
ARCHIVE_LAST_PROGRESS=$SECONDS
ARCHIVE_SILENCE_LIMIT="${YAVER_IOS_ARCHIVE_SILENCE_TIMEOUT_SECONDS:-900}"
while kill -0 "$ARCHIVE_PID" 2>/dev/null; do
  sleep 30
  ARCHIVE_SIZE=$(stat -f%z "$ARCHIVE_LOG" 2>/dev/null || echo 0)
  if [ "$ARCHIVE_SIZE" != "$ARCHIVE_LAST_SIZE" ]; then
    ARCHIVE_LAST_SIZE="$ARCHIVE_SIZE"
    ARCHIVE_LAST_PROGRESS=$SECONDS
    echo "Archive still running ($((SECONDS - ARCHIVE_STARTED))s, log ${ARCHIVE_SIZE} bytes). Last lines:"
    tail -3 "$ARCHIVE_LOG" || true
  elif [ $((SECONDS - ARCHIVE_LAST_PROGRESS)) -ge "$ARCHIVE_SILENCE_LIMIT" ]; then
    echo "ERROR: xcodebuild archive produced no log output for ${ARCHIVE_SILENCE_LIMIT}s." >&2
    echo "       This usually means Xcode/SwiftBuild is wedged, not that compilation is progressing." >&2
    echo "       Last archive log lines:" >&2
    tail -20 "$ARCHIVE_LOG" >&2 || true
    kill -TERM "$ARCHIVE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$ARCHIVE_PID" 2>/dev/null || true
    wait "$ARCHIVE_PID" 2>/dev/null || true
    exit 1
  else
    echo "Archive still running ($((SECONDS - ARCHIVE_STARTED))s, no new log for $((SECONDS - ARCHIVE_LAST_PROGRESS))s)."
  fi
done
set +e
wait "$ARCHIVE_PID"
ARCHIVE_EXIT=$?
set -e
if [ "$ARCHIVE_EXIT" -ne 0 ]; then
  echo "ERROR: Archive failed (exit $ARCHIVE_EXIT). Last archive log lines:" >&2
  tail -40 "$ARCHIVE_LOG" >&2 || true
  exit "$ARCHIVE_EXIT"
fi

# Verify archive was created
if [ ! -d /tmp/Yaver.xcarchive ]; then
  echo "ERROR: Archive failed — no .xcarchive produced"
  exit 1
fi

# ExportOptions (no single-quote on EOF so APPLE_TEAM_ID expands)
# uploadSymbols=false: rnwhisper framework has missing dSYMs that
# Xcode 15+ treats as a fatal export error. Crash reports still work
# from Apple's symbolication — we just skip uploading our local dSYMs.
cat > /tmp/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>${APPLE_TEAM_ID}</string>
    <key>signingStyle</key><string>automatic</string>
    <key>destination</key><string>upload</string>
    <key>uploadSymbols</key><false/>
</dict>
</plist>
EOF

# Export & upload (destination=upload sends directly to App Store Connect).
#
# BUG FIX (2026-07-19): this used to be `EXPORT_OUTPUT=$(xcodebuild …)`. Under
# `set -eo pipefail` (line 2), a FAILED command substitution aborts the script
# AT that assignment — so the diagnostic below and the "Redundant Binary Upload"
# tolerance were unreachable dead code, and every real failure surfaced as a
# bare `exit 70/65` with no message. That masked a full day of debugging (the
# actual cause was a build-number collision + a locked signing keychain).
# Stream to a log with `set +e` so the exit code is captured AND the error is
# visible.
echo "Exporting & uploading..."
EXPORT_LOG=/tmp/yaver_export.log
set +e
xcodebuild -exportArchive -archivePath /tmp/Yaver.xcarchive \
  -exportOptionsPlist /tmp/ExportOptions.plist \
  -exportPath /tmp/YaverExport -allowProvisioningUpdates \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_KEY_ISSUER" 2>&1 | tee "$EXPORT_LOG"
EXPORT_EXIT=${PIPESTATUS[0]}
set -e

# Success = exit 0, OR "Redundant Binary" (build already uploaded — treat as ok).
if [ "$EXPORT_EXIT" -ne 0 ] && ! grep -q "Redundant Binary Upload" "$EXPORT_LOG"; then
  echo "ERROR: Export/upload failed (exit $EXPORT_EXIT). Diagnosis:"
  # Surface the two most common real causes explicitly (learned 2026-07-19):
  if grep -q "errSecInternalComponent" "$EXPORT_LOG"; then
    echo "  → codesign errSecInternalComponent: a signing keychain is LOCKED to this"
    echo "    (headless) session. Unlock BOTH yaver-ci.keychain-db and login.keychain-db"
    echo "    + set-key-partition-list. See CLAUDE.md → 'Headless codesign'."
  fi
  if grep -qiE "bundle version.*already|redundant|The build.*has already been used|ITMS-4238" "$EXPORT_LOG"; then
    echo "  → build number $NEW_BUILD collides with an existing App Store Connect build."
    echo "    Bump CFBundleVersion above the ASC max and retry."
  fi
  grep -iE "error|errSec|EXPORT FAILED|ITMS-" "$EXPORT_LOG" | tail -8
  exit 1
fi

DEPLOY_OUTCOME=success   # the trap releases the lease with this outcome + quota++
echo "✓ TestFlight build $NEW_BUILD uploaded"

mobile-cache-cleanup.sh mark-deployed yaver || true
