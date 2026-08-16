#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/apple-xcode-auth.sh
. "$ROOT/scripts/apple-xcode-auth.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

unset APP_STORE_KEY_PATH APP_STORE_KEY_ID APP_STORE_KEY_ISSUER APPLE_TEAM_ID
apple_configure_xcode_auth >/dev/null
[ "$APPLE_XCODE_AUTH_MODE" = "xcode-account" ] || fail "empty credentials should use Xcode account"
[ "${#APPLE_XCODE_AUTH_ARGS[@]}" -eq 0 ] || fail "Xcode account mode should add no auth flags"

APP_STORE_KEY_ID="partial"
if apple_configure_xcode_auth >/dev/null 2>&1; then
  fail "partial API credentials must fail"
fi

APP_STORE_KEY_PATH="/definitely/missing/yaver-auth-key.p8"
APP_STORE_KEY_ISSUER="issuer"
if apple_configure_xcode_auth >/dev/null 2>&1; then
  fail "an unreadable API key path must fail"
fi

AUTH_FIXTURE="$(mktemp /tmp/yaver-apple-auth-key.XXXXXX)"
trap 'rm -f "$AUTH_FIXTURE"' EXIT
APP_STORE_KEY_PATH="$AUTH_FIXTURE"
apple_configure_xcode_auth >/dev/null
[ "$APPLE_XCODE_AUTH_MODE" = "api-key" ] || fail "complete credentials should use API-key mode"
[ "${#APPLE_XCODE_AUTH_ARGS[@]}" -eq 6 ] || fail "API-key mode should emit six xcodebuild arguments"

unset APPLE_TEAM_ID
apple_resolve_team_id "$ROOT/mobile/ios/Yaver.xcodeproj/project.pbxproj"
[ "${#APPLE_TEAM_ID}" -eq 10 ] || fail "iOS team ID was not derived"
IOS_TEAM="$APPLE_TEAM_ID"
unset APPLE_TEAM_ID
apple_resolve_team_id "$ROOT/tvos/project.yml"
[ "$APPLE_TEAM_ID" = "$IOS_TEAM" ] || fail "tvOS and iOS team IDs differ"

APPLE_XCODE_AUTH_MODE="xcode-account"
if apple_require_explicit_build_without_api_key TVOS_BUILD_NUMBER "" >/dev/null 2>&1; then
  fail "Xcode account mode must reject an absent explicit build"
fi
apple_require_explicit_build_without_api_key TVOS_BUILD_NUMBER 42

apple_validate_build_number TEST_BUILD 42
if apple_validate_build_number TEST_BUILD nope >/dev/null 2>&1; then
  fail "non-numeric builds must fail"
fi

echo "apple-xcode-auth tests passed"
