#!/bin/bash
# Sourceable helper: pick the next CFBundleVersion for an App Store Connect
# platform, bumped from max(ASC-highest, local) + 1.
#
# WHY THIS EXISTS (2026-07-25). deploy-testflight.sh has bumped iOS builds from
# the ASC max since 2026-07-19, because bumping from the LOCAL plist collides
# whenever ASC is ahead — and every collision burns a slot of the ~15-20/day
# TestFlight cap. deploy-tvos.sh and deploy-visionos.sh never got that fix: both
# fall back to CURRENT_PROJECT_VERSION from their project.yml, which is the
# literal string "1". So the default `--upload` invocation of either script runs
# a full archive (minutes of CPU) and can only ever be REJECTED at the far end
# as a duplicate build number. Shipping tvOS on 2026-07-25 needed
# TVOS_BUILD_NUMBER=272 typed by hand, discovered by querying the API manually;
# visionOS needed a build above 2607160313 the same way. An operator who does
# not already know that number gets a guaranteed-failing deploy with no hint
# that the number was the problem.
#
# scripts/asc-max-build.py has ALREADY been platform-aware (ASC_PLATFORM) since
# the comment about "a visionOS/tvOS build with a date-based number poisons an
# iOS bump" was written. The seam existed; the two callers simply never used it.
# This file is that wiring, in ONE place, so the next surface (macOS, watchOS if
# it ever gets its own channel) inherits it instead of re-deriving it.
#
# Contract, matching asc-max-build.py: BEST-EFFORT but never SILENT. If the
# lookup cannot run, say why on stderr and fall back to local+1; stdout only
# ever carries the number.
#
# Usage:
#   . "$(dirname "$0")/asc-next-build.sh"
#   BUILD=$(asc_next_build TV_OS 1)

# Several python3s live on these boxes (/usr/local, /opt/homebrew, Xcode's) and
# which one answers `python3` depends on PATH order. Pick one that can actually
# do the query rather than the one that happens to be first — the exact trap
# that made the iOS lookup return nothing for a whole day on 2026-07-20.
asc_pick_python() {
  local cand
  for cand in "${YAVER_PYTHON:-}" python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
    [ -n "$cand" ] || continue
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import jwt, requests' >/dev/null 2>&1; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

# asc_next_build <ASC_PLATFORM> [local_current]
#   ASC_PLATFORM: IOS | TV_OS | VISION_OS | MAC_OS
#   local_current: build number from the local project spec, used as the floor
# Echoes the build number to use. Never fails the caller.
asc_next_build() {
  local platform="$1"
  local local_current="${2:-0}"
  local here py asc_max helper

  # BASH_SOURCE is a bash-ism. This repo's deploy scripts are #!/bin/bash so it
  # is populated there, but the login shell here is zsh, where it expands to
  # nothing — `dirname ""` is ".", so a sourced-from-repo-root test resolved the
  # helper to $ROOT/asc-max-build.py, missed it, and reported "max unreadable".
  # That is a false cause: the credentials and network were fine, the script
  # just could not find its own sibling. Fall back to $ROOT/scripts (every
  # caller sets ROOT) and, failing that, say the real thing.
  here="${BASH_SOURCE[0]:-}"
  if [ -n "$here" ]; then
    here="$(cd "$(dirname "$here")" && pwd)"
  elif [ -n "${ROOT:-}" ] && [ -d "$ROOT/scripts" ]; then
    here="$ROOT/scripts"
  else
    here="$(pwd)"
  fi
  helper="$here/asc-max-build.py"

  case "$local_current" in
    ''|*[!0-9]*) local_current=0 ;;
  esac

  if [ ! -f "$helper" ]; then
    echo "asc-next-build: cannot find asc-max-build.py next to this script (looked in" >&2
    echo "                $here). The $platform build number will be bumped from local" >&2
    echo "                $local_current, which is REJECTED as a duplicate whenever ASC is" >&2
    echo "                ahead. This is a PATH problem, not a credentials problem." >&2
    echo "$((local_current + 1))"
    return 0
  fi

  if ! py="$(asc_pick_python)"; then
    echo "asc-next-build: no python3 here can import PyJWT+requests, so the App Store" >&2
    echo "                Connect $platform build-number lookup CANNOT run. Falling back to" >&2
    echo "                local+1, which is REJECTED as a duplicate whenever ASC is ahead" >&2
    echo "                (and burns a slot of the ~15-20/day TestFlight cap)." >&2
    echo "                Fix: $(command -v python3 || echo python3) -m pip install --break-system-packages PyJWT cryptography requests" >&2
    echo "                Or pass the number explicitly, e.g. TVOS_BUILD_NUMBER=<n>." >&2
    echo "$((local_current + 1))"
    return 0
  fi

  # stderr is deliberately NOT swallowed: asc-max-build.py explains every
  # degraded lookup there, and hiding that is what let it fail silently before.
  asc_max="$(ASC_PLATFORM="$platform" \
    APP_STORE_KEY_PATH="${APP_STORE_KEY_PATH:-}" \
    APP_STORE_KEY_ID="${APP_STORE_KEY_ID:-}" \
    APP_STORE_KEY_ISSUER="${APP_STORE_KEY_ISSUER:-}" \
    "$py" "$helper" || echo "")"

  case "$asc_max" in
    ''|*[!0-9]*) asc_max="" ;;
  esac

  if [ -n "$asc_max" ] && [ "$asc_max" -ge "$local_current" ]; then
    echo "asc-next-build: $platform highest on ASC is $asc_max (local $local_current) — using $((asc_max + 1))" >&2
    echo "$((asc_max + 1))"
  else
    [ -z "$asc_max" ] && \
      echo "asc-next-build: $platform max unreadable (reason above) — bumping from local $local_current" >&2
    echo "$((local_current + 1))"
  fi
}
