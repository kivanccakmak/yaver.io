#!/bin/bash

# Prepare a filesystem root for Xcode build artifacts.
#
# External FAT/exFAT media can have plenty of capacity while still being
# unusable by Xcode because those filesystems cannot represent the symlinks
# produced by native dependency builds. Probe that operation before a build,
# not the volume label or filesystem inventory.
apple_detect_artifact_root() {
  local volumes_root="${1:-/Volumes}"
  local child="${2:-yaver-apple}"
  local marker volume found=""

  for marker in "$volumes_root"/*/.yaver-artifact-volume; do
    [ -f "$marker" ] || continue
    volume="${marker%/.yaver-artifact-volume}"
    if [ -n "$found" ]; then
      echo "ERROR: more than one marked Apple artifact volume is attached:" >&2
      echo "       $found" >&2
      echo "       $volume" >&2
      echo "       Unmount extras or set YAVER_IOS_ARTIFACT_ROOT explicitly." >&2
      return 1
    fi
    found="$volume"
  done

  [ -n "$found" ] && printf '%s/%s\n' "$found" "$child"
}

apple_prepare_artifact_root() {
  local requested="${1:-/tmp}"

  case "$requested" in
    /*) ;;
    *)
      echo "ERROR: Apple artifact root must be an absolute path; got '$requested'." >&2
      return 1
      ;;
  esac
  if [ "$requested" = "/" ]; then
    echo "ERROR: refusing to use the filesystem root as the Apple artifact root." >&2
    return 1
  fi
  if ! mkdir -p "$requested"; then
    echo "ERROR: could not create Apple artifact root: $requested" >&2
    return 1
  fi

  local probe
  if ! probe="$(mktemp -d "$requested/.yaver-apple-artifacts.XXXXXX")"; then
    echo "ERROR: Apple artifact root is not writable: $requested" >&2
    return 1
  fi
  touch "$probe/target"
  if ! ln -s target "$probe/link" 2>/dev/null || [ ! -L "$probe/link" ]; then
    find "$probe" -depth -delete 2>/dev/null || true
    echo "ERROR: Apple artifact root cannot create symlinks: $requested" >&2
    echo "       Xcode build artifacts require APFS/HFS+ semantics; FAT/exFAT media is not usable directly." >&2
    return 1
  fi
  find "$probe" -depth -delete

  APPLE_ARTIFACT_ROOT="$(cd "$requested" && pwd -P)"
  export APPLE_ARTIFACT_ROOT
}
