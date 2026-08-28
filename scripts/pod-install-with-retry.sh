#!/usr/bin/env bash
set -eo pipefail

IOS_DIR="${1:?Usage: pod-install-with-retry.sh <ios-directory>}"
POD_BIN="${YAVER_IOS_POD_BIN:-pod}"
ATTEMPTS="${YAVER_IOS_POD_INSTALL_ATTEMPTS:-3}"
DELAY_SECONDS="${YAVER_IOS_POD_RETRY_DELAY_SECONDS:-3}"
LOG="${TMPDIR:-/tmp}/yaver-pod-install-$$.log"

if ! [[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: YAVER_IOS_POD_INSTALL_ATTEMPTS must be a positive integer; got '$ATTEMPTS'." >&2
  exit 2
fi
if ! [[ "$DELAY_SECONDS" =~ ^[0-9]+$ ]] || [ "$DELAY_SECONDS" -gt 30 ]; then
  echo "ERROR: YAVER_IOS_POD_RETRY_DELAY_SECONDS must be an integer from 0 to 30; got '$DELAY_SECONDS'." >&2
  exit 2
fi
if [ ! -d "$IOS_DIR" ]; then
  echo "ERROR: CocoaPods project directory does not exist: $IOS_DIR" >&2
  exit 2
fi
if ! command -v "$POD_BIN" >/dev/null 2>&1; then
  echo "ERROR: CocoaPods executable is unavailable: $POD_BIN" >&2
  exit 2
fi

cleanup() {
  [ -f "$LOG" ] && rm -f "$LOG"
}
trap cleanup EXIT HUP INT TERM

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  : > "$LOG"
  if (cd "$IOS_DIR" && "$POD_BIN" install) 2>&1 | tee "$LOG"; then
    exit 0
  else
    rc=$?
  fi

  if ! grep -Eqi \
    'Failed to connect|Timeout was reached|Could not resolve host|Connection reset|Connection refused|RPC failed|early EOF|remote end hung up unexpectedly|network is unreachable' \
    "$LOG"; then
    echo "ERROR: CocoaPods failed with a deterministic project/dependency error." >&2
    echo "       Generated state is preserved. Fix the named error above, then rerun ./deploy/deploy.sh ios." >&2
    exit "$rc"
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "ERROR: CocoaPods network fetch failed after $ATTEMPTS attempts." >&2
    echo "       Check GitHub/CDN access, then rerun ./deploy/deploy.sh ios; downloaded artifacts are preserved." >&2
    exit "$rc"
  fi

  echo "CocoaPods network fetch failed (attempt $attempt/$ATTEMPTS); retrying in ${DELAY_SECONDS}s with downloaded artifacts preserved." >&2
  sleep "$DELAY_SECONDS"
  attempt=$((attempt + 1))
done
