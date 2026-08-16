#!/usr/bin/env bash
#
# Verify the Convex auth-provisioning gate is enforcing — and that it is
# enforcing ONLY where it should.
#
# Read-only. Sends empty bodies to routes that reject them, so it writes
# nothing and creates no rows. Safe to run any time, as often as you like.
#
# WHAT IT CHECKS
#   1. The five gated routes reject an unsigned caller with 403. These trust a
#      body-supplied userId/email, so an unsigned caller reaching the handler
#      means anyone can mint a session as any user (full account takeover).
#   2. The ungated auth routes do NOT return 403. This is the half that catches
#      an over-broad gate: if /auth/login started 403-ing, every mobile and
#      agent login would be dead while check 1 still looked perfect.
#
# WHY BOTH HALVES: "strangers are rejected" and "our own users still get in"
# are different properties, and a gate can pass one while failing the other.
#
# WHAT IT CANNOT CHECK: OAuth end to end. Only a real browser sign-in proves the
# web backend is sending X-Internal-Secret correctly. If check 1 passes and
# sign-in is broken, the two sides hold DIFFERENT secrets — fix with
# ./scripts/provision-convex-internal-secret.sh --rollback, then re-provision.
#
# Usage:  ./scripts/verify-convex-auth-gate.sh [https://<deployment>.convex.site]
#         (URL is read from web/wrangler.toml when omitted)
#
# Exit 0 = enforcing and healthy. Exit 1 = something is wrong; read the output.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

URL="${1:-}"
if [[ -z "$URL" ]]; then
  # POSIX class, not \s — BSD/macOS sed does not support \s, and getting this
  # wrong once already produced a whole-line "URL" and a meaningless probe.
  URL="$(grep -E '^[[:space:]]*CONVEX_SITE_URL' "$REPO_ROOT/web/wrangler.toml" 2>/dev/null \
    | head -1 | sed -E 's/^[^"]*"([^"]+)".*/\1/')"
fi
case "$URL" in
  https://*) : ;;
  *) red "Could not determine the Convex site URL (got: '$URL')."
     echo "Pass it explicitly:  $0 https://<deployment>.convex.site"; exit 1 ;;
esac
echo "Convex site: $URL"
echo

hit() { # hit <METHOD> <path> -> prints the HTTP code, or a non-numeric on failure
  if [[ "$1" == "POST" ]]; then
    curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$URL$2" \
      -H 'Content-Type: application/json' -d '{}' 2>/dev/null
  else
    curl -s -o /dev/null -w '%{http_code}' -m 20 "$URL$2" 2>/dev/null
  fi
}

fail=0
numeric() { [[ "$1" =~ ^[0-9]{3}$ ]] && [[ "$1" != "000" ]]; }

# ── 1. gated routes MUST be 403 ───────────────────────────────────────────────
echo "Gated routes — must be 403 (unsigned caller rejected before the handler):"
for r in /auth/upsert-user /auth/create-session /auth/oauth-link/complete \
         /auth/totp/check-user /auth/totp/create-pending; do
  code="$(hit POST "$r")"
  if ! numeric "$code"; then
    printf "  %-32s %-6s " "$r" "${code:-none}"; red "UNREACHABLE — probe never hit the network"; fail=1
  elif [[ "$code" == "403" ]]; then
    printf "  %-32s %-6s " "$r" "$code"; grn "rejected"
  else
    printf "  %-32s %-6s " "$r" "$code"; red "NOT ENFORCING — request reached the handler"; fail=1
  fi
done

# ── 2. ungated routes must NOT be 403 ─────────────────────────────────────────
echo
echo "Ungated routes — must NOT be 403 (your own users must still get in):"
for spec in "GET /auth/config" "GET /auth/providers" "POST /auth/login" \
            "POST /auth/device-code/poll"; do
  set -- $spec
  code="$(hit "$1" "$2")"
  if ! numeric "$code"; then
    printf "  %-32s %-6s " "$2" "${code:-none}"; ylw "unreachable (network?)"
  elif [[ "$code" == "403" ]]; then
    printf "  %-32s %-6s " "$2" "$code"; red "GATE IS TOO BROAD — this lane is dead"; fail=1
  else
    printf "  %-32s %-6s " "$2" "$code"; grn "reachable"
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  grn "PASS — the gate is enforcing, and only on the five provisioning routes."
  echo
  echo "One thing this cannot prove: that OAuth still completes. Sign in at"
  echo "https://yaver.io with any provider to confirm. Mobile OAuth is served by"
  echo "the same web route, so one web login covers the phone too."
  exit 0
fi

red "FAIL — see the lines above."
echo
echo "If the gated routes are NOT 403, the takeover is open. Provision with:"
echo "  ./scripts/provision-convex-internal-secret.sh"
echo "If an ungated route IS 403, or sign-in is broken, roll back FIRST:"
echo "  ./scripts/provision-convex-internal-secret.sh --rollback"
exit 1
