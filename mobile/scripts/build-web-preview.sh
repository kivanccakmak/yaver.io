#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_ROOT="$ROOT_DIR/.tmp"
CHROME_RUNTIME_DIR="$TMP_ROOT/chrome-runtime"
CHROME_HOME_DIR="$TMP_ROOT/chrome-home"
TMPDIR_DIR="$TMP_ROOT/tmp"

mkdir -p "$CHROME_RUNTIME_DIR" "$CHROME_HOME_DIR" "$TMPDIR_DIR"
chmod 700 "$CHROME_RUNTIME_DIR" "$CHROME_HOME_DIR" "$TMPDIR_DIR" 2>/dev/null || true

export XDG_RUNTIME_DIR="$CHROME_RUNTIME_DIR"
export HOME="$CHROME_HOME_DIR"
export TMPDIR="$TMPDIR_DIR"
export BROWSER=none
export CI=1

cd "$ROOT_DIR"
exec npx expo export -p web
