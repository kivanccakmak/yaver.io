#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="$ROOT/mobile/android/settings.gradle"
WRAPPER="$ROOT/mobile/android/gradle/wrapper/gradle-wrapper.properties"
DEPLOY="$ROOT/scripts/deploy-playstore.sh"
ANDROID_SDK_HELPER="$ROOT/scripts/lib/android-sdk.sh"
TV_DEPLOY="$ROOT/scripts/deploy-android-tv.sh"
WEAR_DEPLOY="$ROOT/scripts/deploy-wear-os.sh"
XR_DEPLOY="$ROOT/scripts/deploy-android-xr.sh"

grep -q 'id("expo-autolinking-settings")' "$SETTINGS"
grep -q 'includeBuild(expoPluginsPath)' "$SETTINGS"
grep -q 'expoAutolinking.useExpoModules()' "$SETTINGS"

GRADLE_VERSION=$(sed -nE 's#.*gradle-([0-9]+\.[0-9]+(\.[0-9]+)?)-[^/]+\.zip#\1#p' "$WRAPPER")
if [ -z "$GRADLE_VERSION" ]; then
  echo "could not read Gradle wrapper version" >&2
  exit 1
fi
GRADLE_MAJOR=${GRADLE_VERSION%%.*}
GRADLE_MINOR=${GRADLE_VERSION#*.}; GRADLE_MINOR=${GRADLE_MINOR%%.*}
if [ "$GRADLE_MAJOR" -lt 8 ] || { [ "$GRADLE_MAJOR" -eq 8 ] && [ "$GRADLE_MINOR" -lt 13 ]; }; then
  echo "Expo SDK 54 / AGP requires Gradle >= 8.13; found $GRADLE_VERSION" >&2
  exit 1
fi

grep -q 'yaver_resolve_android_sdk' "$DEPLOY"
grep -q 'yaver_resolve_android_sdk' "$TV_DEPLOY"
grep -q 'yaver_resolve_android_sdk' "$WEAR_DEPLOY"
grep -q 'yaver_android_sdk_is_usable' "$ANDROID_SDK_HELPER"
grep -q 'yaver_release_manifest_path' "$ANDROID_SDK_HELPER"
grep -q 'yaver_release_manifest_path' "$TV_DEPLOY"
grep -q 'yaver_release_manifest_path' "$WEAR_DEPLOY"
grep -q 'yaver_release_manifest_path' "$XR_DEPLOY"
grep -q 'mobile/android/gradlew.*androidtv' "$TV_DEPLOY"
grep -q '"$HOME/Library/Android/sdk"' "$ANDROID_SDK_HELPER"
grep -q '"$HOME/Android/Sdk"' "$ANDROID_SDK_HELPER"

echo "Android native toolchain wiring OK (Gradle $GRADLE_VERSION)."
