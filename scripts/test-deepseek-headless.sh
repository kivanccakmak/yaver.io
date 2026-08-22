#!/usr/bin/env bash
# Real, opt-in DeepSeek probe for the production phone-side coding path.
#
# Credential sources:
#   ./scripts/test-deepseek-headless.sh --hermetic
#   DEEPSEEK_API_KEY=... ./scripts/test-deepseek-headless.sh
#   ./scripts/test-deepseek-headless.sh --opencode
#
# The key stays in this process environment. It is never placed in argv, the
# bundle, test output, the repository, or a persistent temporary file.

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_SOURCE="environment"
PROBE_MODE="live"

if [[ "${1:-}" == "--hermetic" ]]; then
  PROBE_MODE="hermetic"
  KEY_SOURCE="none"
elif [[ "${1:-}" == "--opencode" ]]; then
  KEY_SOURCE="OpenCode configuration"
  DEEPSEEK_API_KEY="$(node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const candidates = [
  process.env.OPENCODE_CONFIG,
  process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
  path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  path.join(os.homedir(), ".opencode.json"),
].filter(Boolean);
for (const candidate of candidates) {
  try {
    const config = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const key = config?.provider?.deepseek?.options?.apiKey ?? config?.provider?.deepseek?.apiKey;
    if (typeof key === "string" && key.trim()) {
      process.stdout.write(key.trim());
      process.exit(0);
    }
  } catch {}
}
process.exit(1);
NODE
)" || {
    echo "DeepSeek live probe: no configured key found in OpenCode." >&2
    exit 2
  }
  export DEEPSEEK_API_KEY
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 --hermetic | DEEPSEEK_API_KEY=... $0 | $0 --opencode" >&2
  exit 2
fi

if [[ "$PROBE_MODE" == "live" && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DeepSeek live probe: DEEPSEEK_API_KEY is not set." >&2
  exit 2
fi

PROBE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yaver-deepseek-probe.XXXXXX")"
PROBE_BUNDLE="$PROBE_TMP_DIR/deepseek-headless-live.test.mjs"
cleanup() {
  unset DEEPSEEK_API_KEY
  [[ -f "$PROBE_BUNDLE" ]] && rm -f "$PROBE_BUNDLE"
  [[ -d "$PROBE_TMP_DIR" ]] && rmdir "$PROBE_TMP_DIR"
}
trap cleanup EXIT INT TERM

if [[ "$PROBE_MODE" == "live" ]]; then
  echo "DeepSeek live probe: using $KEY_SOURCE; credential output is disabled."
else
  echo "DeepSeek hermetic probe: no provider request or credential access."
fi
(
  cd "$ROOT_DIR/backend"
  npx --no-install esbuild "$ROOT_DIR/scripts/deepseek-headless-live.test.mts" \
    --bundle --platform=node --format=esm --outfile="$PROBE_BUNDLE" --log-level=warning
)

if [[ "$PROBE_MODE" == "live" ]]; then export YAVER_LIVE_DEEPSEEK=1; else export YAVER_LIVE_DEEPSEEK=0; fi
node --test "$PROBE_BUNDLE"
