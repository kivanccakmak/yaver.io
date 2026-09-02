#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="$ROOT/sdk/feedback/react-native"
PACKAGE="yaver-feedback-react-native"

if [ "$(git -C "$ROOT" branch --show-current)" != "main" ]; then
  echo "ERROR: feedback SDK releases must run from main." >&2
  exit 2
fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "ERROR: feedback SDK release requires a clean committed worktree." >&2
  exit 2
fi

version="$(node -p "require('$SDK/package.json').version")"
lock_version="$(node -p "require('$SDK/package-lock.json').packages[''].version")"
if [ "$version" != "$lock_version" ]; then
  echo "ERROR: package.json ($version) and package-lock.json ($lock_version) disagree." >&2
  exit 2
fi

live="$(npm view "$PACKAGE@$version" version 2>/dev/null || true)"
if [ "$live" = "$version" ]; then
  echo "$PACKAGE@$version is already live; nothing to publish."
  exit 0
fi

# Probe the operation before doing the expensive install/test pass. A missing
# npm session used to spend minutes and disk on a full verification run, only
# to fail at the final publish command with ENEEDAUTH.
if ! npm_identity="$(npm whoami 2>/dev/null)"; then
  echo "ERROR: this machine is not authenticated to publish on npm." >&2
  echo "Run 'npm login --auth-type=web', complete the browser approval, then retry ./deploy/deploy.sh feedback-sdk." >&2
  exit 2
fi
echo "npm authentication verified for $npm_identity."

cd "$SDK"
npm ci
npm run test:ci
npm publish --access public

for attempt in 1 2 3 4 5 6; do
  live="$(npm view "$PACKAGE@$version" version 2>/dev/null || true)"
  if [ "$live" = "$version" ]; then
    echo "$PACKAGE@$version is live on npm."
    exit 0
  fi
  if [ "$attempt" -lt 6 ]; then sleep 5; fi
done

echo "ERROR: npm did not serve $PACKAGE@$version after publish." >&2
exit 1
