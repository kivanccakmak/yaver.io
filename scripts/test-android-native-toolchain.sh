#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="$ROOT/mobile/android/settings.gradle"
WRAPPER="$ROOT/mobile/android/gradle/wrapper/gradle-wrapper.properties"
DEPLOY="$ROOT/scripts/deploy-playstore.sh"

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

grep -q 'is_usable_android_sdk' "$DEPLOY"
grep -q '"$HOME/Library/Android/sdk"' "$DEPLOY"
grep -q '"$HOME/Android/Sdk"' "$DEPLOY"

echo "Android native toolchain wiring OK (Gradle $GRADLE_VERSION)."
