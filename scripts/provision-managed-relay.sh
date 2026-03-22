#!/usr/bin/env bash
# Fully automated managed relay provisioning.
# Called by Convex backend after LemonSqueezy payment confirmation.
#
# Does everything: Hetzner → DNS → SSL → Convex → Health check
#
# Usage: ./scripts/provision-managed-relay.sh \
#   --user-id <id> \
#   --user-email <email> \
#   --region <eu|us> \
#   --convex-token <token>
#
# Required env vars:
#   HCLOUD_TOKEN     — Hetzner Cloud API token
#   CF_API_TOKEN     — Cloudflare API token (Zone DNS Edit)
#   CF_ZONE_ID       — Cloudflare zone ID for yaver.io
#   CONVEX_SITE_URL  — Convex backend URL
#
# Output: JSON with server details on success, exit 1 on failure

set -euo pipefail

# Parse args
USER_ID=""
USER_EMAIL=""
REGION="eu"
CONVEX_TOKEN=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --user-id) USER_ID="$2"; shift 2 ;;
    --user-email) USER_EMAIL="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --convex-token) CONVEX_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate
: "${USER_ID:?--user-id required}"
: "${HCLOUD_TOKEN:?Set HCLOUD_TOKEN}"
: "${CF_API_TOKEN:?Set CF_API_TOKEN}"
: "${CF_ZONE_ID:?Set CF_ZONE_ID}"

# Derived values
SHORT_ID="${USER_ID:0:8}"
SERVER_NAME="relay-${SHORT_ID}"
SUBDOMAIN="${SHORT_ID}.relay"
DOMAIN="${SHORT_ID}.relay.yaver.io"
RELAY_PASSWORD=$(openssl rand -hex 16)
SERVER_TYPE="cax11"  # 2 vCPU ARM, 4GB RAM, €3.79/mo

# Map region to Hetzner datacenter
case "$REGION" in
  eu*) DATACENTER="fsn1-dc14"; LOCATION="fsn1" ;;
  us*) DATACENTER="ash-dc1"; LOCATION="ash" ;;
  *) DATACENTER="fsn1-dc14"; LOCATION="fsn1" ;;
esac

log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }

log "=== Provisioning managed relay for $SHORT_ID ==="
log "Domain: $DOMAIN | Region: $REGION | Server: $SERVER_TYPE"

# ── Step 1: Create Hetzner server ──────────────────────────────────

log "Step 1/6: Creating Hetzner server..."

CLOUD_CONFIG=$(cat <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - nginx
  - certbot
  - python3-certbot-nginx
runcmd:
  - systemctl enable docker
  - systemctl start docker
CLOUDINIT
)

SERVER_RESPONSE=$(curl -sf -X POST "https://api.hetzner.cloud/v1/servers" \
  -H "Authorization: Bearer $HCLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "name": "$SERVER_NAME",
  "server_type": "$SERVER_TYPE",
  "image": "ubuntu-24.04",
  "location": "$LOCATION",
  "labels": {"service":"yaver-relay","user":"$SHORT_ID","managed":"true","tier":"paid"},
  "user_data": $(echo "$CLOUD_CONFIG" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
}
JSON
)")

SERVER_ID=$(echo "$SERVER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['server']['id'])")
SERVER_IP=$(echo "$SERVER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['server']['public_net']['ipv4']['ip'])")

if [ -z "$SERVER_ID" ] || [ "$SERVER_ID" = "null" ]; then
  log "FATAL: Failed to create server"
  echo "$SERVER_RESPONSE" >&2
  exit 1
fi

log "Server created: ID=$SERVER_ID IP=$SERVER_IP"

# ── Step 2: Wait for server to be ready ────────────────────────────

log "Step 2/6: Waiting for server..."

for i in $(seq 1 60); do
  STATUS=$(curl -sf "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \
    -H "Authorization: Bearer $HCLOUD_TOKEN" | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['server']['status'])" 2>/dev/null || echo "pending")
  [ "$STATUS" = "running" ] && break
  sleep 5
done

# Wait for SSH
for i in $(seq 1 30); do
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes root@$SERVER_IP "echo ready" &>/dev/null && break
  sleep 5
done

# Wait for cloud-init
ssh -o StrictHostKeyChecking=no root@$SERVER_IP "cloud-init status --wait" &>/dev/null || sleep 30

log "Server ready"

# ── Step 3: Deploy relay via Docker ────────────────────────────────

log "Step 3/6: Deploying relay..."

ssh -o StrictHostKeyChecking=no root@$SERVER_IP bash <<DEPLOY
set -e
mkdir -p /opt/yaver-relay

cat > /opt/yaver-relay/docker-compose.yml <<YML
services:
  relay:
    image: ghcr.io/kivanccakmak/yaver-relay:latest
    restart: always
    ports:
      - "4433:4433/udp"
      - "8080:8080"
    environment:
      - RELAY_PASSWORD=$RELAY_PASSWORD
      - RELAY_QUIC_PORT=4433
      - RELAY_HTTP_PORT=8080
      - RELAY_DATA_DIR=/data
    volumes:
      - relay-data:/data

  watchtower:
    image: containrrr/watchtower
    restart: always
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 3600 --cleanup
    environment:
      - WATCHTOWER_LABEL_ENABLE=false

volumes:
  relay-data:
YML

cd /opt/yaver-relay
docker compose pull 2>/dev/null || docker-compose pull
docker compose up -d 2>/dev/null || docker-compose up -d

# Nginx reverse proxy
cat > /etc/nginx/sites-available/relay <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
DEPLOY

log "Relay deployed"

# ── Step 4: Add Cloudflare DNS record ──────────────────────────────

log "Step 4/6: Adding DNS record ($DOMAIN → $SERVER_IP)..."

DNS_RESULT=$(curl -sf -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"A\",\"name\":\"$SUBDOMAIN\",\"content\":\"$SERVER_IP\",\"proxied\":false,\"ttl\":60}")

DNS_OK=$(echo "$DNS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))")
if [ "$DNS_OK" != "True" ]; then
  log "WARNING: DNS record creation may have failed: $DNS_RESULT"
fi

DNS_RECORD_ID=$(echo "$DNS_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('id',''))" 2>/dev/null)

# Wait for DNS propagation
log "Waiting for DNS propagation..."
for i in $(seq 1 30); do
  RESOLVED=$(dig +short "$DOMAIN" @1.1.1.1 2>/dev/null)
  [ "$RESOLVED" = "$SERVER_IP" ] && break
  sleep 5
done

log "DNS ready"

# ── Step 5: Get SSL certificate ────────────────────────────────────

log "Step 5/6: Getting SSL certificate..."

ssh -o StrictHostKeyChecking=no root@$SERVER_IP \
  "certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email support@yaver.io" 2>&1 | tail -3

# Setup auto-renewal cron
ssh root@$SERVER_IP "echo '0 3 * * * certbot renew --quiet' | crontab -" 2>/dev/null

log "SSL configured with auto-renewal"

# ── Step 6: Health check ───────────────────────────────────────────

log "Step 6/6: Health check..."

HEALTH=$(curl -sf "https://$DOMAIN/health" 2>/dev/null || echo '{"ok":false}')
HEALTH_OK=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")

if [ "$HEALTH_OK" != "True" ]; then
  log "WARNING: Health check failed, retrying in 10s..."
  sleep 10
  HEALTH=$(curl -sf "https://$DOMAIN/health" 2>/dev/null || echo '{"ok":false}')
  HEALTH_OK=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))")
fi

if [ "$HEALTH_OK" = "True" ]; then
  log "✓ Relay is healthy"
else
  log "✗ Health check failed — manual intervention may be needed"
fi

# ── Output ─────────────────────────────────────────────────────────

log "=== Provisioning complete ==="

cat <<RESULT
{
  "success": true,
  "serverId": "$SERVER_ID",
  "serverIp": "$SERVER_IP",
  "domain": "$DOMAIN",
  "quicAddr": "$SERVER_IP:4433",
  "httpsUrl": "https://$DOMAIN",
  "password": "$RELAY_PASSWORD",
  "region": "$REGION",
  "dnsRecordId": "$DNS_RECORD_ID",
  "healthy": $HEALTH_OK
}
RESULT
