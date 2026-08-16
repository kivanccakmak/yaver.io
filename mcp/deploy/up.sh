#!/usr/bin/env bash
set -euo pipefail

# Deploy yaver-mcp to a VPS
#
# Usage:
#   ./deploy/up.sh <server-ip>                    # Binary deploy (default)
#   ./deploy/up.sh <server-ip> --docker           # Docker deploy
#   ./deploy/up.sh <server-ip> --build-only       # Just build locally
#
# Prerequisites:
#   - SSH access to the server (root or sudo)
#   - For binary: Go 1.22+ locally
#   - For docker: Docker on the server

SERVER="${1:?Usage: $0 <server-ip> [--docker|--build-only]}"
MODE="${2:---binary}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_URL="https://github.com/kivanccakmak/yaver.io.git"

case "$MODE" in
  --docker)
    echo "=== Docker deploy to $SERVER ==="
    echo ""
    echo "  Cloning mcp/ directory only (sparse checkout)..."

    ssh "root@${SERVER}" bash -s <<REMOTE
set -euo pipefail

# Install Docker if missing
if ! command -v docker &>/dev/null; then
    echo "  Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

# Sparse checkout — only get mcp/ directory
DEPLOY_DIR="/opt/yaver-mcp"
rm -rf "\$DEPLOY_DIR"
mkdir -p "\$DEPLOY_DIR"
cd "\$DEPLOY_DIR"

git init
git remote add origin ${REPO_URL}
git sparse-checkout init
git sparse-checkout set mcp
git pull origin main

cd mcp

# Build and start with Docker Compose
if command -v docker-compose &>/dev/null; then
    docker-compose up -d --build
elif docker compose version &>/dev/null 2>&1; then
    docker compose up -d --build
else
    docker build -t yaver-mcp .
    docker rm -f yaver-mcp 2>/dev/null || true
    docker run -d --name yaver-mcp \
        --restart unless-stopped \
        -p 18100:18100/tcp \
        yaver-mcp
fi

# Open firewall port
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 18100/tcp comment "yaver-mcp HTTP" 2>/dev/null || true
fi

echo ""
echo "=== MCP server running (Docker) ==="
echo "  Health: curl http://localhost:18100/health"
docker ps --filter name=yaver-mcp --format "table {{.Status}}\t{{.Ports}}"
REMOTE
    ;;

  --build-only)
    echo "=== Building yaver-mcp for linux/amd64 ==="
    cd "$MCP_DIR"
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o yaver-mcp-linux-amd64 .
    echo "  Built: yaver-mcp-linux-amd64 ($(du -h yaver-mcp-linux-amd64 | cut -f1))"
    ;;

  --binary|*)
    echo "=== Binary deploy to $SERVER ==="
    cd "$MCP_DIR"

    echo "  Building for linux/amd64..."
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o yaver-mcp-linux-amd64 .
    echo "  Built: $(du -h yaver-mcp-linux-amd64 | cut -f1)"

    echo "  Copying binary..."
    scp yaver-mcp-linux-amd64 "root@${SERVER}:/usr/local/bin/yaver-mcp"

    echo "  Copying systemd unit..."
    scp deploy/yaver-mcp.service "root@${SERVER}:/etc/systemd/system/yaver-mcp.service"

    echo "  Starting service..."
    ssh "root@${SERVER}" bash -s <<'REMOTE'
chmod +x /usr/local/bin/yaver-mcp
mkdir -p /var/lib/yaver-mcp/plugins
systemctl daemon-reload
systemctl enable yaver-mcp
systemctl restart yaver-mcp
sleep 2

# Open firewall port
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 18100/tcp comment "yaver-mcp HTTP" 2>/dev/null || true
fi

echo ""
echo "=== Service status ==="
systemctl status yaver-mcp --no-pager -l || true
echo ""
echo "=== MCP server running ==="
echo "  Logs:    journalctl -u yaver-mcp -f"
echo "  Status:  systemctl status yaver-mcp"
echo "  Stop:    systemctl stop yaver-mcp"
echo "  Health:  curl http://localhost:18100/health"
REMOTE

    rm -f yaver-mcp-linux-amd64
    ;;
esac

echo ""
echo "=== Done ==="
echo ""
echo "Connect from your agent:"
echo "  yaver acl add mcp http://${SERVER}:18100/mcp --auth <password>"
echo ""
echo "Or add to Claude Desktop:"
echo '  {"mcpServers":{"yaver-mcp":{"url":"http://'${SERVER}':18100/mcp","headers":{"Authorization":"Bearer <password>"}}}}'
