#!/bin/bash
# update-convex-version.sh — Update a component version in Convex platformConfig.
# Usage: ./scripts/update-convex-version.sh <component> <version>
# Example: ./scripts/update-convex-version.sh cli 1.29.0
#
# Requires CONVEX_DEPLOY_KEY env var for production deployment.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <component> <version>"
  echo "  component: cli | mobile | relay | web | backend"
  echo "  version: semver string (e.g., 1.29.0)"
  exit 1
fi

COMPONENT="$1"
VERSION="$2"
KEY="${COMPONENT}_version"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Updating Convex platformConfig: $KEY = $VERSION"

cd "$REPO_ROOT/backend"
npx convex run platformConfig:set "{\"key\":\"$KEY\",\"value\":\"$VERSION\"}"

echo "Done: $KEY = $VERSION"
