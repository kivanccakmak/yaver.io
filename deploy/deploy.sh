#!/usr/bin/env bash
set -euo pipefail

# Yaver deploy front door. This is the one canonical human/agent path:
#   ./deploy/deploy.sh <target> [options]
#
# Keep this file as a thin layer over the maintained deploy machinery in
# scripts/ and `yaver deploy`. Do not add sibling wrapper scripts; one path is
# the point.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_owner_locked_path() {
  local path="$1"
  if [ ! -e "$path" ]; then
    echo "ERROR: missing path for deploy permission check: $path" >&2
    exit 2
  fi

  local owner mode
  owner="$(stat -f '%Su' "$path" 2>/dev/null || stat -c '%U' "$path" 2>/dev/null || true)"
  mode="$(stat -f '%Lp' "$path" 2>/dev/null || stat -c '%a' "$path" 2>/dev/null || true)"

  if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
    echo "ERROR: refusing deploy because $path is owned by $owner, not $(id -un)." >&2
    exit 2
  fi

  if [ -n "$mode" ]; then
    local last_two=$((10#$mode % 100))
    local group_digit=$((last_two / 10))
    local other_digit=$((last_two % 10))
    if [ $((group_digit & 2)) -ne 0 ] || [ $((other_digit & 2)) -ne 0 ]; then
      echo "ERROR: refusing deploy because $path is group/other-writable (mode $mode)." >&2
      echo "Fix: chmod go-w '$path'" >&2
      exit 2
    fi
  fi
}

require_deploy_boundary() {
  require_owner_locked_path "$ROOT"
  require_owner_locked_path "$ROOT/deploy/deploy.sh"

  if [ "${YAVER_DEPLOY_ALLOW_SHARED:-}" = "1" ]; then
    return 0
  fi

  case "$(umask)" in
    0077|0027|0022|077|027|022) ;;
    *)
      echo "ERROR: deploy requires a conservative umask (077, 027, or 022)." >&2
      echo "Current umask: $(umask)" >&2
      exit 2
      ;;
  esac
}

usage() {
  cat <<'USAGE'
Usage:
  ./deploy/deploy.sh <target> [options]

Targets:
  all          Full sequential Yaver release via `yaver deploy all`
  backend      Convex backend prod deploy
  convex       Alias for backend
  cloudflare   Cloudflare Workers web deploy
  web          Alias for cloudflare
  ios          TestFlight deploy
  testflight   Alias for ios
  android      Play internal deploy + upload
  playstore    Alias for android
  npm          CLI npm release via `yaver deploy npm`
  cli          Alias for npm
  mcp          Publish/sync MCP registry metadata

Common:
  --dry-run    Print the command instead of running it where the target supports it

Examples:
  ./deploy/deploy.sh all --dry-run
  ./deploy/deploy.sh backend
  ./deploy/deploy.sh cloudflare
  ./deploy/deploy.sh ios
USAGE
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

target="$1"
shift

dry_run=0
pass_args=()
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      pass_args+=("$arg")
      ;;
    *)
      pass_args+=("$arg")
      ;;
  esac
done

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '[dry-run] cd %q &&' "$ROOT"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  (cd "$ROOT" && "$@")
}

run_shell() {
  if [ "$dry_run" -eq 1 ]; then
    printf '[dry-run] cd %q && %s\n' "$ROOT" "$*"
    return 0
  fi
  (cd "$ROOT" && bash -lc "$*")
}

case "$target" in
  all)
    require_deploy_boundary
    if ! command -v yaver >/dev/null 2>&1; then
      echo "ERROR: yaver CLI is required for deploy target 'all'." >&2
      exit 2
    fi
    # Let the CLI own version bumps, clean-tree checks, logging, and release
    # commits. It already knows how to coalesce the full stack safely.
    run yaver deploy all "${pass_args[@]}"
    ;;
  backend|convex)
    require_deploy_boundary
    run "$ROOT/scripts/deploy-convex.sh"
    ;;
  cloudflare|web)
    require_deploy_boundary
    run "$ROOT/scripts/deploy-web.sh"
    ;;
  ios|testflight)
    require_deploy_boundary
    run "$ROOT/scripts/deploy-testflight.sh"
    ;;
  android|playstore)
    require_deploy_boundary
    run_shell 'JAVA_HOME=$(/usr/libexec/java_home -v 17) ./scripts/deploy-playstore.sh && PLAY_STORE_KEY_FILE=keys/google-play-service-account.json python3 scripts/upload-playstore.py'
    ;;
  npm|cli)
    require_deploy_boundary
    if ! command -v yaver >/dev/null 2>&1; then
      echo "ERROR: yaver CLI is required for deploy target '$target'." >&2
      exit 2
    fi
    run yaver deploy npm "${pass_args[@]}"
    ;;
  mcp)
    require_deploy_boundary
    run "$ROOT/scripts/publish-mcp-registries.sh" --all
    ;;
  *)
    echo "ERROR: unknown deploy target '$target'." >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
