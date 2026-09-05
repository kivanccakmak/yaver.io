#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/apple-pods-node-modules.sh
. "$ROOT/scripts/apple-pods-node-modules.sh"

TMP_BASE="$(mktemp -d /tmp/yaver-pods-node-modules-test.XXXXXX)"
cleanup() {
  find "$TMP_BASE" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$TMP_BASE/checkout/mobile/node_modules/react-native/scripts/xcode"
touch "$TMP_BASE/checkout/mobile/node_modules/react-native/scripts/xcode/with-environment.sh"
mkdir -p "$TMP_BASE/external/mobile/ios/Pods" "$TMP_BASE/checkout/mobile/ios"
ln -s "$TMP_BASE/external/mobile/ios/Pods" "$TMP_BASE/checkout/mobile/ios/Pods"
mkdir -p "$TMP_BASE/external/mobile/node_modules"

apple_ensure_pods_node_modules_layout \
  "$TMP_BASE/checkout/mobile/ios/Pods" \
  "$TMP_BASE/checkout/mobile/node_modules"
[ -L "$TMP_BASE/external/mobile/node_modules" ] || {
  echo "FAIL: empty external node_modules was not repaired with a symlink" >&2
  exit 1
}
[ -f "$TMP_BASE/external/mobile/node_modules/react-native/scripts/xcode/with-environment.sh" ] || {
  echo "FAIL: repaired path cannot resolve React Native's archive script" >&2
  exit 1
}

rm "$TMP_BASE/external/mobile/node_modules"
mkdir -p "$TMP_BASE/external/mobile/node_modules/react-native"
if apple_ensure_pods_node_modules_layout \
  "$TMP_BASE/checkout/mobile/ios/Pods" \
  "$TMP_BASE/checkout/mobile/node_modules" >/dev/null 2>&1; then
  echo "FAIL: non-empty incomplete external dependencies must not be overwritten" >&2
  exit 1
fi

echo "apple CocoaPods node_modules layout tests passed"
