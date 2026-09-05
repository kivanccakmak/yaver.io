#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/apple-artifact-root.sh
. "$ROOT/scripts/apple-artifact-root.sh"

TMP_BASE="$(mktemp -d /tmp/yaver-apple-artifact-root-test.XXXXXX)"
cleanup() {
  find "$TMP_BASE" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

apple_prepare_artifact_root "$TMP_BASE/artifacts"
EXPECTED_ROOT="$(cd "$TMP_BASE/artifacts" && pwd -P)"
[ "$APPLE_ARTIFACT_ROOT" = "$EXPECTED_ROOT" ] || {
  echo "FAIL: artifact root was not canonicalized/exported" >&2
  exit 1
}
if find "$TMP_BASE/artifacts" -maxdepth 1 -name '.yaver-apple-artifacts.*' -print -quit | grep -q .; then
  echo "FAIL: capability probe leaked temporary state" >&2
  exit 1
fi

if apple_prepare_artifact_root "relative/path" >/dev/null 2>&1; then
  echo "FAIL: relative artifact root must be rejected" >&2
  exit 1
fi
if apple_prepare_artifact_root "/" >/dev/null 2>&1; then
  echo "FAIL: filesystem root must be rejected" >&2
  exit 1
fi

mkdir -p "$TMP_BASE/Volumes/BuildCard"
touch "$TMP_BASE/Volumes/BuildCard/.yaver-artifact-volume"
DETECTED="$(apple_detect_artifact_root "$TMP_BASE/Volumes" yaver-ios)"
[ "$DETECTED" = "$TMP_BASE/Volumes/BuildCard/yaver-ios" ] || {
  echo "FAIL: marked artifact volume was not detected: $DETECTED" >&2
  exit 1
}
mkdir -p "$TMP_BASE/Volumes/SecondCard"
touch "$TMP_BASE/Volumes/SecondCard/.yaver-artifact-volume"
if apple_detect_artifact_root "$TMP_BASE/Volumes" yaver-ios >/dev/null 2>&1; then
  echo "FAIL: ambiguous marked artifact volumes must be rejected" >&2
  exit 1
fi

echo "apple artifact root tests passed"
