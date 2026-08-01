#!/usr/bin/env bash
set -euo pipefail

# Deploy yaver.io web to Cloudflare Workers.
# Builds with @opennextjs/cloudflare and deploys via wrangler.
# Enforces a 15 MB cap on the web/ source tree (excluding
# node_modules, .next, .open-next). Matches the CI guard in
# release-web.yml (raised 10→15 MB in ddd5868d — demo videos push it over).
#
# Credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and
# ANDROID_RELEASE_SHA256 for passkey assetlinks) come from the parent
# environment (GitHub secrets in CI) or from the gitignored env file below.
#
# They deliberately do NOT come from `yaver vault` any more. The vault call
# that used to sit here swallowed its own failure (`|| true`), so a locked or
# lost vault produced no message and the deploy failed later — or worse,
# silently shipped assetlinks.json without ANDROID_RELEASE_SHA256, breaking
# passkey on Play-distributed builds with nothing in the output to say why.
# The env file was already winning anyway: it is sourced after the vault.
#
# A v2 vault is master-key encrypted and unrecoverable if that key is lost, so
# no deploy may depend on it. See the vault audit (2026-08-01).
if [ -f "$HOME/.androidplay/yaver.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "$HOME/.androidplay/yaver.env"; set +a
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/web"
MAX_SIZE_MB=15

# Append the production Play app-signing SHA-256 to assetlinks.json right
# before the build. The dev keystore fingerprint stays in tracked
# assetlinks.json for `yaver wireless push` testing; this step adds the prod
# one without committing it.
#
# This used to be "skipped silently when the vault key is empty" — a deploy that
# succeeds while shipping an assetlinks.json that breaks passkey enrolment on
# every Play-distributed build, with nothing at runtime naming the cause. It is
# now loud, because the credential has exactly one source and a missing one is
# a shipped defect, not a no-op.
ASSETLINKS_PATH="$REPO_ROOT/web/public/.well-known/assetlinks.json"
if [ -f "$ASSETLINKS_PATH" ] && [ -n "${ANDROID_RELEASE_SHA256:-}" ]; then
  if command -v jq >/dev/null 2>&1; then
    SHA="$ANDROID_RELEASE_SHA256"
    TMP="$(mktemp)"
    jq --arg sha "$SHA" '
      (.[0].target.sha256_cert_fingerprints) as $existing
      | if ($existing | index($sha)) then .
        else .[0].target.sha256_cert_fingerprints += [$sha]
        end
    ' "$ASSETLINKS_PATH" > "$TMP" && mv "$TMP" "$ASSETLINKS_PATH"
    echo "assetlinks.json: production Play SHA-256 merged."
  else
    echo "ERROR: jq not found — cannot merge ANDROID_RELEASE_SHA256 into assetlinks.json." >&2
    echo "       Shipping without it breaks passkey enrolment on Play-distributed builds." >&2
    echo "       Fix: install jq (brew install jq), then re-run." >&2
    exit 1
  fi
elif [ -f "$ASSETLINKS_PATH" ]; then
  echo "ERROR: ANDROID_RELEASE_SHA256 is not set — assetlinks.json would ship WITHOUT the" >&2
  echo "       Play app-signing fingerprint. Passkey enrolment then fails on every" >&2
  echo "       Play-distributed Android build, and nothing at runtime names this cause." >&2
  echo "" >&2
  echo "       Get it: Play Console -> Setup -> App integrity -> App signing key certificate (SHA-256)." >&2
  echo "       Then:   mkdir -p ~/.androidplay" >&2
  echo "               echo 'export ANDROID_RELEASE_SHA256=\"AA:BB:CC:...\"' >> ~/.androidplay/yaver.env" >&2
  echo "" >&2
  echo "       To ship the web app knowingly without Android passkey support, set" >&2
  echo "       YAVER_ALLOW_MISSING_ASSETLINKS_SHA=1 for this run." >&2
  if [ "${YAVER_ALLOW_MISSING_ASSETLINKS_SHA:-}" != "1" ]; then
    exit 1
  fi
  echo "       YAVER_ALLOW_MISSING_ASSETLINKS_SHA=1 set — continuing without it." >&2
fi

# 1. Calculate deployed directory size (excluding node_modules and .next)
SIZE_KB=$(find "$DEPLOY_DIR" \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/.open-next/*' \
  -type f -print0 \
  | xargs -0 stat -f%z 2>/dev/null \
  | awk '{s+=$1} END {printf "%.0f", s/1024}')

# Fallback for Linux
if [ -z "$SIZE_KB" ] || [ "$SIZE_KB" = "0" ]; then
  SIZE_KB=$(du -sk --exclude='node_modules' --exclude='.next' --exclude='.open-next' "$DEPLOY_DIR" 2>/dev/null | awk '{print $1}')
fi

SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $SIZE_KB / 1024}")
echo "Source size (excl build artifacts): ${SIZE_MB} MB"

MAX_SIZE_KB=$((MAX_SIZE_MB * 1024))
if [ "$SIZE_KB" -gt "$MAX_SIZE_KB" ]; then
  echo "ERROR: web/ is ${SIZE_MB} MB — exceeds ${MAX_SIZE_MB} MB limit."
  exit 1
fi

echo "Size OK. Building and deploying to Cloudflare..."

if [ ! -f "$DEPLOY_DIR/node_modules/next/package.json" ]; then
  echo "web dependencies missing — running npm ci before Cloudflare deploy."
  (cd "$DEPLOY_DIR" && npm ci)
fi

# 1b. AASA shadow guard (incident 2026-07-23).
# A physical file at public/.well-known/apple-app-site-association is served by
# Cloudflare's static-assets binding BEFORE the Next rewrite reaches the route
# handler that emits the correct JSON + application/json content-type. When it
# last existed it also nested `webcredentials` inside `applinks`, which broke
# in-app passkey / Face ID sign-in (web was unaffected). The canonical AASA is
# web/app/api/apple-app-site-association/route.ts — never a static file.
SHADOW_AASA="$DEPLOY_DIR/public/.well-known/apple-app-site-association"
if [ -e "$SHADOW_AASA" ]; then
  echo "ERROR: $SHADOW_AASA exists — it shadows the AASA route handler and breaks"
  echo "       in-app passkey / Sign in with Apple. Delete it; the route serves the AASA."
  exit 1
fi

# 2. Build and deploy
#
# Stamp the build with the git SHA being deployed. Without this the dashboard
# can only show web/package.json's hand-maintained semver, which does NOT move
# on every deploy — so "the fix was never shipped" and "the fix shipped and your
# tab is cached" render identically and neither the user nor an agent can tell
# them apart. That cost a real debugging round on 2026-07-28. See
# web/lib/buildStamp.ts.
NEXT_PUBLIC_BUILD_ID="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if ! git -C "$REPO_ROOT" diff --quiet HEAD -- "$DEPLOY_DIR" 2>/dev/null; then
  # Say so rather than stamping a SHA that does not describe these bytes.
  NEXT_PUBLIC_BUILD_ID="${NEXT_PUBLIC_BUILD_ID}-dirty"
fi
export NEXT_PUBLIC_BUILD_ID
echo "→ build stamp: $NEXT_PUBLIC_BUILD_ID (shown in the dashboard sidebar)"

cd "$DEPLOY_DIR"
npm run deploy

echo "✓ deployed build $NEXT_PUBLIC_BUILD_ID — the sidebar must show this SHA;"
echo "  if it shows an older one, that tab is serving a cached bundle (hard-reload)."
