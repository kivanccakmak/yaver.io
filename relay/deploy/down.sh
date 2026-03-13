#!/usr/bin/env bash
set -euo pipefail

# Stop yaver-relay on a Hetzner VPS
#
# Usage:
#   ./deploy/down.sh <server-ip>           # Stop service
#   ./deploy/down.sh <server-ip> --purge   # Stop and remove everything

SERVER="${1:?Usage: $0 <server-ip> [--purge]}"
PURGE="${2:-}"

echo "=== Stopping yaver-relay on $SERVER ==="

ssh "root@${SERVER}" bash -s -- "$PURGE" <<'REMOTE'
PURGE="$1"

# Stop systemd service
systemctl stop yaver-relay 2>/dev/null || true
systemctl disable yaver-relay 2>/dev/null || true
echo "  Systemd service stopped"

# Stop Docker container
docker stop yaver-relay 2>/dev/null || true
docker rm yaver-relay 2>/dev/null || true
echo "  Docker container stopped"

if [ "$PURGE" = "--purge" ]; then
    rm -f /usr/local/bin/yaver-relay
    rm -f /etc/systemd/system/yaver-relay.service
    systemctl daemon-reload 2>/dev/null || true

    # Remove Docker image
    docker rmi yaver-relay 2>/dev/null || true

    # Remove sparse checkout
    rm -rf /opt/yaver-relay

    # Remove firewall rules
    if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
        ufw delete allow 4433/udp 2>/dev/null || true
        ufw delete allow 8443/tcp 2>/dev/null || true
    fi

    echo "  All files removed"
else
    echo "  (use --purge to also remove binary, Docker image, and files)"
fi

echo ""
echo "=== Relay stopped ==="
REMOTE
