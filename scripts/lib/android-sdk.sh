#!/usr/bin/env bash

# Resolve the Android SDK for every release surface. A configured environment
# variable is only inventory: Gradle needs a real SDK with platforms and build
# tools. Keep this shared so phone, TV, Wear, Auto, and XR cannot drift into
# different "SDK not found" behavior.
yaver_android_sdk_is_usable() {
  [ -n "${1:-}" ] && [ -d "$1/platforms" ] && [ -d "$1/build-tools" ]
}

yaver_resolve_android_sdk() {
  local resolved=""

  if yaver_android_sdk_is_usable "${ANDROID_SDK_ROOT:-}"; then
    resolved="$ANDROID_SDK_ROOT"
  elif yaver_android_sdk_is_usable "${ANDROID_HOME:-}"; then
    resolved="$ANDROID_HOME"
  else
    local candidate
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
      if yaver_android_sdk_is_usable "$candidate"; then
        resolved="$candidate"
        break
      fi
    done
  fi

  if [ -z "$resolved" ]; then
    echo "ERROR: Android SDK is unavailable: ANDROID_SDK_ROOT/ANDROID_HOME do not contain platforms and build-tools, and no standard user SDK was found." >&2
    echo "Install the required Android SDK platform and build tools in Android Studio, then retry the same ./deploy/deploy.sh target." >&2
    return 1
  fi

  export ANDROID_HOME="$resolved"
  export ANDROID_SDK_ROOT="$resolved"
  echo "Using Android SDK: $resolved"
}
