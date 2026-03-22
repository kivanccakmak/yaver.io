#!/usr/bin/env bash
# Deprovision a managed relay server on Hetzner Cloud.
# Called when a subscription expires (after 7-day grace period).
#
# Usage: ./scripts/deprovision-relay.sh <server-id>

set -euo pipefail

SERVER_ID="${1:?Usage: deprovision-relay.sh <server-id>}"
HCLOUD_TOKEN="${HCLOUD_TOKEN:?Set HCLOUD_TOKEN env var}"

echo "Deprovisioning relay server $SERVER_ID..."

# Delete the server
RESPONSE=$(curl -s -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \
  -H "Authorization: Bearer $HCLOUD_TOKEN")

echo "Server $SERVER_ID deleted."
echo "$RESPONSE"
