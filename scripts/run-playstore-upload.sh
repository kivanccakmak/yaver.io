#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The Mac release host can have several python3 installations. Probe the
# operation we need instead of trusting whichever interpreter happens to be
# first on PATH. If none can import the Play SDK, create an isolated cached
# environment so a release cannot fail after a successful 20-minute build.
for candidate in "${YAVER_PYTHON:-}" python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  [ -n "$candidate" ] || continue
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" -c 'import google.oauth2.service_account, googleapiclient.discovery' >/dev/null 2>&1; then
    exec "$candidate" "$ROOT/scripts/upload-playstore.py" "$@"
  fi
done

bootstrap_python=""
for candidate in python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" -m venv --help >/dev/null 2>&1; then
    bootstrap_python="$candidate"
    break
  fi
done

if [ -z "$bootstrap_python" ]; then
  echo "ERROR: Google Play upload requires Python with venv support; no usable interpreter was found." >&2
  exit 2
fi

cache_root="${XDG_CACHE_HOME:-${HOME}/.cache}/yaver"
venv="${YAVER_PLAYSTORE_VENV:-$cache_root/playstore-python}"
venv_python="$venv/bin/python"

if [ ! -x "$venv_python" ]; then
  echo "Preparing isolated Google Play upload environment at $venv ..."
  mkdir -p "$cache_root"
  "$bootstrap_python" -m venv "$venv"
fi

if ! "$venv_python" -c 'import google.oauth2.service_account, googleapiclient.discovery' >/dev/null 2>&1; then
  echo "Installing Google Play upload SDK into the isolated environment ..."
  # Python 3.11's bundled pip 23.2 can spend minutes backtracking through the
  # full Requests history against current Google SDK metadata. Upgrade the
  # isolated installer first; never mutate the system interpreter.
  "$venv_python" -m pip install --disable-pip-version-check --upgrade pip
  "$venv_python" -m pip install --disable-pip-version-check \
    google-auth google-auth-httplib2 google-api-python-client
fi

if ! "$venv_python" -c 'import google.oauth2.service_account, googleapiclient.discovery' >/dev/null 2>&1; then
  echo "ERROR: Google Play SDK installation completed but its imports still fail in $venv_python." >&2
  exit 2
fi

exec "$venv_python" "$ROOT/scripts/upload-playstore.py" "$@"
