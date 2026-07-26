#!/usr/bin/env bash
# Local MacBook full-stack harness.
#
# Runs Yaver's local server-side and client-side checks from one Mac:
# Go agent/relay tests, TS client policy tests, headless web/mobile surrogates,
# browser rendering through the agent, and the iOS Simulator remote-runtime lane
# when a local agent token is available.
#
# This is intentionally local-only. It does not provision Hetzner, deploy
# Cloudflare, upload TestFlight, publish npm, or mutate remote provider state.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/yaver-macbook-local-all-$$}"
mkdir -p "$LOG_DIR"

PASS=0
FAIL=0
SKIP=0
FAILED=()

bold=""
dim=""
green=""
red=""
yellow=""
blue=""
nc=""
if [[ -t 1 ]]; then
  bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; red=$'\033[31m'
  yellow=$'\033[33m'; blue=$'\033[34m'; nc=$'\033[0m'
fi

need() { command -v "$1" >/dev/null 2>&1; }

redact() {
  sed -E \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1<redacted>/g' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1<redacted>/g' \
    -e 's/((TOKEN|PASSWORD|SECRET|PRIVATE_KEY|API_KEY|AUTH_TOKEN|YAVER_AGENT_TOKEN)[A-Za-z0-9_ -]*[:=][[:space:]]*)[^[:space:]'"'"'"]+/\1<redacted>/Ig'
}

section() {
  printf "\n%s%s%s\n" "$blue$bold" "$1" "$nc"
}

run_step() {
  local name="$1"
  shift
  local log="$LOG_DIR/$(echo "$name" | tr '/: ' '____').log"
  local raw="$log.raw"
  printf "  %s› %s%s " "$dim" "$name" "$nc"
  if [[ "${VERBOSE:-0}" == "1" ]]; then
    set -o pipefail
    if "$@" 2>&1 | redact | tee "$log"; then
      set +o pipefail
      PASS=$((PASS + 1)); printf "%sPASS%s\n" "$green" "$nc"; return 0
    fi
    set +o pipefail
  else
    if "$@" >"$raw" 2>&1; then
      redact <"$raw" >"$log"
      rm -f "$raw"
      PASS=$((PASS + 1)); printf "%sPASS%s\n" "$green" "$nc"; return 0
    fi
    redact <"$raw" >"$log"
    rm -f "$raw"
  fi
  FAIL=$((FAIL + 1))
  FAILED+=("$name")
  printf "%sFAIL%s  log: %s\n" "$red" "$nc" "$log"
  tail -40 "$log" | sed 's/^/      /'
  return 1
}

skip_step() {
  SKIP=$((SKIP + 1))
  printf "  %s› %s%s %sSKIP%s  %s\n" "$dim" "$1" "$nc" "$yellow" "$nc" "$2"
}

run_go() {
  section "Server Side: Agent, Relay, MCP"
  if ! need go; then
    skip_step "go tests" "go not on PATH"
    return 0
  fi
  run_step "desktop/agent go test ./..." bash -lc "cd desktop/agent && go test -count=1 ./..."
  run_step "relay go test ./..." bash -lc "cd relay && go test -count=1 ./..."
  run_step "mcp go test ./..." bash -lc "cd mcp && go test -count=1 ./..."
  [[ -d embedded/c-agent/brain ]] && run_step "embedded c-agent brain" bash -lc "cd embedded/c-agent/brain && go test -count=1 ./..."
}

run_client_ts() {
  section "Client Side: Web, Mobile, Backend Policy Tests"
  if ! need npm; then
    skip_step "client TS tests" "npm not on PATH"
    return 0
  fi
  if [[ -d web/node_modules ]]; then
    run_step "web lib tsx tests" bash -lc "cd web && for f in lib/*.test.ts components/dashboard/*.test.ts; do [ -f \"\$f\" ] && npx tsx \"\$f\"; done"
  else
    skip_step "web lib tsx tests" "web/node_modules missing; run npm ci in web/"
  fi
  if [[ -d mobile/node_modules ]]; then
    run_step "mobile pure tsx tests" bash -lc "cd mobile && while IFS= read -r f; do npx tsx \"\$f\" || exit 1; done < <(find src \\( -name '*.test.ts' -o -name '*.test.mts' \\) | sort)"
    run_step "mobile plugin node tests" bash -lc "cd mobile && node --test plugins/*.test.mjs"
  else
    skip_step "mobile pure tsx tests" "mobile/node_modules missing; run npm ci in mobile/"
  fi
  if [[ -d backend/node_modules ]]; then
    run_step "backend convex policy tests" bash -lc "cd backend && node --experimental-strip-types --test convex/*.test.mts"
  else
    skip_step "backend convex policy tests" "backend/node_modules missing; run npm ci in backend/"
  fi
}

run_headless() {
  section "Headless Client Surrogates"
  if need bun && [[ -d mobile-headless/node_modules ]]; then
    run_step "mobile-headless bun test" bash -lc "cd mobile-headless && bun test"
  else
    skip_step "mobile-headless bun test" "bun or mobile-headless/node_modules missing"
  fi
  if need bun && [[ -d web-headless/node_modules ]]; then
    run_step "web-headless bun test" bash -lc "cd web-headless && bun test"
  else
    skip_step "web-headless bun test" "bun or web-headless/node_modules missing"
  fi
}

agent_ready() {
  [[ -n "${YAVER_AGENT_TOKEN:-}" ]] || return 1
  local base="${AGENT_URL:-http://127.0.0.1:18099}"
  curl -fsS --max-time 3 "$base/health" >/dev/null 2>&1
}

run_browser_lanes() {
  section "Rendering: Browser Client Through Agent Transport"
  if ! need node; then
    skip_step "browser lane" "node not on PATH"
    return 0
  fi
  if [[ ! -d e2e/node_modules ]]; then
    skip_step "browser lane" "e2e/node_modules missing; run npm install in e2e/"
    return 0
  fi
  if ! agent_ready; then
    skip_step "browser lane" "set YAVER_AGENT_TOKEN and AGENT_URL for a running local agent"
    return 0
  fi
  export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/Workspace}"
  run_step "todo iframe browser lane matrix" bash -lc "node e2e/todo-iframe-loop.mjs"
}

run_ios_sim() {
  section "Rendering: iOS Simulator Remote Runtime"
  if ! need xcrun; then
    skip_step "ios simulator loop" "xcrun not on PATH"
    return 0
  fi
  if ! agent_ready; then
    skip_step "ios simulator loop" "set YAVER_AGENT_TOKEN and AGENT_URL for a running local agent"
    return 0
  fi
  export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/Workspace}"
  run_step "ios simulator WebRTC/JPEG loop" bash -lc "node e2e/ios-simulator-loop.mjs"
}

usage() {
  sed -n '1,35p' "$0"
  cat <<'EOF'

Usage:
  ./scripts/test-macbook-local-all.sh
  ./scripts/test-macbook-local-all.sh server client headless browser ios

Environment:
  VERBOSE=1                  stream command output
  LOG_DIR=/tmp/yaver-tests    store logs elsewhere
  AGENT_URL=http://127.0.0.1:18099
  YAVER_AGENT_TOKEN=...       required for browser + iOS simulator lanes
  WORKSPACE_ROOT=$HOME/Workspace
  YAVER_LANE_APPS='[{"name":"sfmg","workDir":"/path","framework":"expo"}]'
EOF
}

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(server client headless browser ios)
fi

for t in "${targets[@]}"; do
  case "$t" in
    server) run_go ;;
    client) run_client_ts ;;
    headless) run_headless ;;
    browser) run_browser_lanes ;;
    ios|simulator|ios-simulator) run_ios_sim ;;
    -h|--help|help) usage; exit 0 ;;
    *) echo "unknown target: $t" >&2; usage; exit 2 ;;
  esac
done

printf "\n%sMacBook local all summary%s\n" "$bold" "$nc"
printf "  %sPASS%s %d\n" "$green" "$nc" "$PASS"
printf "  %sFAIL%s %d\n" "$red" "$nc" "$FAIL"
printf "  %sSKIP%s %d\n" "$yellow" "$nc" "$SKIP"
printf "  logs: %s\n" "$LOG_DIR"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  printf "  failed steps:\n"
  printf "    %s\n" "${FAILED[@]}"
fi

[[ "$FAIL" -eq 0 ]]
