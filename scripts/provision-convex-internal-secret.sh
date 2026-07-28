#!/usr/bin/env bash
#
# Provision CONVEX_INTERNAL_SECRET on both sides of the auth-provisioning gate.
#
# WHY THIS EXISTS
# ---------------
# backend/convex/http.ts::requireServerSecret gates five identity-provisioning
# routes (/auth/upsert-user, /auth/create-session, /auth/oauth-link/complete,
# /auth/totp/*). Those routes trust a body-supplied userId/email, so the gate is
# the only thing standing between the public deployment URL and minting a
# session as an arbitrary user — full account takeover.
#
# The gate FAILS OPEN when the env var is unset:
#
#     const expected = process.env.CONVEX_INTERNAL_SECRET;
#     if (!expected) return null;   // staged rollout — allow
#
# That was deliberate (step 1 of a staged rollout, so deploying the code could
# not break login before web shipped the header). Step 3 never happened. Audited
# 2026-07-28: unset on prod, so the routes were unauthenticated on a public URL.
# This script is step 3.
#
# ORDER IS LOAD-BEARING
# ---------------------
# Both sides fail open independently:
#   web set, convex unset   -> header sent, ignored. Logins work. Still open.  SAFE
#   web unset, convex set   -> no header sent, 403. EVERY LOGIN BREAKS.        BROKEN
# So Cloudflare goes first and Convex only runs if it succeeded. If this script
# dies halfway it lands in the SAFE state, never the broken one.
#
# The secret never touches stdout, argv, or shell history: it is generated into
# a variable and piped to both tools on stdin.
#
# BLAST RADIUS (audited 2026-07-28, whole repo, every surface)
# -----------------------------------------------------------
# The gate covers exactly five routes: /auth/upsert-user, /auth/create-session,
# /auth/oauth-link/complete, /auth/totp/check-user, /auth/totp/create-pending.
# A repo-wide sweep found exactly ONE caller of any of them:
# web/app/api/auth/oauth/[provider]/callback/route.ts, and all five of its calls
# already pass internalAuthHeaders(). Nothing else calls them — not mobile, not
# the Go agent, not the CLI, not tvOS/watch/wear, not the relay, not the SDKs.
#
# Those surfaces sign in on routes this gate does not touch: mobile email login
# and the agent use /auth/login and /auth/device-code/*; mobile OAuth opens
# <web>/api/auth/oauth/<provider>?client=mobile, i.e. it is served BY the web
# route above, so it is covered by the same Cloudflare secret.
#
# ROLLBACK
# --------
# Removing the Convex var restores fail-open instantly — one command, and it is
# what this script's --rollback does. Keep that in your back pocket: if any
# login misbehaves after this runs, roll back first and diagnose after.
#
# Usage:  ./scripts/provision-convex-internal-secret.sh [--force|--rollback]
#
#   --force     rotate even if Convex already has a value set. Without it, an
#               existing value aborts, because generating a fresh secret while
#               web still holds the old one is how you take logins down.
#   --rollback  unset CONVEX_INTERNAL_SECRET on Convex prod. Enforcement stops,
#               logins work again, the takeover is open again. Panic button.

set -euo pipefail

FORCE=0
ROLLBACK=0
case "${1:-}" in
  --force)    FORCE=1 ;;
  --rollback) ROLLBACK=1 ;;
  "")         ;;
  *)          echo "unknown option: $1" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$REPO_ROOT/web"
BACKEND_DIR="$REPO_ROOT/backend"
BACKUP_FILE="$HOME/.yaver/local-secrets.env"
BACKUP_KEY="YAVER_CONVEX_INTERNAL_SECRET"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

die() { red "FAILED: $*"; exit 1; }

# --- preflight -------------------------------------------------------------
step "Preflight"

command -v openssl >/dev/null || die "openssl not found"
command -v curl    >/dev/null || die "curl not found"
[[ -d "$WEB_DIR"     ]] || die "no web/ at $WEB_DIR"
[[ -d "$BACKEND_DIR" ]] || die "no backend/ at $BACKEND_DIR"

# Read the deployment URL from wrangler.toml rather than hardcoding a hostname.
#
# BUG FIXED 2026-07-28 (hit on the first real run): this used `\s` in `sed -E`.
# BSD/macOS sed does not support `\s`, so the substitution silently did not
# match and the WHOLE LINE — `CONVEX_SITE_URL = "https://..."` — became the URL.
# Every curl then failed, and because the probe appended its own fallback the
# code read "000000" instead of "000", which slipped past the guard below. The
# script went on to mutate BOTH sides of production on the strength of a probe
# that had never reached the network, and then reported "Enforcement did NOT
# take effect" when in fact it had. Extract with a POSIX class, and validate the
# result looks like a URL rather than trusting the extraction.
CONVEX_SITE_URL="$(grep -E '^[[:space:]]*CONVEX_SITE_URL' "$WEB_DIR/wrangler.toml" \
  | head -1 | sed -E 's/^[^"]*"([^"]+)".*/\1/')"
case "$CONVEX_SITE_URL" in
  https://*) : ;;
  *) die "could not parse CONVEX_SITE_URL from web/wrangler.toml (got: '$CONVEX_SITE_URL')" ;;
esac
echo "Convex site: $CONVEX_SITE_URL"

# Probe the gate BEFORE touching anything. A 403 here means it is already
# enforcing and there is nothing to do (or you want --force to rotate).
#
# No `|| echo` fallback: curl already writes 000 on failure, and appending a
# second value is what produced the unparseable "000000" above. Callers must
# treat anything that is not three digits as "the probe did not run".
probe() {
  curl -s -o /dev/null -w '%{http_code}' -m 20 \
    -X POST "$CONVEX_SITE_URL/auth/create-session" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null
}

if [[ $ROLLBACK -eq 1 ]]; then
  step "ROLLBACK — removing CONVEX_INTERNAL_SECRET from Convex prod"
  ylw "Enforcement will stop. Logins recover. The takeover is open again."
  (cd "$BACKEND_DIR" && npx convex env remove CONVEX_INTERNAL_SECRET --prod) \
    || die "rollback failed — run by hand: cd backend && npx convex env remove CONVEX_INTERNAL_SECRET --prod"
  sleep 3
  AFTER="$(probe)"
  if [[ "$AFTER" == "403" ]]; then
    red "Still 403 after rollback — env may not have propagated yet. Re-probe in a few seconds."
  else
    grn "Rolled back (probe: HTTP $AFTER). Logins should work again."
  fi
  echo "The secret is still on Cloudflare and still in $BACKUP_FILE, so re-enabling"
  echo "is just: npx convex env set CONVEX_INTERNAL_SECRET --prod  (paste the backup value)"
  exit 0
fi

BEFORE="$(probe)"
echo "Gate probe before: HTTP $BEFORE"
# Refuse to touch production on a probe that did not actually reach the network.
# A malformed code here is not "the gate is open" — it is "we learned nothing",
# and the two must never be conflated (that is what shipped the bug above).
case "$BEFORE" in
  [0-9][0-9][0-9]) : ;;
  *) die "probe returned '$BEFORE', not an HTTP code — refusing to change prod on an unverified probe" ;;
esac
if [[ "$BEFORE" == "403" ]]; then
  grn "Already enforcing — /auth/create-session rejects unsigned callers."
  [[ $FORCE -eq 1 ]] || { echo "Nothing to do. Pass --force to rotate."; exit 0; }
  ylw "--force given: rotating anyway."
elif [[ "$BEFORE" == "000" ]]; then
  die "could not reach $CONVEX_SITE_URL — check network before changing prod"
else
  ylw "Gate is OPEN (HTTP $BEFORE = request executed past the guard)."
fi

# Refuse to generate a fresh value over an existing one unless forced.
if [[ $FORCE -eq 0 ]]; then
  if (cd "$BACKEND_DIR" && npx convex env list --prod 2>/dev/null) \
       | grep -q '^CONVEX_INTERNAL_SECRET'; then
    die "Convex prod already has CONVEX_INTERNAL_SECRET. Rotating would break
       logins unless Cloudflare gets the same new value. Re-run with --force."
  fi
fi

# --- generate --------------------------------------------------------------
step "Generating secret"
SECRET="$(openssl rand -hex 32)"
[[ ${#SECRET} -eq 64 ]] || die "openssl produced an unexpected value"
grn "Generated 32 bytes (value is never printed)."

# --- back it up FIRST ------------------------------------------------------
# Cloudflare will not show a secret again once set. If the script dies after
# wrangler but before the backup, the value is unrecoverable and you are stuck
# rotating both sides. So persist locally before either remote write.
step "Backing up to $BACKUP_FILE"
mkdir -p "$(dirname "$BACKUP_FILE")"
touch "$BACKUP_FILE"; chmod 600 "$BACKUP_FILE"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
grep -v "^export ${BACKUP_KEY}=" "$BACKUP_FILE" > "$TMP" || true
printf 'export %s="%s"\n' "$BACKUP_KEY" "$SECRET" >> "$TMP"
cat "$TMP" > "$BACKUP_FILE"; chmod 600 "$BACKUP_FILE"
grn "Saved (0600, owner-only, gitignored, never synced to a cloud secret store)."

# --- 1. Cloudflare ---------------------------------------------------------
step "1/2 Setting on Cloudflare Worker (must succeed before Convex)"
if ! printf '%s' "$SECRET" | (cd "$WEB_DIR" && npx wrangler secret put CONVEX_INTERNAL_SECRET); then
  red "wrangler failed — Convex NOT touched, so nothing is broken."
  echo "The value is saved at $BACKUP_FILE under $BACKUP_KEY if you want to retry by hand."
  exit 1
fi
grn "Cloudflare has it. Web now sends X-Internal-Secret; Convex still ignores it."

# --- 2. Convex -------------------------------------------------------------
# Let the new worker version roll out before enforcement starts. A wrangler
# secret write publishes a new version; if Convex began rejecting while the old
# version (no header) was still serving, real logins would 403 in that window.
step "Waiting 20s for the Cloudflare worker version to roll out"
sleep 20

step "2/2 Setting on Convex prod (turns enforcement ON)"
if ! printf '%s' "$SECRET" | (cd "$BACKEND_DIR" && npx convex env set CONVEX_INTERNAL_SECRET --prod); then
  red "convex env set failed."
  ylw "State is SAFE: web sends the header, Convex ignores it, logins work."
  ylw "The takeover is still open. Retry with: --force"
  exit 1
fi

# --- verify ----------------------------------------------------------------
# Prove the guard works by watching it reject. A guard nobody has seen fail is
# a guess: BEFORE was non-403 (executed past the guard), AFTER must be 403.
step "Verifying"
sleep 3
AFTER="$(probe)"
echo "Gate probe after:  HTTP $AFTER"

if [[ "$AFTER" == "403" ]]; then
  grn "CLOSED. Unsigned callers are now rejected before the handler runs."
  [[ "$BEFORE" != "403" ]] && grn "Transition observed: $BEFORE -> 403."
else
  red "Still HTTP $AFTER — expected 403. Enforcement did NOT take effect."
  echo "Convex env may need a moment to propagate; re-run the probe:"
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\"
  echo "    $CONVEX_SITE_URL/auth/create-session -H 'Content-Type: application/json' -d '{}'"
  exit 1
fi

cat <<EOF

$(grn "Done.")

Backup:  $BACKUP_FILE  ($BACKUP_KEY)

ONE MANUAL CHECK LEFT — this script cannot drive OAuth:
  Sign in at https://yaver.io with Google/GitHub/Apple and confirm it completes.
  That is the half the probe can't cover: the probe proves strangers are
  rejected, a real login proves web is sending the right header.
  Mobile OAuth runs through the same web route, so one web login covers both.

$(ylw "IF ANYTHING MISBEHAVES, ROLL BACK FIRST AND DIAGNOSE AFTER:")
    ./scripts/provision-convex-internal-secret.sh --rollback

  That unsets the Convex var, enforcement stops, logins recover immediately.
  Cloudflare keeps the secret and $BACKUP_FILE keeps a copy, so re-enabling
  later is one command — you never have to redo the Cloudflare half.

NOT AFFECTED (swept repo-wide before writing this):
  mobile email login, Go agent, CLI, tvOS, watch, wear, relay, SDKs. They
  authenticate on /auth/login and /auth/device-code/*, which this gate does
  not cover. The five gated routes have exactly one caller in the repo, and
  it is the web OAuth callback that now holds the secret.
EOF
