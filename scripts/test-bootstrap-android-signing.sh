#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bootstrap="$ROOT/scripts/bootstrap-android-signing.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

bash -n "$bootstrap"
grep -q 'YAVER_ENABLE_VAULT=1 yaver vault sync' "$bootstrap" || \
  fail "peer sync must explicitly enable the vault-backed deploy cell"
grep -q 'YAVER_VAULT_SYNC_TIMEOUT_SECONDS' "$bootstrap" || \
  fail "peer sync must have a configurable wall-clock bound"
grep -q 'kill "$sync_pid"' "$bootstrap" || \
  fail "a timed-out peer sync must be terminated before local fallback"
grep -q '^vault_get()' "$bootstrap" || \
  fail "all signing-entry reads must explicitly enable the vault"
if grep -qE '^[[:space:]]*yaver vault get ' "$bootstrap"; then
  fail "a bare vault get silently reports missing entries in vault-disabled CLI builds"
fi

echo "android signing bootstrap tests passed"
