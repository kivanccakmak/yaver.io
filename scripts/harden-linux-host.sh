#!/usr/bin/env bash
set -euo pipefail

# Idempotent baseline for a small Ubuntu Yaver host. Run as root on the agent
# machine. It does not delete data or change SSH configuration.
SWAP_FILE="${YAVER_SWAP_FILE:-/swapfile}"
SWAP_SIZE="${YAVER_SWAP_SIZE:-2G}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo $0)." >&2
  exit 1
fi

if command -v timedatectl >/dev/null 2>&1; then
  timedatectl set-ntp true || true
  systemctl enable --now systemd-timesyncd.service 2>/dev/null || true
fi

if ! swapon --show --noheadings 2>/dev/null | grep -q .; then
  if [[ ! -e "$SWAP_FILE" ]]; then
    fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
  grep -qF "$SWAP_FILE none swap sw 0 0" /etc/fstab || \
    echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
fi

cat >/etc/sysctl.d/99-yaver-host.conf <<'EOF'
# Leave room for the kernel and relay/agent supervision before OOM.
vm.swappiness=10
vm.overcommit_memory=0
vm.panic_on_oom=0
fs.file-max=2097152
EOF
sysctl --system >/dev/null

echo "NTP: $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
echo "Swap:"
swapon --show || true
echo "Host hardening applied."
