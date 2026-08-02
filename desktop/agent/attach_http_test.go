package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A guest or support bearer reached this handler only because s.auth() accepted
// it. Attach Mode must still refuse: being allowed to use the box is not being
// allowed to render its source and run coding turns against it.
func TestAttachStartRefusesGuestAndSupportPrincipals(t *testing.T) {
	s := &HTTPServer{}
	for _, header := range []string{"X-Yaver-Guest", "X-Yaver-Support"} {
		body := strings.NewReader(`{"workDir":"/tmp"}`)
		r := httptest.NewRequest(http.MethodPost, "/attach/start", body)
		r.Header.Set(header, "true")
		w := httptest.NewRecorder()
		s.handleAttachStart(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s: status %d, want 403", header, w.Code)
		}
		var resp attachStartResponse
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp.Code != "ATTACH_OWNER_ONLY" {
			t.Fatalf("%s: code %q, want ATTACH_OWNER_ONLY", header, resp.Code)
		}
		if resp.Remedy == "" {
			t.Fatalf("%s: refusal carried no remedy", header)
		}
	}
}

// A non-Yaver workDir is refused at the HTTP boundary too, with a stable code
// so no surface has to regex the sentence.
func TestAttachStartRefusesForeignWorkDirWithAStableCode(t *testing.T) {
	s := &HTTPServer{}
	r := httptest.NewRequest(http.MethodPost, "/attach/start",
		strings.NewReader(`{"workDir":"`+thirdPartyDir(t)+`"}`))
	w := httptest.NewRecorder()
	s.handleAttachStart(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", w.Code)
	}
	var resp attachStartResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Code != "ATTACH_NOT_YAVER_CHECKOUT" {
		t.Fatalf("code %q, want ATTACH_NOT_YAVER_CHECKOUT", resp.Code)
	}
}

// The happy path sets an HttpOnly cookie. HttpOnly is the entire security
// argument: the attached page can USE the capability but never READ it, so a
// hostile bundle in the checkout cannot exfiltrate it.
func TestAttachStartSetsAnHttpOnlyCookieAndNoTokenInTheBody(t *testing.T) {
	s := &HTTPServer{}
	dir := yaverCheckoutDir(t)
	r := httptest.NewRequest(http.MethodPost, "/attach/start",
		strings.NewReader(`{"workDir":"`+dir+`"}`))
	w := httptest.NewRecorder()
	s.handleAttachStart(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", w.Code, w.Body.String())
	}

	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == attachCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no attach cookie set")
	}
	if !cookie.HttpOnly {
		t.Fatal("attach cookie is readable by page JS — that defeats the whole design")
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("SameSite = %v, want Lax", cookie.SameSite)
	}

	// The capability must NOT also appear in the response body, where page JS
	// or a log could pick it up.
	if strings.Contains(w.Body.String(), cookie.Value) {
		t.Fatal("the capability was echoed into the response body")
	}
	var resp attachStartResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.SessionID == "" {
		t.Fatal("no session id returned")
	}
	RevokeAttachSession(resp.SessionID)
}

// The middleware must confine a capability to the allow-list, and must never
// let one fall through to the owner-bearer path.
func TestAttachOrAuthConfinesTheCapability(t *testing.T) {
	s := &HTTPServer{}
	sess, err := StartAttachSession(yaverCheckoutDir(t), "user-1", time.Now())
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer RevokeAttachSession(sess.ID)
	tok, _ := MintAttachCapability(sess.ID, time.Now())

	call := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.AddCookie(&http.Cookie{Name: attachCookieName, Value: tok})
		w := httptest.NewRecorder()
		s.attachOrAuth(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})(w, r)
		return w
	}

	if got := call(http.MethodGet, "/tasks"); got.Code != http.StatusOK {
		t.Fatalf("in-scope route rejected: %d %s", got.Code, got.Body.String())
	}

	for _, denied := range []struct{ method, path string }{
		{http.MethodGet, "/vault"},
		{http.MethodPost, "/deploy"},
		{http.MethodPost, "/auth/logout"},
		{http.MethodPost, "/dev/build-native"},
	} {
		got := call(denied.method, denied.path)
		if got.Code != http.StatusForbidden {
			t.Fatalf("%s %s: status %d, want 403 — the capability escaped its scope",
				denied.method, denied.path, got.Code)
		}
		var resp attachStartResponse
		_ = json.Unmarshal(got.Body.Bytes(), &resp)
		if resp.Code != "ATTACH_OUT_OF_SCOPE" {
			t.Fatalf("%s %s: code %q, want ATTACH_OUT_OF_SCOPE", denied.method, denied.path, resp.Code)
		}
	}

	// A revoked capability must be rejected outright, not silently downgraded
	// to the bearer path.
	RevokeAttachSession(sess.ID)
	if got := call(http.MethodGet, "/tasks"); got.Code != http.StatusUnauthorized {
		t.Fatalf("revoked capability: status %d, want 401", got.Code)
	}
}
