#!/bin/bash
# Seed relay server config for the maintainer account
# Usage: ./scripts/seed-relay-config.sh <auth-token>

TOKEN="${1:?Usage: $0 <auth-token>}"
CONVEX_URL="${CONVEX_SITE_URL:-https://shocking-echidna-394.eu-west-1.convex.site}"

echo "Seeding relay config to $CONVEX_URL ..."

curl -s -X POST "$CONVEX_URL/settings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "relayUrl": "https://connect.yaver.io",
    "relayPassword": "Sikecem.31"
  }'

echo ""
echo "Relay config seeded. Verify:"
curl -s "$CONVEX_URL/settings" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null || cat
