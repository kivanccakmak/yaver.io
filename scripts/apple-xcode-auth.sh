#!/bin/bash

# Shared App Store Connect authentication preflight for local Apple deploys.
#
# Xcode supports two real upload paths:
#   1. an App Store Connect API key (headless/CI), or
#   2. the Apple account already signed in to Xcode (interactive Mac).
#
# The deploy scripts used to accept only (1), so a Mac that had just proved it
# could provision and upload from Xcode still failed immediately with
# "APP_STORE_KEY_PATH unset". Keep API-key auth when it is complete, reject
# partial/broken configuration, and otherwise let xcodebuild use its signed-in
# account. The latter cannot query ASC for the highest build number, so callers
# must require an explicit build override before consuming an upload slot.

apple_configure_xcode_auth() {
  local key_path="${APP_STORE_KEY_PATH:-}"
  local key_id="${APP_STORE_KEY_ID:-}"
  local key_issuer="${APP_STORE_KEY_ISSUER:-}"
  local configured=0

  [ -n "$key_path" ] && configured=$((configured + 1))
  [ -n "$key_id" ] && configured=$((configured + 1))
  [ -n "$key_issuer" ] && configured=$((configured + 1))

  APPLE_XCODE_AUTH_ARGS=()
  APPLE_XCODE_AUTH_MODE="xcode-account"

  if [ "$configured" -ne 0 ] && [ "$configured" -ne 3 ]; then
    echo "ERROR: App Store Connect API-key authentication is only partially configured." >&2
    echo "       Set APP_STORE_KEY_PATH, APP_STORE_KEY_ID, and APP_STORE_KEY_ISSUER together," >&2
    echo "       or unset all three to use the Apple account signed in to Xcode." >&2
    return 1
  fi

  if [ "$configured" -eq 3 ]; then
    if [ ! -r "$key_path" ]; then
      echo "ERROR: APP_STORE_KEY_PATH is not a readable file: $key_path" >&2
      return 1
    fi
    APPLE_XCODE_AUTH_MODE="api-key"
    APPLE_XCODE_AUTH_ARGS=(
      -authenticationKeyPath "$key_path"
      -authenticationKeyID "$key_id"
      -authenticationKeyIssuerID "$key_issuer"
    )
    echo "Apple upload authentication: App Store Connect API key"
    return 0
  fi

  echo "Apple upload authentication: signed-in Xcode account"
}

apple_resolve_team_id() {
  local project_source="$1"
  local resolved="${APPLE_TEAM_ID:-}"

  if [ -z "$resolved" ] && [ -f "$project_source" ]; then
    resolved="$(sed -nE \
      's/.*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*([A-Z0-9]+);.*/\1/p' \
      "$project_source" | head -1)"
    if [ -z "$resolved" ]; then
      resolved="$(sed -nE \
        's/.*DEVELOPMENT_TEAM:[[:space:]]*//p' \
        "$project_source" | head -1 | tr -d '"[:space:]')"
    fi
  fi

  case "$resolved" in
    [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) ;;
    *)
      echo "ERROR: APPLE_TEAM_ID is missing or invalid, and no 10-character team ID" >&2
      echo "       could be derived from $project_source." >&2
      return 1
      ;;
  esac

  APPLE_TEAM_ID="$resolved"
  export APPLE_TEAM_ID
}

apple_require_explicit_build_without_api_key() {
  local variable_name="$1"
  local value="$2"

  if [ "$APPLE_XCODE_AUTH_MODE" = "xcode-account" ] && [ -z "$value" ]; then
    echo "ERROR: $variable_name is required when uploading through the signed-in Xcode account." >&2
    echo "       Without an API key Yaver cannot query App Store Connect for the highest" >&2
    echo "       existing build, and guessing can collide and consume an upload slot." >&2
    return 1
  fi
}

apple_validate_build_number() {
  local variable_name="$1"
  local value="$2"
  case "$value" in
    ''|*[!0-9]*)
      echo "ERROR: $variable_name must be a positive integer; got '${value:-<empty>}'." >&2
      return 1
      ;;
    0)
      echo "ERROR: $variable_name must be greater than zero." >&2
      return 1
      ;;
  esac
}
