#!/bin/bash
# Yaver Relay Server Setup Script
# Automates: Docker + nginx + Let's Encrypt + relay deployment
#
# Usage:
#   ./scripts/setup-relay.sh <server-ip> <domain> [options]
#   ./scripts/setup-relay.sh <server-ip> --no-domain [options]
#
# Options:
#   --password <pass>    Relay password (or prompted interactively)
#   --no-domain          Skip HTTPS/nginx setup (use IP:port directly)
#   --quic-port <port>   QUIC port (default: 4433)
#   --http-port <port>   HTTP port (default: 8443)
#   --help               Show usage
#
# Examples:
#   ./scripts/setup-relay.sh 1.2.3.4 relay.example.com --password mysecret
#   ./scripts/setup-relay.sh 1.2.3.4 --no-domain --password mysecret

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

# ── Defaults ────────────────────────────────────────────────────────────────

SERVER=""
DOMAIN=""
NO_DOMAIN=false
RELAY_PASSWORD=""
QUIC_PORT=4433
HTTP_PORT=8443

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
NGINX_TEMPLATE="${REPO_ROOT}/relay/deploy/nginx-relay.conf"
REPO_URL="https://github.com/kivanccakmak/yaver.io.git"

# ── Usage ───────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
${BOLD}Yaver Relay Server Setup${NC}

Automates Docker + nginx + Let's Encrypt + relay deployment on a VPS.

${BOLD}Usage:${NC}
  $0 <server-ip> <domain> [options]
  $0 <server-ip> --no-domain [options]

${BOLD}Options:${NC}
  --password <pass>    Relay password (or prompted interactively)
  --no-domain          Skip HTTPS/nginx setup (use IP:port directly)
  --quic-port <port>   QUIC port (default: 4433)
  --http-port <port>   HTTP port (default: 8443)
  --help               Show usage

${BOLD}Examples:${NC}
  $0 1.2.3.4 relay.example.com --password mysecret
  $0 1.2.3.4 --no-domain --password mysecret
EOF
    exit 0
}

# ── Parse args ──────────────────────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
    usage
fi

# Check for --help anywhere in args
for arg in "$@"; do
    if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
        usage
    fi
done

# First positional arg is always server IP
SERVER="$1"
shift

# Second positional arg is domain or --no-domain or an option
if [[ $# -gt 0 ]]; then
    case "$1" in
        --no-domain)
            NO_DOMAIN=true
            shift
            ;;
        --password|--quic-port|--http-port|--help)
            # No domain provided, treat as no-domain
            NO_DOMAIN=true
            ;;
        -*)
            NO_DOMAIN=true
            ;;
        *)
            DOMAIN="$1"
            shift
            ;;
    esac
fi

# Parse remaining options
while [[ $# -gt 0 ]]; do
    case "$1" in
        --password)
            RELAY_PASSWORD="${2:?--password requires a value}"
            shift 2
            ;;
        --no-domain)
            NO_DOMAIN=true
            shift
            ;;
        --quic-port)
            QUIC_PORT="${2:?--quic-port requires a value}"
            shift 2
            ;;
        --http-port)
            HTTP_PORT="${2:?--http-port requires a value}"
            shift 2
            ;;
        --help)
            usage
            ;;
        *)
            err "Unknown option: $1"
            echo ""
            usage
            ;;
    esac
done

# ── Validate ────────────────────────────────────────────────────────────────

if [[ -z "$SERVER" ]]; then
    err "Server IP is required"
    exit 1
fi

if [[ "$NO_DOMAIN" == false && -z "$DOMAIN" ]]; then
    err "Domain is required (or use --no-domain to skip HTTPS setup)"
    exit 1
fi

# Prompt for password if not provided
if [[ -z "$RELAY_PASSWORD" ]]; then
    echo -en "${YELLOW}Relay password (leave empty for none): ${NC}"
    read -r RELAY_PASSWORD
fi

# ── Pre-flight checks ──────────────────────────────────────────────────────

step "Pre-flight checks"

info "Testing SSH connection to root@${SERVER}..."
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "root@${SERVER}" "echo ok" &>/dev/null; then
    err "Cannot SSH to root@${SERVER}"
    err "Ensure SSH key is configured: ssh-copy-id root@${SERVER}"
    exit 1
fi
ok "SSH connection to ${SERVER}"

if [[ "$NO_DOMAIN" == false ]]; then
    if [[ ! -f "$NGINX_TEMPLATE" ]]; then
        err "Nginx template not found at ${NGINX_TEMPLATE}"
        exit 1
    fi
    ok "Nginx template found"
fi

# ── Step 1: Install Docker ──────────────────────────────────────────────────

step "Step 1: Install Docker"

ssh "root@${SERVER}" bash -s <<'REMOTE_DOCKER'
set -euo pipefail

if command -v docker &>/dev/null; then
    echo "Docker already installed: $(docker --version)"
else
    echo "Installing Docker..."
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-plugin
    systemctl enable --now docker
    echo "Docker installed: $(docker --version)"
fi

# Ensure docker compose plugin is available
if ! docker compose version &>/dev/null 2>&1; then
    echo "Installing docker-compose-plugin..."
    apt-get install -y -qq docker-compose-plugin
fi
REMOTE_DOCKER

ok "Docker ready"

# ── Step 2: HTTPS setup (nginx + certbot) ───────────────────────────────────

if [[ "$NO_DOMAIN" == false ]]; then
    step "Step 2: HTTPS setup (nginx + Let's Encrypt)"

    info "Installing nginx and certbot..."
    ssh "root@${SERVER}" bash -s <<'REMOTE_NGINX_INSTALL'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx
REMOTE_NGINX_INSTALL
    ok "nginx and certbot installed"

    info "Obtaining Let's Encrypt certificate for ${DOMAIN}..."
    ssh "root@${SERVER}" bash -s -- "$DOMAIN" <<'REMOTE_CERT'
set -euo pipefail
DOMAIN="$1"

# Stop nginx temporarily so certbot can use port 80
systemctl stop nginx 2>/dev/null || true

# Get certificate (standalone mode — certbot runs its own HTTP server)
if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    echo "Certificate already exists for ${DOMAIN}, attempting renewal..."
    certbot renew --cert-name "${DOMAIN}" --non-interactive || true
else
    certbot certonly --standalone \
        -d "${DOMAIN}" \
        --non-interactive \
        --agree-tos \
        -m "admin@${DOMAIN}" \
        --no-eff-email
fi

echo "Certificate ready for ${DOMAIN}"
REMOTE_CERT
    ok "SSL certificate obtained"

    info "Configuring nginx..."
    # Generate nginx config from template
    NGINX_CONF=$(sed -e "s/DOMAIN/${DOMAIN}/g" -e "s/HTTP_PORT/${HTTP_PORT}/g" "$NGINX_TEMPLATE")

    # Write nginx config and enable
    echo "$NGINX_CONF" | ssh "root@${SERVER}" bash -s -- "$DOMAIN" <<'REMOTE_NGINX_CONF'
set -euo pipefail
DOMAIN="$1"

# Read nginx config from stdin
CONF=$(cat)

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Write relay site config
echo "$CONF" > "/etc/nginx/sites-available/yaver-relay"
ln -sf "/etc/nginx/sites-available/yaver-relay" "/etc/nginx/sites-enabled/yaver-relay"

# Test and start nginx
nginx -t
systemctl enable nginx
systemctl start nginx

echo "nginx configured and running for ${DOMAIN}"
REMOTE_NGINX_CONF
    ok "nginx configured for ${DOMAIN}"

    # Set up certbot auto-renewal with nginx reload
    ssh "root@${SERVER}" bash -s <<'REMOTE_CERTBOT_HOOK'
set -euo pipefail
# Ensure certbot renewal reloads nginx
if [[ ! -f /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh ]]; then
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/bash
systemctl reload nginx
HOOK
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    echo "Certbot renewal hook installed"
fi
# Enable certbot timer for auto-renewal
systemctl enable --now certbot.timer 2>/dev/null || true
REMOTE_CERTBOT_HOOK
    ok "Certbot auto-renewal configured"
else
    step "Step 2: Skipping HTTPS setup (--no-domain)"
    warn "No domain configured. Relay will be accessible at http://${SERVER}:${HTTP_PORT}"
fi

# ── Step 3: Deploy relay ────────────────────────────────────────────────────

step "Step 3: Deploy relay service"

info "Setting up relay at /opt/yaver-relay/..."
ssh "root@${SERVER}" bash -s -- "$QUIC_PORT" "$HTTP_PORT" "$RELAY_PASSWORD" "$REPO_URL" <<'REMOTE_RELAY'
set -euo pipefail

QUIC_PORT="$1"
HTTP_PORT="$2"
RELAY_PASSWORD="$3"
REPO_URL="$4"
DEPLOY_DIR="/opt/yaver-relay"

# Sparse checkout of relay directory
rm -rf "${DEPLOY_DIR}"
mkdir -p "${DEPLOY_DIR}"
cd "${DEPLOY_DIR}"

git init -q
git remote add origin "${REPO_URL}"
git sparse-checkout init
git sparse-checkout set relay
git pull -q origin main

cd relay

# Write .env file
cat > .env <<ENVFILE
RELAY_PASSWORD=${RELAY_PASSWORD}
ENVFILE
chmod 600 .env

# Write docker-compose.yml with correct ports
cat > docker-compose.override.yml <<COMPOSEFILE
services:
  relay:
    ports:
      - "${QUIC_PORT}:4433/udp"
      - "${HTTP_PORT}:8443/tcp"
COMPOSEFILE

# Pull, build, and start
echo "Building and starting relay container..."
docker compose up -d --build

# Wait for container to be healthy
echo "Waiting for relay to become healthy..."
for i in $(seq 1 30); do
    if curl -sf "http://localhost:${HTTP_PORT}/health" &>/dev/null; then
        echo "Relay is healthy!"
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "WARNING: Health check timed out after 30s"
        docker compose logs --tail=20
        exit 1
    fi
    sleep 1
done

REMOTE_RELAY
ok "Relay container running"

# ── Step 4: Firewall ────────────────────────────────────────────────────────

step "Step 4: Firewall configuration"

ssh "root@${SERVER}" bash -s -- "$QUIC_PORT" "$HTTP_PORT" "$NO_DOMAIN" <<'REMOTE_FW'
set -euo pipefail

QUIC_PORT="$1"
HTTP_PORT="$2"
NO_DOMAIN="$3"

if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    echo "UFW is active, opening ports..."
    ufw allow 22/tcp comment "SSH" 2>/dev/null || true
    ufw allow "${QUIC_PORT}/udp" comment "yaver-relay QUIC" 2>/dev/null || true

    if [[ "$NO_DOMAIN" == "false" ]]; then
        ufw allow 443/tcp comment "HTTPS (nginx)" 2>/dev/null || true
        ufw allow 80/tcp comment "HTTP redirect" 2>/dev/null || true
    else
        ufw allow "${HTTP_PORT}/tcp" comment "yaver-relay HTTP" 2>/dev/null || true
    fi

    echo "Firewall rules updated:"
    ufw status numbered
else
    echo "UFW not active, skipping firewall configuration"
fi
REMOTE_FW
ok "Firewall configured"

# ── Step 5: Health check ────────────────────────────────────────────────────

step "Step 5: Final health check"

HEALTH_OUTPUT=$(ssh "root@${SERVER}" "curl -sf http://localhost:${HTTP_PORT}/health" 2>/dev/null || echo "FAILED")

if [[ "$HEALTH_OUTPUT" == "FAILED" ]]; then
    err "Health check failed! Check logs with: ssh root@${SERVER} 'cd /opt/yaver-relay/relay && docker compose logs'"
    exit 1
fi

ok "Health check passed: ${HEALTH_OUTPUT}"

# ── Summary ─────────────────────────────────────────────────────────────────

step "Setup Complete"

if [[ "$NO_DOMAIN" == false ]]; then
    RELAY_HTTP_URL="https://${DOMAIN}"
else
    RELAY_HTTP_URL="http://${SERVER}:${HTTP_PORT}"
fi

RELAY_QUIC_ADDR="${SERVER}:${QUIC_PORT}"

echo ""
echo -e "${BOLD}Relay Server Summary${NC}"
echo -e "  ${CYAN}HTTP URL:${NC}      ${RELAY_HTTP_URL}"
echo -e "  ${CYAN}QUIC Address:${NC}  ${RELAY_QUIC_ADDR}"
if [[ -n "$RELAY_PASSWORD" ]]; then
echo -e "  ${CYAN}Password:${NC}      ${RELAY_PASSWORD}"
fi
echo ""

echo -e "${BOLD}Useful Commands${NC}"
echo -e "  ${CYAN}Health:${NC}   curl ${RELAY_HTTP_URL}/health"
echo -e "  ${CYAN}Tunnels:${NC}  curl ${RELAY_HTTP_URL}/tunnels"
echo -e "  ${CYAN}Logs:${NC}     ssh root@${SERVER} 'cd /opt/yaver-relay/relay && docker compose logs -f'"
echo -e "  ${CYAN}Restart:${NC}  ssh root@${SERVER} 'cd /opt/yaver-relay/relay && docker compose restart'"
echo -e "  ${CYAN}Stop:${NC}     ssh root@${SERVER} 'cd /opt/yaver-relay/relay && docker compose down'"
echo ""

# Determine a short ID from the domain or IP
if [[ "$NO_DOMAIN" == false ]]; then
    RELAY_ID=$(echo "$DOMAIN" | cut -d. -f1)
    REGION="custom"
else
    RELAY_ID="relay-$(echo "$SERVER" | tr '.' '-' | tail -c 8)"
    REGION="custom"
fi

echo -e "${BOLD}Add to Convex Platform Config${NC}"
echo -e "  Run this to register the relay (adjust id/region as needed):"
echo ""
echo -e "  ${CYAN}cd backend && npx convex run platformConfig:set '{\"key\":\"relay_servers\",\"value\":\"[...,{\\\"id\\\":\\\"${RELAY_ID}\\\",\\\"quicAddr\\\":\\\"${RELAY_QUIC_ADDR}\\\",\\\"httpUrl\\\":\\\"${RELAY_HTTP_URL}\\\",\\\"region\\\":\\\"${REGION}\\\",\\\"priority\\\":2}]\"}'${NC}"
echo ""

echo -e "${BOLD}Connect Agent${NC}"
echo -e "  yaver serve --relay=${RELAY_QUIC_ADDR}"
echo ""
