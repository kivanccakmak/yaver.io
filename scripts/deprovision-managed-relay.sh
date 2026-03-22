#!/usr/bin/env bash
# Fully automated managed relay deprovisioning.
# Called when subscription expires (7 days after cancellation).
#
# Removes: Hetzner server + Cloudflare DNS record
#
# Usage: ./scripts/deprovision-managed-relay.sh \
#   --server-id <hetzner-id> \
#   --dns-record-id <cloudflare-record-id>
#
# Required env vars:
#   HCLOUD_TOKEN  — Hetzner Cloud API token
#   CF_API_TOKEN  — Cloudflare API token
#   CF_ZONE_ID    — Cloudflare zone ID for yaver.io

set -euo pipefail

SERVER_ID=""
DNS_RECORD_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --server-id) SERVER_ID="$2"; shift 2 ;;
    --dns-record-id) DNS_RECORD_ID="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

: "${HCLOUD_TOKEN:?Set HCLOUD_TOKEN}"
: "${CF_API_TOKEN:?Set CF_API_TOKEN}"
: "${CF_ZONE_ID:?Set CF_ZONE_ID}"

log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }

# Step 1: Delete DNS record
if [ -n "$DNS_RECORD_ID" ]; then
  log "Deleting DNS record $DNS_RECORD_ID..."
  curl -sf -X DELETE "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$DNS_RECORD_ID" \
    -H "Authorization: Bearer $CF_API_TOKEN" > /dev/null
  log "DNS record deleted"
fi

# Step 2: Delete Hetzner server
if [ -n "$SERVER_ID" ]; then
  log "Deleting Hetzner server $SERVER_ID..."
  curl -sf -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \
    -H "Authorization: Bearer $HCLOUD_TOKEN" > /dev/null
  log "Server deleted"
fi

log "Deprovisioning complete"
echo '{"success":true}'
