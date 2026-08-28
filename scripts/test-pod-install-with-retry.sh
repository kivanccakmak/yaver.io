#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yaver-pod-retry-test.XXXXXX")"
cleanup() {
  case "$TEST_DIR" in
    "${TMPDIR:-/tmp}"/yaver-pod-retry-test.*) /usr/bin/find "$TEST_DIR" -depth -delete ;;
    *) echo "Refusing unexpected test cleanup path: $TEST_DIR" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TEST_DIR/ios" "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/pod" <<'STUB'
#!/usr/bin/env bash
count=0
[ -f "$YAVER_POD_TEST_STATE" ] && count="$(cat "$YAVER_POD_TEST_STATE")"
count=$((count + 1))
printf '%s\n' "$count" > "$YAVER_POD_TEST_STATE"
if [ "$count" -lt 3 ]; then
  echo "fatal: Failed to connect to github.com: Timeout was reached" >&2
  exit 1
fi
echo "Pod installation complete"
STUB
chmod +x "$TEST_DIR/bin/pod"

YAVER_IOS_POD_BIN="$TEST_DIR/bin/pod" \
YAVER_POD_TEST_STATE="$TEST_DIR/state" \
YAVER_IOS_POD_INSTALL_ATTEMPTS=3 \
YAVER_IOS_POD_RETRY_DELAY_SECONDS=0 \
  bash "$ROOT/scripts/pod-install-with-retry.sh" "$TEST_DIR/ios" > "$TEST_DIR/output" 2>&1

[ "$(cat "$TEST_DIR/state")" = 3 ]
grep -q 'retrying in 0s' "$TEST_DIR/output"
grep -q 'Pod installation complete' "$TEST_DIR/output"
echo "pod install transient-network retry test passed"
