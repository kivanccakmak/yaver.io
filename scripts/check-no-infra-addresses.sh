#!/usr/bin/env bash
# check-no-infra-addresses.sh — no REAL machine addresses in a PUBLIC repo.
#
# ─── The incident this exists for ──────────────────────────────────────────
#
# 2026-08-03: a box's Tailscale address was found hardcoded in TWELVE tracked
# files — four e2e arcs' `|| "http://<ip>:18080"` fallbacks, two Info.plist
# comments, a Go test fixture, a UI test default, four docs. Committed and
# pushed to a public repo across several sessions, and nothing noticed, because
# nothing was looking. CLAUDE.md has said "never commit infra IPs" the whole
# time; a rule with no check is a hope.
#
# Each literal was a `|| "<ip>"` DEFAULT, so it was a PRODUCT bug too: every arc
# silently targeted one person's machine, and another user's run would measure a
# box they do not own. "Never hardcode a path, username, or home dir" is the
# same law — an address is the network's spelling of a home dir.
#
# ─── Why it does not simply grep for 100.64/10 ─────────────────────────────
#
# The first version of this file did, and it flagged ~100 lines: mesh ACL tests
# on 100.96.0.1, probe-target fixtures on 100.64.0.1, docs illustrating a peer
# list. All correct code. A guard that fires a hundred times on healthy lines is
# disabled on day one and then protects nothing — the same defect as an advisory
# wall burying the route, wearing a test's clothes.
#
# So this MEASURES instead of guessing. It asks THIS machine for the addresses
# and hostnames it actually has — tailnet IP, mesh IP, LAN IPs, hostname, the
# addresses of the user's own registered devices — and fails only when one of
# THOSE appears in a tracked file. A synthetic fixture cannot match unless it
# genuinely is somebody's machine, and a real address cannot hide behind looking
# ordinary. Probe the operation, never the inventory.
#
# Plus one pattern that is unambiguous without any measurement: `user@100.x`.
# An SSH target names a real host by construction.
#
# ─── Limits, stated rather than implied ────────────────────────────────────
#
# This check can only see machines THIS box knows about. It will not catch a
# colleague's address, and it is not a substitute for reading a diff. It closes
# the specific hole that cost us twelve files: your own machines leaking into
# your own commits.
#
# RUN:      scripts/check-no-infra-addresses.sh          (~2s)
# EXITS 1   on a finding, naming the file and the address.
#
# PROVE IT: put your own tailnet IP in any tracked file and run this — it must
# fail and name the file. Verified 2026-08-03 before committing.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
found=""

note() {
  found="${found}
  $1"
  fail=1
}

# ── 1. Collect THIS machine's real identifiers ──────────────────────────────
# Every source is best-effort: a missing tool narrows coverage, it never fails
# the check. A guard that errors out when tailscale is absent teaches people to
# skip it.
addrs=""

collect() { # append whitespace-separated candidates
  addrs="$addrs $1"
}

if command -v tailscale >/dev/null 2>&1; then
  collect "$(tailscale ip 2>/dev/null | tr '\n' ' ')"
  # Peers too — a teammate's box in a commit is the same leak.
  collect "$(tailscale status --json 2>/dev/null \
    | grep -oE '"TailscaleIPs":\[[^]]*\]' \
    | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | tr '\n' ' ')"
fi

# Yaver's own view: the mesh IP and any device addresses the agent knows.
if [ -r "$HOME/.yaver/config.json" ]; then
  collect "$(grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' "$HOME/.yaver/config.json" 2>/dev/null | tr '\n' ' ')"
fi

# Non-loopback interface addresses of this machine.
if command -v ifconfig >/dev/null 2>&1; then
  collect "$(ifconfig 2>/dev/null | grep -oE 'inet [0-9]{1,3}(\.[0-9]{1,3}){3}' | awk '{print $2}' | tr '\n' ' ')"
elif command -v ip >/dev/null 2>&1; then
  collect "$(ip -4 -o addr 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
fi

# ── 2. Which of those are worth protecting? ────────────────────────────────
# RFC1918 and loopback are excluded: 192.168.1.20 is in a hundred honest
# fixtures, it identifies nobody, and flagging it would recreate the noise
# problem this file exists to avoid. What identifies a machine is its OVERLAY
# address (CGNAT 100.64/10 — Tailscale and Yaver Mesh) and its public address.
protect=""
for a in $addrs; do
  case "$a" in
    ""|127.*|10.*|192.168.*|169.254.*|0.0.0.0|255.*) continue ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;;
  esac
  case " $protect " in *" $a "*) continue ;; esac
  protect="$protect $a"
done

for a in $protect; do
  hits=$(git grep -nF -- "$a" 2>/dev/null | grep -v '^scripts/check-no-infra-addresses.sh:' | grep -v 'infra-addr-ok')
  [ -z "$hits" ] && continue
  while IFS= read -r line; do note "$line"; done <<EOF
$hits
EOF
done

# ── 3. This machine's hostname, and any tailnet FQDN ───────────────────────
host=$(hostname -s 2>/dev/null || true)
case "$host" in
  ""|localhost|Mac|mac) ;;
  *)
    hits=$(git grep -niF -- "$host.ts.net" 2>/dev/null | grep -v '^scripts/' | grep -v 'infra-addr-ok')
    [ -n "$hits" ] && while IFS= read -r line; do note "$line"; done <<EOF
$hits
EOF
    ;;
esac

# ── 4. An SSH target names a real host by construction ─────────────────────
# `user@100.x` needs no measurement to be wrong: nobody writes a synthetic
# fixture that way, and it leaks the USERNAME alongside the address.
sshhits=$(git grep -nE '[a-z_][a-z0-9_-]*@100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}' -- . 2>/dev/null \
  | grep -v '^scripts/check-no-infra-addresses.sh:' | grep -v 'infra-addr-ok')
[ -n "$sshhits" ] && while IFS= read -r line; do note "$line"; done <<EOF
$sshhits
EOF

if [ "$fail" -ne 0 ]; then
  printf 'FAIL — a REAL machine address is in a tracked file of a PUBLIC repo:\n%s\n\n' "$found" >&2
  cat >&2 <<'EOF'
Fix it the way that also fixes the product:
  • In code: read it from the environment with NO fallback, and SKIP with a
    named reason when it is unset. A default address is a single-user bug.
  • In prose: write <box>, primary, or your-box — an alias, never a machine.
  • In a fixture: use RFC 5737 (192.0.2.x) or an obviously synthetic overlay
    address. Those are what the doc ranges are for.
  • Truly a false positive? End the line with:  # infra-addr-ok

Already pushed? Do NOT rewrite public history to hide it — land the scrub as a
new commit and tell the user, so they can decide about the old objects.
EOF
  exit 1
fi

if [ -z "$protect" ]; then
  echo "ok — but NOTHING WAS MEASURED (no tailscale, no interface addresses)."
  echo "   This run proves nothing. Install/authenticate tailscale for real coverage."
  exit 0
fi
printf 'ok — no real machine address in tracked files (checked %s addresses)\n' "$(printf '%s' "$protect" | wc -w | tr -d ' ')"
