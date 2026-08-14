#!/bin/bash
# Seed relay server config for an account.
# Usage: YAVER_RELAY_URL=https://relay.example.com \
#        YAVER_RELAY_PASSWORD=... ./scripts/seed-relay-config.sh <auth-token>

TOKEN="${1:?Usage: $0 <auth-token>}"
CONVEX_URL="${CONVEX_SITE_URL:-https://perceptive-minnow-557.eu-west-1.convex.site}"
RELAY_URL="${YAVER_RELAY_URL:?Set YAVER_RELAY_URL}"
RELAY_PASSWORD="${YAVER_RELAY_PASSWORD:?Set YAVER_RELAY_PASSWORD}"
PAYLOAD=$(RELAY_URL="$RELAY_URL" RELAY_PASSWORD="$RELAY_PASSWORD" node -e 'process.stdout.write(JSON.stringify({relayUrl: process.env.RELAY_URL, relayPassword: process.env.RELAY_PASSWORD}))')

echo "Seeding relay config to $CONVEX_URL ..."

curl -s -X POST "$CONVEX_URL/settings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD"

echo ""
echo "Relay config seeded. Verify:"
curl -s "$CONVEX_URL/settings" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null || cat
