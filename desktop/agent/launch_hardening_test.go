package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Guards the 2026-07-28 pre-launch hardening pass.
//
// Two independent properties are asserted here and they must not be confused:
//   - the KILL SWITCH (feature_flags.go) refuses the guest family outright;
//   - the underlying DEFECTS are fixed, so the day ENABLE_GUEST_FEATURES flips
//     to true the feature is safe rather than merely reachable.
//
// The second half is the one that rots. A kill switch makes every guest test
// pass trivially, which is exactly how a fixed-then-unfixed regression would
// hide. The header/allowlist tests below therefore call the pure functions
// directly and do NOT depend on the flag.

func TestFeatureFlags_GuestFamilyIsOffAtLaunch(t *testing.T) {
	// Reads the compiled-in constants — this is the launch posture itself, so
	// if someone flips ENABLE_GUEST_FEATURES this test tells them the blast
	// radius rather than letting it ship silently.
	for _, tc := range []struct {
		name string
		got  bool
	}{
		{"guest access", GuestAccessEnabled()},
		{"host share", HostShareEnabled()},
		{"support sessions", SupportSessionsEnabled()},
		{"deploy webhook", DeployWebhookEnabled()},
	} {
		if tc.got {
			t.Errorf("%s is ENABLED — stage-one launch ships this family off. "+
				"If that is deliberate, the audit findings for it must be fixed and "+
				"proven first (see feature_flags.go).", tc.name)
		}
	}
}

func TestFeatureFlags_EnvOverrideCanReEnable(t *testing.T) {
	// The override must actually work, or "flip the env var" is advice that
	// does nothing — the same false-green shape as a flag with no consumer.
	t.Setenv(envEnableGuestAccess, "1")
	if !GuestAccessEnabled() {
		t.Fatal("YAVER_ENABLE_GUEST_ACCESS=1 did not enable guest access")
	}
	t.Setenv(envEnableGuestAccess, "")
	if GuestAccessEnabled() {
		t.Fatal("empty override must not enable guest access — overrides fail closed")
	}
	t.Setenv(envEnableGuestAccess, "maybe")
	if GuestAccessEnabled() {
		t.Fatal("a non-affirmative value enabled the feature — envTruthy must be strict")
	}
}

// ── the underlying defects (flag-independent) ────────────────────────────────

// CROSS-TENANT SDK BYPASS. authSDKOrGuest's cached branch validated scopes and
// CIDR but never checked WHOSE token it was, and the miss path cached the entry
// BEFORE the owner check. Send a foreign SDK token twice: request 1 caches and
// 403s, request 2 was authorized as the owner. To see this fail, delete the
// `info.userID != s.ownerUserID` check in the cached isSdk branch.
func TestAuthSDKOrGuest_ForeignSdkTokenRejectedFromCache(t *testing.T) {
	srv := &HTTPServer{token: "owner-token", ownerUserID: "owner-user"}

	const foreign = "yv_sdk_attacker_token"
	srv.tokenCache.Store(foreign, &cachedTokenInfo{
		userID: "some-other-account", // a DIFFERENT Yaver account
		isSdk:  true,
		scopes: []string{"ops", "builds", "runners"},
	})

	called := false
	h := srv.authSDKOrGuest(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	r := httptest.NewRequest(http.MethodPost, "/ops", nil)
	r.Header.Set("Authorization", "Bearer "+foreign)
	rec := httptest.NewRecorder()
	h(rec, r)

	if called {
		t.Fatal("a foreign account's SDK token was authorized from cache — " +
			"cross-tenant bypass: it reaches /ops as the box owner")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for a foreign SDK token, got %d", rec.Code)
	}
	// Assert WHY it was refused, not just that it was. Asserting the status
	// alone made this test a false green: with the owner check deleted the
	// request still 403s, but on SCOPE ("/ops" is not in this token's scopes),
	// so the test passed while the cross-tenant hole was wide open. A token
	// from another account must be refused on IDENTITY — before scope is even
	// consulted — because an attacker picks their own scopes at mint time
	// (backend/convex/auth.ts stores args.scopes verbatim).
	if body := rec.Body.String(); !strings.Contains(body, "different user") {
		t.Fatalf("refused for the wrong reason: %s\n"+
			"expected the identity check to reject a foreign account, not a scope check "+
			"the attacker can trivially satisfy by minting a token with wider scopes", body)
	}
}

// HOST-SHARE TRUST HEADERS. Only the AllowedRunners member was stripped, so a
// caller could attach X-Yaver-HostShare itself and unlock a caller-supplied
// absolute rootPath in /files/read.
func TestStripGuestRequestHeaders_StripsWholeHostShareFamily(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/files/read", nil)
	family := []string{
		"X-Yaver-HostShare",
		"X-Yaver-HostShareRoot",
		"X-Yaver-HostShareUserID",
		"X-Yaver-HostShareProject",
		"X-Yaver-HostShareAllowedProjects",
		"X-Yaver-HostShareAllowedRunners",
	}
	for _, h := range family {
		r.Header.Set(h, "attacker-supplied")
	}
	// Sanity: the guest family too, since they share the same defensive strip.
	r.Header.Set("X-Yaver-Guest", "true")
	r.Header.Set("X-Yaver-Support", "true")

	stripGuestRequestHeaders(r)

	for _, h := range append(family, "X-Yaver-Guest", "X-Yaver-Support") {
		if v := r.Header.Get(h); v != "" {
			t.Errorf("%s survived the strip (%q) — a caller can forge this trust header", h, v)
		}
	}
}

// HOST-SHARE PROJECT ALLOWLIST FAILED OPEN. Empty is the DEFAULT (--projects is
// optional), so the common case granted every project instead of none.
func TestHostShareCanAccessProject_FailsClosedWhenNoProjectsGranted(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/files/read", nil)
	// No X-Yaver-HostShareAllowedProjects header at all == nothing granted.
	if hostShareCanAccessProject(r, "/Users/victim/secret-project") {
		t.Fatal("empty host-share allowlist granted access — " +
			"\"no projects were granted to you\" must mean none, never all")
	}

	r2 := httptest.NewRequest(http.MethodGet, "/files/read", nil)
	r2.Header.Set("X-Yaver-HostShareAllowedProjects", "shared-app")
	if !hostShareCanAccessProject(r2, "/Users/host/shared-app") {
		t.Fatal("an explicitly granted project was refused — guard is too broad")
	}
	if hostShareCanAccessProject(r2, "/Users/host/other-app") {
		t.Fatal("a project outside the allowlist was granted")
	}
}

// SUPPORT SESSIONS are gated at the lookup, so every caller is covered rather
// than just the HTTP handler.
func TestSupportSessionRedeem_RefusedWhileFeatureOff(t *testing.T) {
	sess := StartSupportSession(SupportStartOptions{Label: "test"})
	if sess == nil || sess.Code == "" {
		t.Fatal("could not start a support session for the test")
	}
	defer StopSupportSession()

	if got := supportSessionRedeem(sess.Code); got != nil {
		t.Fatal("a support code was redeemed while support sessions are disabled — " +
			"the kill switch must refuse at the lookup, not only in the handler")
	}
}

// COMPANION TOKEN ESCALATION. A tvOS/watch/vision session reaches POST /ops
// legitimately (companionSessionAllowed admits it for the watch voice lane) but
// carries none of the guest/support/host-share headers, so ops_http derived
// caller="owner" — and ops.go restricts only caller=="guest". A stolen TV token
// therefore reached the `run` verb and executed commands, contradicting the
// promise in httpserver.go that it could not.
//
// To see this fail, delete the X-Yaver-SessionScope branch in
// opsCallerFromRequest.
func TestOpsCallerFromRequest_CompanionIsNotOwner(t *testing.T) {
	for _, scope := range []string{"tv", "watch", "vision", "spatial"} {
		t.Run(scope, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/ops", nil)
			r.Header.Set("X-Yaver-SessionScope", scope)

			caller, got := opsCallerFromRequest(r)
			if caller == "owner" {
				t.Fatalf("a %q companion session was treated as the OWNER — "+
					"it reaches the `run` verb and executes commands on the box", scope)
			}
			if got != scope {
				t.Fatalf("companion scope lost: caller=%q scope=%q (want scope %q); "+
					"without it guestVerbAllowed cannot gate per-surface", caller, got, scope)
			}
		})
	}
}

// The owner must still be the owner — the fix has to be narrow enough that a
// normal request is unaffected.
func TestOpsCallerFromRequest_OwnerUnchanged(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/ops", nil)
	if caller, _ := opsCallerFromRequest(r); caller != "owner" {
		t.Fatalf("a plain owner request derived caller=%q, want owner", caller)
	}
	// A non-companion session scope (e.g. a full mobile session) is still owner.
	r2 := httptest.NewRequest(http.MethodPost, "/ops", nil)
	r2.Header.Set("X-Yaver-SessionScope", "full")
	if caller, _ := opsCallerFromRequest(r2); caller != "owner" {
		t.Fatalf("a full-scope session derived caller=%q, want owner", caller)
	}
}

// The stamped scope must be unforgeable: an inbound copy is stripped before any
// handler sees it, so a caller cannot promote or demote themselves.
func TestStripGuestRequestHeaders_StripsSessionScope(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/ops", nil)
	r.Header.Set("X-Yaver-SessionScope", "full") // attacker trying to look like the owner
	stripGuestRequestHeaders(r)
	if v := r.Header.Get("X-Yaver-SessionScope"); v != "" {
		t.Fatalf("caller-supplied X-Yaver-SessionScope survived (%q) — forgeable identity", v)
	}
}
