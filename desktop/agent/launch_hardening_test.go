package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Guards the permanent removal of non-owner MCP and request-header paths.

func TestRemovedGuestAndChatMCPToolsStayUnadvertisedAndRejected(t *testing.T) {
	srv := &HTTPServer{}
	listed, ok := srv.getMCPToolsList().(map[string]interface{})
	if !ok {
		t.Fatal("unexpected MCP tools/list response shape")
	}
	tools, ok := listed["tools"].([]map[string]interface{})
	if !ok {
		t.Fatal("unexpected MCP tools list shape")
	}
	removed := map[string]bool{
		"guest_invite": true, "guest_list": true, "guest_revoke": true,
		"guest_delete": true, "guest_leave": true, "guest_accept": true,
		"guest_config": true, "guest_usage": true,
		"support_start": true, "support_status": true, "support_stop": true,
		"chat_conversations": true, "chat_history": true, "chat_reply": true,
		"project_test_grow": true,
	}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		if removed[name] {
			t.Fatalf("removed MCP tool %q is advertised by tools/list", name)
		}
	}
	for name := range removed {
		params, err := json.Marshal(map[string]interface{}{
			"name": name, "arguments": map[string]interface{}{},
		})
		if err != nil {
			t.Fatal(err)
		}
		result, ok := srv.handleMCPToolCall(params).(map[string]interface{})
		if !ok || result["isError"] != true {
			t.Fatalf("removed MCP tool %q did not fail closed: %#v", name, result)
		}
	}
}

// ── the underlying defects (flag-independent) ────────────────────────────────

// CROSS-TENANT SDK BYPASS. authSDK's cached branch validates scopes and
// CIDR but never checked WHOSE token it was, and the miss path cached the entry
// BEFORE the owner check. Send a foreign SDK token twice: request 1 caches and
// 403s, request 2 was authorized as the owner. To see this fail, delete the
// `info.userID != s.ownerUserID` check in the cached isSdk branch.
func TestAuthSDK_ForeignSdkTokenRejectedFromCache(t *testing.T) {
	srv := &HTTPServer{token: "owner-token", ownerUserID: "owner-user"}

	const foreign = "yv_sdk_attacker_token"
	srv.tokenCache.Store(foreign, &cachedTokenInfo{
		userID: "some-other-account", // a DIFFERENT Yaver account
		isSdk:  true,
		scopes: []string{"ops", "builds", "runners"},
	})

	called := false
	h := srv.authSDK(func(w http.ResponseWriter, _ *http.Request) {
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

	stripDelegatedRequestHeaders(r)

	for _, h := range append(family, "X-Yaver-Guest", "X-Yaver-Support") {
		if v := r.Header.Get(h); v != "" {
			t.Errorf("%s survived the strip (%q) — a caller can forge this trust header", h, v)
		}
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
					"without it scopedVerbAllowed cannot gate per-surface", caller, got, scope)
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
func TestStripDelegatedRequestHeaders_StripsSessionScope(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/ops", nil)
	r.Header.Set("X-Yaver-SessionScope", "full") // attacker trying to look like the owner
	stripDelegatedRequestHeaders(r)
	if v := r.Header.Get("X-Yaver-SessionScope"); v != "" {
		t.Fatalf("caller-supplied X-Yaver-SessionScope survived (%q) — forgeable identity", v)
	}
}
