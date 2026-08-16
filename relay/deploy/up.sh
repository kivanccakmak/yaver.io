#!/usr/bin/env bash
set -euo pipefail

# Deploy yaver-relay to a Hetzner VPS
#
# Usage:
#   ./deploy/up.sh <server-ip>                    # Atomic binary deploy (default)
#   SSH_KEY=~/.ssh/key ./deploy/up.sh <server-ip> # Select an operations key
#   ./deploy/up.sh <server-ip> --docker           # Legacy Docker deploy
#   ./deploy/up.sh <server-ip> --build-only       # Just build locally
#
# Prerequisites:
#   - SSH access to the server (root or sudo)
#   - For binary: Go 1.22+ locally
#   - For docker: Docker on the server

SERVER="${1:?Usage: $0 <server-ip> [--docker|--build-only]}"
MODE="${2:---binary}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_URL="https://github.com/yaver-io/yaver.io.git"

if [[ "$SERVER" == *@* ]]; then
  TARGET="$SERVER"
else
  TARGET="${SSH_USER:-root}@${SERVER}"
fi
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2)
SCP_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)
if [[ -n "${SSH_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$SSH_KEY")
  SCP_ARGS+=(-i "$SSH_KEY")
fi

detect_remote_goarch() {
  local machine
  machine="$(ssh "${SSH_ARGS[@]}" "$TARGET" 'uname -m')"
  case "$machine" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Unsupported remote architecture: $machine" >&2
      return 1
      ;;
  esac
}

case "$MODE" in
  --docker)
    echo "=== Docker deploy to $SERVER ==="
    echo ""
    echo "  Cloning relay/ directory only (sparse checkout)..."

    ssh "${SSH_ARGS[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail

# Install Docker if missing
if ! command -v docker &>/dev/null; then
    echo "  Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

# Sparse checkout — only get relay/ directory
DEPLOY_DIR="/opt/yaver-relay"
rm -rf "\$DEPLOY_DIR"
mkdir -p "\$DEPLOY_DIR"
cd "\$DEPLOY_DIR"

git init
git remote add origin ${REPO_URL}
git sparse-checkout init
git sparse-checkout set relay
git pull origin main

cd relay

# Build and start with Docker Compose
if command -v docker-compose &>/dev/null; then
    docker-compose up -d --build
elif docker compose version &>/dev/null 2>&1; then
    docker compose up -d --build
else
    docker build -t yaver-relay .
    docker rm -f yaver-relay 2>/dev/null || true
    docker run -d --name yaver-relay \
        --restart unless-stopped \
        -p 4433:4433/udp \
        -p 8443:8443/tcp \
        yaver-relay
fi

# Open firewall ports
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 4433/udp comment "yaver-relay QUIC" 2>/dev/null || true
    ufw allow 8443/tcp comment "yaver-relay HTTP" 2>/dev/null || true
fi

echo ""
echo "=== Relay running (Docker) ==="
echo "  Health: curl http://localhost:8443/health"
docker ps --filter name=yaver-relay --format "table {{.Status}}\t{{.Ports}}"
REMOTE
    ;;

  --build-only)
    TARGET_GOARCH="${TARGET_GOARCH:-amd64}"
    echo "=== Building yaver-relay for linux/${TARGET_GOARCH} ==="
    cd "$RELAY_DIR"
    BUILD_OUTPUT="${BUILD_OUTPUT:-yaver-relay-linux-${TARGET_GOARCH}}"
    GOOS=linux GOARCH="${TARGET_GOARCH}" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$BUILD_OUTPUT" .
    echo "  Built: $BUILD_OUTPUT ($(du -h "$BUILD_OUTPUT" | cut -f1))"
    ;;

  --binary|*)
    echo "=== Binary deploy to $SERVER ==="
    cd "$RELAY_DIR"
    TARGET_GOARCH="$(detect_remote_goarch)"

    LOCAL_STAGE="$(mktemp -d)"
    trap 'rm -rf "$LOCAL_STAGE"' EXIT
    BINARY="$LOCAL_STAGE/yaver-relay"
    REMOTE_STAGE="/var/tmp/yaver-relay-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$"

    echo "  Building for linux/${TARGET_GOARCH}..."
    GOOS=linux GOARCH="${TARGET_GOARCH}" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$BINARY" .
    EXPECTED_SHA="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
    echo "  Built: $(du -h "$BINARY" | cut -f1), sha256 ${EXPECTED_SHA:0:12}…"

    echo "  Staging binary and bounded service supervision..."
    ssh "${SSH_ARGS[@]}" "$TARGET" "install -d -m 0700 '$REMOTE_STAGE'"
    scp "${SCP_ARGS[@]}" \
      "$BINARY" \
      deploy/yaver-relay.service \
      deploy/yaver-relay-timecheck \
      deploy/yaver-relay-watchdog \
      deploy/yaver-relay-watchdog.service \
      deploy/yaver-relay-watchdog.timer \
      deploy/yaver-relay-network.conf \
      "$TARGET:$REMOTE_STAGE/"

    # The remote transaction keeps an exact rollback set, atomically replaces
    # the binary, verifies the units, and requires both systemd-active and a
    # bounded local health response. It never reboots the host.
    ssh "${SSH_ARGS[@]}" "$TARGET" bash -s -- "$REMOTE_STAGE" "$EXPECTED_SHA" <<'REMOTE'
set -Eeuo pipefail
stage="$1"
expected_sha="$2"
[[ "$stage" == /var/tmp/yaver-relay-deploy-* ]] || { echo "unsafe stage path" >&2; exit 1; }
[[ -d "$stage" ]] || { echo "missing deploy stage" >&2; exit 1; }

actual_sha="$(sha256sum "$stage/yaver-relay" | awk '{print $1}')"
[[ "$actual_sha" == "$expected_sha" ]] || { echo "binary checksum mismatch" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/yaver-relay-backups/${stamp}-binary-deploy"
install -d -m 0700 "$backup/files" /usr/local/libexec /etc/systemd/system
paths=(
  usr/local/bin/yaver-relay
  usr/local/libexec/yaver-relay-timecheck
  usr/local/libexec/yaver-relay-watchdog
  etc/systemd/system/yaver-relay.service
  etc/systemd/system/yaver-relay-watchdog.service
  etc/systemd/system/yaver-relay-watchdog.timer
  etc/sysctl.d/60-yaver-relay-network.conf
)
for relative in "${paths[@]}"; do
  if [[ -e "/$relative" ]]; then
    install -d -m 0700 "$backup/files/$(dirname "$relative")"
    cp -a "/$relative" "$backup/files/$relative"
  else
    printf '%s\n' "$relative" >>"$backup/absent"
  fi
done
printf '%s  yaver-relay\n' "$actual_sha" >"$backup/SHA256SUMS"
{
  sysctl -n net.core.rmem_max
  sysctl -n net.core.wmem_max
  sysctl -n net.core.netdev_max_backlog
} >"$backup/sysctl-before"

rollback() {
  echo "  Health verification failed; restoring $backup" >&2
  systemctl disable --now yaver-relay-watchdog.timer >/dev/null 2>&1 || true
  for relative in "${paths[@]}"; do
    if [[ -e "$backup/files/$relative" ]]; then
      install -d -m 0755 "/$(dirname "$relative")"
      cp -a "$backup/files/$relative" "/$relative"
    elif [[ -f "$backup/absent" ]] && grep -Fxq "$relative" "$backup/absent"; then
      rm -f "/$relative"
    fi
  done

  if [[ -f "$backup/sysctl-before" ]]; then
    mapfile -t old_sysctl <"$backup/sysctl-before"
    sysctl -q -w "net.core.rmem_max=${old_sysctl[0]}" || true
    sysctl -q -w "net.core.wmem_max=${old_sysctl[1]}" || true
    sysctl -q -w "net.core.netdev_max_backlog=${old_sysctl[2]}" || true
  fi
  systemctl daemon-reload
  systemctl restart yaver-relay.service >/dev/null 2>&1 || true
}
trap 'rollback; rm -rf "$stage"' ERR

install -m 0755 "$stage/yaver-relay" /usr/local/bin/yaver-relay.new
mv -f /usr/local/bin/yaver-relay.new /usr/local/bin/yaver-relay
install -m 0755 "$stage/yaver-relay-timecheck" /usr/local/libexec/yaver-relay-timecheck
install -m 0755 "$stage/yaver-relay-watchdog" /usr/local/libexec/yaver-relay-watchdog
install -m 0644 "$stage/yaver-relay.service" /etc/systemd/system/yaver-relay.service
install -m 0644 "$stage/yaver-relay-watchdog.service" /etc/systemd/system/yaver-relay-watchdog.service
install -m 0644 "$stage/yaver-relay-watchdog.timer" /etc/systemd/system/yaver-relay-watchdog.timer
install -D -m 0644 "$stage/yaver-relay-network.conf" /etc/sysctl.d/60-yaver-relay-network.conf
sysctl --load /etc/sysctl.d/60-yaver-relay-network.conf

systemd-analyze verify \
  /etc/systemd/system/yaver-relay.service \
  /etc/systemd/system/yaver-relay-watchdog.service \
  /etc/systemd/system/yaver-relay-watchdog.timer
systemctl daemon-reload
systemctl enable yaver-relay.service yaver-relay-watchdog.timer >/dev/null
systemctl restart yaver-relay.service

healthy=false
for _ in $(seq 1 30); do
  if systemctl is-active --quiet yaver-relay.service && \
     curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
       http://127.0.0.1:8080/health | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]]
systemctl start yaver-relay-watchdog.timer

trap - ERR
rm -rf "$stage"
echo "  Rollback: $backup"
systemctl --no-pager --full status yaver-relay.service | sed -n '1,12p'
systemctl --no-pager --full status yaver-relay-watchdog.timer | sed -n '1,8p'
REMOTE
    ;;
esac

echo ""
echo "=== Done ==="
echo ""
echo "Connect your agent:"
echo "  yaver serve --relay=${SERVER}:4433"
echo ""
echo "Mobile URL pattern:"
echo "  https://${SERVER}/d/<deviceId>/tasks (through your authenticated reverse proxy)"
