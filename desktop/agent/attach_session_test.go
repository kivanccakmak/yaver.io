package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// yaverCheckoutDir builds a directory that IsYaverSelfDevelopmentDir accepts.
func yaverCheckoutDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"),
		[]byte(`{"name":"yaver-mobile"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir
}

func thirdPartyDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"),
		[]byte(`{"name":"todo-rn","dependencies":{"expo":"*"}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir
}

// THE ONE THAT MATTERS. The capability must be structurally impossible to mint
// for anything but Yaver's own checkout — that is what keeps Attach Mode's
// authority from ever generalizing to a third-party preview, where the page is
// someone else's code.
//
// Break it by deleting the IsYaverSelfDevelopmentDir check in
// StartAttachSession and this fails.
func TestAttachRefusesAnyProjectThatIsNotYaver(t *testing.T) {
	now := time.Now()
	if _, err := StartAttachSession(thirdPartyDir(t), "user-1", now); err == nil {
		t.Fatal("minted an attach session for a third-party project — the capability generalized")
	} else if !strings.Contains(err.Error(), "not the Yaver checkout") {
		t.Fatalf("refusal did not name the cause: %v", err)
	}

	// Empty is refused too — an unspecified workDir must never fall back to
	// "whatever directory the daemon is sitting in".
	if _, err := StartAttachSession("", "user-1", now); err == nil {
		t.Fatal("minted an attach session with no workDir")
	}

	// And the legitimate case still works, or the guard is useless.
	if _, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now); err != nil {
		t.Fatalf("refused the Yaver checkout: %v", err)
	}
}

func TestAttachCapabilityRoundTrips(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)

	tok, exp := MintAttachCapability(sess.ID, now)
	if tok == "" {
		t.Fatal("minted an empty capability")
	}
	if !exp.After(now) {
		t.Fatal("capability expires in the past")
	}
	got, ok := VerifyAttachCapability(tok, now)
	if !ok {
		t.Fatal("freshly minted capability did not verify")
	}
	if got.ID != sess.ID || got.WorkDir != sess.WorkDir {
		t.Fatalf("verified the wrong session: %+v", got)
	}
	// The capability must not contain the session's secrets or the user id.
	if strings.Contains(tok, "user-1") {
		t.Fatal("capability leaks the user id")
	}
}

// Detach must be real: a capability that is still well-signed and unexpired
// must stop working the moment the session is revoked. Clearing only the
// client's cookie would be a false green.
func TestRevokedSessionRejectsAStillValidToken(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	tok, _ := MintAttachCapability(sess.ID, now)
	if _, ok := VerifyAttachCapability(tok, now); !ok {
		t.Fatal("precondition: token should verify before revoke")
	}
	RevokeAttachSession(sess.ID)
	if _, ok := VerifyAttachCapability(tok, now); ok {
		t.Fatal("a revoked session still accepted its capability — detach does not detach")
	}
}

func TestExpiredCapabilityIsRejected(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)
	tok, _ := MintAttachCapability(sess.ID, now)
	if _, ok := VerifyAttachCapability(tok, now.Add(attachTokenTTL+time.Second)); ok {
		t.Fatal("expired capability accepted")
	}
}

func TestForgedCapabilitiesAreRejected(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)
	good, _ := MintAttachCapability(sess.ID, now)
	parts := strings.Split(good, ".")

	forgeries := map[string]string{
		"tampered signature": strings.Join([]string{parts[0], parts[1], parts[2], "AAAA"}, "."),
		"extended expiry":    strings.Join([]string{parts[0], parts[1], "99999999999", parts[3]}, "."),
		"other session":      strings.Join([]string{parts[0], "someoneelse", parts[2], parts[3]}, "."),
		"wrong prefix":       strings.Join([]string{"session", parts[1], parts[2], parts[3]}, "."),
		"empty":              "",
		"garbage":            "not-a-token",
		"missing parts":      strings.Join(parts[:3], "."),
	}
	for name, tok := range forgeries {
		if _, ok := VerifyAttachCapability(tok, now); ok {
			t.Fatalf("forgery accepted (%s): %q", name, tok)
		}
	}
}

// An idle session must expire on its own. A host that backgrounds or vanishes
// must not leave live authority behind.
func TestIdleSessionExpires(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)
	// Mint a token that is still unexpired at the far-future check time, so
	// the ONLY thing that can reject it is the idle bound.
	future := now.Add(attachSessionMaxIdle + time.Minute)
	tok, _ := MintAttachCapability(sess.ID, future)
	if _, ok := VerifyAttachCapability(tok, future); ok {
		t.Fatal("an idle session kept its authority past the idle bound")
	}
}

func TestTouchKeepsASessionAlive(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", now)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)
	later := now.Add(attachSessionMaxIdle - time.Minute)
	if !TouchAttachSession(sess.ID, later) {
		t.Fatal("touch failed for a live session")
	}
	tok, _ := MintAttachCapability(sess.ID, later)
	if _, ok := VerifyAttachCapability(tok, later); !ok {
		t.Fatal("a refreshed session lost its authority")
	}
	if TouchAttachSession("no-such-session", later) {
		t.Fatal("touched a session that does not exist")
	}
}

// ── Scope ──────────────────────────────────────────────────────────────────

// Deny by default. The denied set is the point of the allow-list: every entry
// below is either irreversible or reaches beyond the attached box.
func TestAttachScopeDeniesTheDangerousRoutes(t *testing.T) {
	denied := []struct{ method, path string }{
		{"GET", "/vault"},
		{"POST", "/vault/add"},
		{"POST", "/deploy"},
		{"POST", "/auth/logout"},
		{"POST", "/auth/link"},
		{"POST", "/settings/repair-relay"},
		{"POST", "/sdk-token/create"},
		{"POST", "/guests/invite"},
		{"POST", "/exec"},
		{"POST", "/rd/input"},
		{"GET", "/rd/stream"},
		{"POST", "/approve-device"},
		{"POST", "/dev/build-native"}, // Hermes: refused for self-dev anyway
		{"DELETE", "/tasks"},          // wrong method on an allowed prefix
		{"POST", "/info"},             // wrong method on an allowed prefix
		{"GET", "/"},                  // must not match everything
		{"GET", "/tasksecret"},        // prefix must not leak into a sibling route
	}
	for _, c := range denied {
		if attachScopeAllows(c.method, c.path) {
			t.Fatalf("attach scope ALLOWED a denied route: %s %s", c.method, c.path)
		}
	}
}

func TestAttachScopeAllowsWhatTheSurfaceNeeds(t *testing.T) {
	allowed := []struct{ method, path string }{
		{"GET", "/info"},
		{"GET", "/devices"},
		{"GET", "/tasks"},
		{"POST", "/tasks"},
		{"GET", "/tasks/abc123"},
		{"GET", "/dev/status"},
		{"GET", "/dev/events"},
		{"POST", "/dev/reload"},
		{"GET", "/dev-web/"},
		{"GET", "/dev-web/static/js/entry.bundle"},
		{"POST", "/attach/refresh"},
		{"POST", "/attach/stop"},
	}
	for _, c := range allowed {
		if !attachScopeAllows(c.method, c.path) {
			t.Fatalf("attach scope DENIED a route the surface needs: %s %s", c.method, c.path)
		}
	}
}
