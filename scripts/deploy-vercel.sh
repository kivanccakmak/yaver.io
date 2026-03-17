#!/usr/bin/env bash
set -euo pipefail

# Size-guarded Vercel production deploy for the web/ directory.
# Ensures .vercelignore is present and the deployed payload stays under 10 MB.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/web"
MAX_SIZE_MB=10

# 1. Verify .vercelignore exists
if [ ! -f "$REPO_ROOT/.vercelignore" ]; then
  echo "ERROR: .vercelignore not found at repo root."
  echo "Vercel will upload the ENTIRE repo (desktop/, mobile/, relay/, etc.) without it."
  echo "Aborting deploy."
  exit 1
fi

# 2. Calculate deployed directory size (excluding node_modules and .next)
# macOS du doesn't support --exclude; use find + stat instead
SIZE_KB=$(find "$DEPLOY_DIR" \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -type f -print0 \
  | xargs -0 stat -f%z 2>/dev/null \
  | awk '{s+=$1} END {printf "%.0f", s/1024}')

# Fallback for Linux (stat -f%z is macOS-specific)
if [ -z "$SIZE_KB" ] || [ "$SIZE_KB" = "0" ]; then
  SIZE_KB=$(du -sk --exclude='node_modules' --exclude='.next' "$DEPLOY_DIR" 2>/dev/null | awk '{print $1}')
fi

SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $SIZE_KB / 1024}")

echo "Deployed directory: $DEPLOY_DIR"
echo "Size (excl node_modules/.next): ${SIZE_MB} MB"

# 3. Abort if over limit
MAX_SIZE_KB=$((MAX_SIZE_MB * 1024))
if [ "$SIZE_KB" -gt "$MAX_SIZE_KB" ]; then
  echo "ERROR: web/ is ${SIZE_MB} MB — exceeds ${MAX_SIZE_MB} MB limit."
  echo "Check for accidentally committed binaries, images, or large assets."
  echo "Aborting deploy."
  exit 1
fi

echo "Size OK (under ${MAX_SIZE_MB} MB). Deploying..."

# 4. Deploy to production
cd "$REPO_ROOT"
vercel --prod "$@"
