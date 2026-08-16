package main

import (
	"log"
	"strings"
)

// Re-learning the relay's identity after a legitimate key rotation.
//
// Incident 2026-08-01. public.yaver.io was restarted. The deployed relay
// (0.1.19) had NO key persistence — its default key path sits under /opt, which
// systemd mounts read-only via ProtectSystem, so it silently fell back to an
// EPHEMERAL key on every start. Nothing was wrong until the process restarted;
// then its SPKI changed, and every agent that had pinned the old one refused
// the connection:
//
//	SPKI pin mismatch: expected inNVAkIr2T7…, got 8zLwlbw+Nh5a… — refusing (possible MITM)
//
// The refusal is CORRECT and stays. What was missing is the other half: a
// rotation and an attack look identical from the QUIC lane, and the agent had
// no way to tell them apart, no way to re-learn the new identity, and nothing
// to tell the operator. Boxes sat in a permanent refuse-and-backoff loop.
//
// The tie-breaker is that the pin has an authoritative source OUTSIDE the lane
// being attacked: Convex's /config, fetched over ordinary WebPKI HTTPS. An
// attacker who owns the QUIC path cannot influence what that returns, so
// re-pulling the pin from it does NOT weaken the guarantee — we never accept an
// unverified key, we only re-ask the control plane which key is authentic.
//
// /config is UNAUTHENTICATED (relay endpoints are public infrastructure), which
// is what makes this work on exactly the boxes that need it most: a machine
// whose Convex session has expired cannot refresh its relay password, but it
// CAN still re-learn the relay's identity. Without that, a session expiry plus a
// relay key rotation is an unrecoverable pair that only a physical shell fixes.

// refreshRelayPinFromConvex re-pulls the authoritative SPKI pin for relayAddr
// and persists it into cached_relay_servers.
//
// Returns the new pin ONLY when it differs from failedPin. Returning "" for an
// unchanged pin is the loop guard: if the pin we already hold is still the
// authoritative one, then the mismatch was NOT a rotation, and retrying would
// spin forever against something that deserves to keep failing loudly.
func refreshRelayPinFromConvex(relayAddr, failedPin string) string {
	cfg, err := LoadConfig()
	if err != nil || cfg == nil || strings.TrimSpace(cfg.ConvexSiteURL) == "" {
		return ""
	}
	servers, err := FetchRelayServers(strings.TrimRight(cfg.ConvexSiteURL, "/"))
	if err != nil || len(servers) == 0 {
		log.Printf("[RELAY %s] pin refresh: platform config unavailable: %v", relayAddr, err)
		return ""
	}
	fresh := ""
	for _, rs := range servers {
		if rs.QuicAddr == relayAddr {
			fresh = strings.TrimSpace(rs.SpkiPin)
			break
		}
	}
	if fresh == "" || fresh == strings.TrimSpace(failedPin) {
		// Either the platform publishes no pin for this relay, or it publishes
		// the very one that just failed. Neither is a rotation.
		return ""
	}

	// Persist so a restart does not have to relearn, and so every other lane
	// (expose, SSH, webview) picks up the same identity.
	updated := false
	for i := range cfg.CachedRelayServers {
		if cfg.CachedRelayServers[i].QuicAddr == relayAddr {
			cfg.CachedRelayServers[i].SpkiPin = fresh
			updated = true
		}
	}
	for i := range cfg.RelayServers {
		if cfg.RelayServers[i].QuicAddr == relayAddr {
			cfg.RelayServers[i].SpkiPin = fresh
			updated = true
		}
	}
	if updated {
		if saveErr := SaveConfig(cfg); saveErr != nil {
			log.Printf("[RELAY %s] pin refresh: SaveConfig: %v", relayAddr, saveErr)
		}
	}
	return fresh
}

// relayPinMismatchRemedy is what an operator sees when the pin genuinely cannot
// be re-learned. It has to distinguish the two cases the refusal cannot, and
// name a next step for each — "possible MITM" alone leaves a user with a box
// that will never reconnect and no idea why.
func relayPinMismatchRemedy(relayAddr string) string {
	return "relay " + relayAddr + " presented an identity that does not match the pinned one, " +
		"and the platform config still publishes the pin that just failed. " +
		"Either the relay operator rotated its key without publishing the new pin, or this connection is being intercepted. " +
		"Yaver will keep refusing — that is the correct behaviour. " +
		"If you run this relay: restart it with a PERSISTENT key (YAVER_RELAY_KEY_PATH on a writable path) and publish the SPKI pin it logs at startup."
}
