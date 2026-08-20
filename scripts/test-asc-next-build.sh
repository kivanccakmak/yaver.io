#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/asc-next-build.sh
. "$ROOT/scripts/asc-next-build.sh"

TMP_DIR="$(mktemp -d)"
trap 'find "$TMP_DIR" -depth -delete' EXIT
FAKE_PYTHON="$TMP_DIR/python3"

cat >"$FAKE_PYTHON" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-c" ]; then
  exit 0
fi
if [ -n "${FAKE_ASC_MAX:-}" ]; then
  printf '%s\n' "$FAKE_ASC_MAX"
fi
exit 0
EOF
chmod +x "$FAKE_PYTHON"
export YAVER_PYTHON="$FAKE_PYTHON"

FAKE_ASC_MAX=294
export FAKE_ASC_MAX
actual="$(asc_next_build TV_OS 1 require_remote)"
[ "$actual" = "295" ] || {
  echo "expected remote max 294 to produce 295, got $actual" >&2
  exit 1
}

unset FAKE_ASC_MAX
set +e
actual="$(asc_next_build TV_OS 1 require_remote 2>/dev/null)"
status=$?
set -e
[ "$status" -eq 75 ] || {
  echo "expected strict unreadable lookup to exit 75, got $status" >&2
  exit 1
}
[ -z "$actual" ] || {
  echo "strict unreadable lookup must not emit an unsafe fallback, got $actual" >&2
  exit 1
}

actual="$(asc_next_build TV_OS 1 best_effort 2>/dev/null)"
[ "$actual" = "2" ] || {
  echo "expected best-effort callers to retain local fallback 2, got $actual" >&2
  exit 1
}

echo "asc-next-build tests passed"
