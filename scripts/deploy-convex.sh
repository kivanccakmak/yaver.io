#!/bin/bash
set -eo pipefail

# Deploy backend/convex/* to Convex prod (perceptive-minnow-557).
#
# Portable across machines. Secrets resolution order, first hit wins:
#
#   1. CONVEX_DEPLOY_KEY env var (CI path; GitHub Actions sets this from the
#      repo secret of the same name, and local devs export it or use a
#      gitignored env file)
#
# `yaver vault` is deliberately not consulted: a v2 vault is master-key
# encrypted and unrecoverable if that key is lost, and the call swallowed its
# own failure so the deploy reported a missing key rather than a locked vault.
#
# Paste it inline for a one-shot deploy:
#
#   CONVEX_DEPLOY_KEY=<key> ./scripts/deploy-convex.sh
#
# The key is the deploy key from Convex dashboard
# (perceptive-minnow-557 → Settings → Deploy Keys).

cd "$(dirname "$0")/.."


# Prefer the rotated CONVEX_DEPLOY_KEY_2 if present; the older
# CONVEX_DEPLOY_KEY name still works as a fallback for CI workflows
# that haven't switched yet. `npx convex` only reads CONVEX_DEPLOY_KEY,
# so promote whichever variant is set into the canonical name.
if [ -n "${CONVEX_DEPLOY_KEY_2:-}" ]; then
  export CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_2"
fi

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "ERROR: CONVEX_DEPLOY_KEY / CONVEX_DEPLOY_KEY_2 is not set." >&2
  echo >&2
  echo "Pick one:" >&2
  echo "  1. CONVEX_DEPLOY_KEY_2=<key> $0" >&2
  echo "  2. add it to a gitignored env file you source before running this" >&2
  echo >&2
  echo "(`yaver vault` is deliberately NOT an option: the vault ships off in v1," >&2
  echo " and a v2 vault is unrecoverable if its master key is lost, so no deploy" >&2
  echo " may depend on it.)" >&2
  echo >&2
  echo "The key lives at https://dashboard.convex.dev/d/perceptive-minnow-557/settings/deploy-keys" >&2
  exit 2
fi

echo "Deploying backend/convex to Convex prod..."
cd backend
exec npx convex deploy --yes
