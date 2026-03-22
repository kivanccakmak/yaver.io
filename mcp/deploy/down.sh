#!/usr/bin/env bash
set -euo pipefail

# Stop yaver-mcp on a VPS
#
# Usage:
#   ./deploy/down.sh <server-ip>           # Stop service
#   ./deploy/down.sh <server-ip> --purge   # Stop and remove everything

SERVER="${1:?Usage: $0 <server-ip> [--purge]}"
PURGE="${2:-}"

echo "=== Stopping yaver-mcp on $SERVER ==="

ssh "root@${SERVER}" bash -s -- "$PURGE" <<'REMOTE'
PURGE="$1"

# Stop systemd service
systemctl stop yaver-mcp 2>/dev/null || true
systemctl disable yaver-mcp 2>/dev/null || true
echo "  Systemd service stopped"

# Stop Docker container
docker stop yaver-mcp 2>/dev/null || true
docker rm yaver-mcp 2>/dev/null || true
echo "  Docker container stopped"

if [ "$PURGE" = "--purge" ]; then
    rm -f /usr/local/bin/yaver-mcp
    rm -f /etc/systemd/system/yaver-mcp.service
    rm -rf /var/lib/yaver-mcp
    systemctl daemon-reload 2>/dev/null || true
    docker rmi yaver-mcp 2>/dev/null || true
    rm -rf /opt/yaver-mcp

    if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
        ufw delete allow 18100/tcp 2>/dev/null || true
    fi

    echo "  All files removed"
else
    echo "  (use --purge to also remove binary, Docker image, and files)"
fi

echo ""
echo "=== MCP server stopped ==="
REMOTE
