package main

// attach_session.go — the credential for Attach Mode (Yaver rendering Yaver).
//
// ── What Attach Mode is ──────────────────────────────────────────────────────
//
// The phone renders Yaver's OWN mobile app, served as RN-web from this box over
// the browser lane, full-screen. You then vibe from Tasks against the same
// checkout and the surface refreshes when the turn lands. The app you are
// looking at is the app being edited.
//
// ── Why this file is not "seed the session token" ────────────────────────────
//
// The obvious implementation is to hand the attached WebView the user's Yaver
// session bearer so the inner app is signed in. That is a bad trade, and it is
// worth writing down because it will look tempting again:
//
// The attached surface renders ARBITRARY JAVASCRIPT FROM A DEV SERVER. Metro
// serves whatever is in the checkout, which includes every transitive package
// under node_modules. Put a session token in that page's localStorage and one
// compromised dependency in the user's own repo can read it and POST it
// anywhere. What leaks is not scoped to this box: a Yaver session is a 1-year
// credential that refreshes on every heartbeat and authenticates the user
// against Convex AND every other machine they own. "My dev branch pulled a bad
// package" would escalate to account takeover.
//
// This repo has already learned the smaller version of that lesson twice —
// probeTargets.go/ts stopped attaching a session bearer to plaintext probes,
// and relay/webview_cookie.go stopped putting the relay password in a query
// string. Same shape, bigger blast radius.
//
// ── What this is instead ─────────────────────────────────────────────────────
//
// A CAPABILITY, not a credential:
//
//	attach.<sessionID>.<expiryUnix>.<base64 hmac>
//
// The HMAC is over that tuple keyed by a secret this process generates at
// startup and never writes down. The token carries no session material. It can
// be forged only by someone who already holds the secret — who did not need a
// capability. It is meaningful only to the agent that minted it, and only until
// it expires or the session is revoked.
//
// Preconditions, all checked at MINT time, deny by default:
//
//  1. the caller is the OWNER (s.auth already established a valid bearer; we
//     additionally refuse guests and support sessions, which are precisely the
//     principals that must never get one);
//  2. IsYaverSelfDevelopmentDir(workDir) is TRUE. This is the structural
//     guarantee. Attach Mode's capability CANNOT be minted for a third-party
//     project, because the mint refuses any workDir that is not Yaver's own
//     checkout. Not a documented promise — a precondition with a test that
//     fails when it is removed.
//
// Properties, each deliberate:
//
//   - delivered as an HttpOnly cookie scoped to the attach path, so page JS can
//     USE the authority but can never READ or MOVE it. This is the entire point;
//     localStorage would defeat it.
//   - never in a URL or query string (house rule — tokens in URLs land in access
//     logs, history and Referer headers).
//   - minutes-long TTL, refreshed by the host while attached.
//   - explicit route allow-list, deny by default (attachScopeAllows).
//   - revoked server-side on detach, in addition to the client clearing its
//     cookie. Either alone is a false green.
//   - dies with the process, so an agent restart cannot leave authority behind.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// attachCookieName is what the attached WebView sends back.
	attachCookieName = "yaver_attach"
	// attachTokenTTL is short on purpose: long enough to render and iterate,
	// short enough that a leaked capability is quickly worthless. The host
	// refreshes it while the surface is open.
	attachTokenTTL = 10 * time.Minute
	// attachSessionMaxIdle bounds a session whose host stopped refreshing —
	// a backgrounded app or a phone that went away must not leave authority
	// alive indefinitely.
	attachSessionMaxIdle = 30 * time.Minute
)

// attachSession is one live Attach Mode session on this box.
type attachSession struct {
	ID string
	// WorkDir is Yaver's own checkout. Verified at mint time and pinned for
	// the life of the session — a capability must not follow the user to a
	// different project.
	WorkDir   string
	UserID    string
	CreatedAt time.Time
	LastSeen  time.Time
}

var (
	attachMu       sync.RWMutex
	attachSessions = map[string]*attachSession{}
	attachSecret   []byte
	attachSecretMu sync.Mutex
)

// attachSigningSecret returns the process-local HMAC key, generating it on
// first use.
//
// Deliberately NOT derived from the agent's auth token and NOT persisted:
// capabilities should not survive a restart, and the signing key should have no
// relationship to a credential that does.
func attachSigningSecret() []byte {
	attachSecretMu.Lock()
	defer attachSecretMu.Unlock()
	if attachSecret == nil {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			// A capability we cannot sign safely is one we must not issue.
			// Leaving the secret nil makes every mint and verify fail closed.
			return nil
		}
		attachSecret = buf
	}
	return attachSecret
}

func attachSignature(sessionID string, expiry int64) (string, bool) {
	secret := attachSigningSecret()
	if len(secret) == 0 {
		return "", false
	}
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%s.%d", sessionID, expiry)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), true
}

// MintAttachCapability issues a signed, expiring capability for an existing
// session. Returns "" when it cannot be signed safely.
func MintAttachCapability(sessionID string, now time.Time) (token string, expiry time.Time) {
	exp := now.Add(attachTokenTTL)
	sig, ok := attachSignature(sessionID, exp.Unix())
	if !ok {
		return "", time.Time{}
	}
	return fmt.Sprintf("attach.%s.%d.%s", sessionID, exp.Unix(), sig), exp
}

// VerifyAttachCapability checks signature, expiry AND liveness of the session.
//
// All three matter independently: a well-signed token for a revoked session
// must fail (that is what detach means), and a live session does not excuse an
// expired or forged token.
func VerifyAttachCapability(token string, now time.Time) (*attachSession, bool) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 4 || parts[0] != "attach" {
		return nil, false
	}
	sessionID, expRaw, sig := parts[1], parts[2], parts[3]
	exp, err := strconv.ParseInt(expRaw, 10, 64)
	if err != nil {
		return nil, false
	}
	want, ok := attachSignature(sessionID, exp)
	if !ok {
		return nil, false
	}
	// Constant-time: a short-circuit here leaks the signature byte by byte.
	if subtle.ConstantTimeCompare([]byte(want), []byte(sig)) != 1 {
		return nil, false
	}
	if now.Unix() > exp {
		return nil, false
	}

	attachMu.RLock()
	sess, live := attachSessions[sessionID]
	attachMu.RUnlock()
	if !live {
		return nil, false // revoked, or from a previous process
	}
	if now.Sub(sess.LastSeen) > attachSessionMaxIdle {
		// The host stopped refreshing. Treat as gone rather than letting a
		// forgotten session keep authority.
		RevokeAttachSession(sessionID)
		return nil, false
	}
	return sess, true
}

// StartAttachSession creates a session for workDir.
//
// REFUSES any workDir that is not Yaver's own checkout. This is the guarantee
// that Attach Mode's capability can never generalize to a third-party preview,
// and it is enforced here rather than at any call site so a future caller
// inherits it.
func StartAttachSession(workDir, userID string, now time.Time) (*attachSession, error) {
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return nil, fmt.Errorf("attach: workDir is required")
	}
	if !IsYaverSelfDevelopmentDir(workDir) {
		return nil, fmt.Errorf(
			"attach: %s is not the Yaver checkout — Attach Mode renders Yaver's own app and "+
				"its capability is never minted for another project", workDir)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("attach: could not generate a session id: %w", err)
	}
	sess := &attachSession{
		ID:        base64.RawURLEncoding.EncodeToString(buf),
		WorkDir:   workDir,
		UserID:    userID,
		CreatedAt: now,
		LastSeen:  now,
	}
	attachMu.Lock()
	attachSessions[sess.ID] = sess
	attachMu.Unlock()
	return sess, nil
}

// TouchAttachSession marks a session live (called on refresh).
func TouchAttachSession(sessionID string, now time.Time) bool {
	attachMu.Lock()
	defer attachMu.Unlock()
	sess, ok := attachSessions[sessionID]
	if !ok {
		return false
	}
	sess.LastSeen = now
	return true
}

// RevokeAttachSession is detach, server-side. After this every capability for
// the session fails verification regardless of its expiry.
func RevokeAttachSession(sessionID string) bool {
	attachMu.Lock()
	defer attachMu.Unlock()
	_, ok := attachSessions[sessionID]
	delete(attachSessions, sessionID)
	return ok
}

// attachAllowedRoutes is the ALLOW-LIST. Deny by default.
//
// The principle: the attached app needs enough to feel at home, which is far
// less than a session. What is absent is as deliberate as what is present —
// vault, deploy, auth mutations, device approval, SDK-token and guest creation,
// exec/shell/remote-desktop, settings mutation and anything that writes to a
// DIFFERENT device are all excluded, because their abuse is either irreversible
// or reaches beyond the box being attached.
//
// Starting a coding task IS allowed and is genuinely powerful — that is the
// feature. It is bounded by the capability being owner-only, short-lived,
// origin-pinned and revocable, rather than by being weak.
var attachAllowedRoutes = []struct {
	prefix  string
	methods []string
}{
	{"/info", []string{"GET"}},
	{"/health", []string{"GET"}},
	{"/devices", []string{"GET"}},
	{"/tasks", []string{"GET", "POST"}},
	{"/dev/status", []string{"GET"}},
	{"/dev/events", []string{"GET"}},
	{"/dev/reload", []string{"POST"}},
	{"/dev-web/", []string{"GET", "HEAD"}},
	{"/attach/refresh", []string{"POST"}},
	{"/attach/stop", []string{"POST"}},
}

// attachScopeAllows reports whether an attach capability may reach this route.
func attachScopeAllows(method, path string) bool {
	method = strings.ToUpper(strings.TrimSpace(method))
	for _, rule := range attachAllowedRoutes {
		if path != rule.prefix && !strings.HasPrefix(path, rule.prefix) {
			continue
		}
		// An exact-path rule ("/tasks") must not silently cover deeper paths
		// that mean something else; only rules written with a trailing slash
		// are prefix rules.
		if !strings.HasSuffix(rule.prefix, "/") && path != rule.prefix {
			// Allow "/tasks/<id>" style subpaths for the collection routes,
			// but nothing that changes the leading segment.
			if !strings.HasPrefix(path, rule.prefix+"/") {
				continue
			}
		}
		for _, m := range rule.methods {
			if m == method {
				return true
			}
		}
		return false
	}
	return false
}

// setAttachCookie writes the capability as an HttpOnly cookie.
//
// HttpOnly is the whole design: the attached page's JavaScript can send the
// cookie (the browser attaches it automatically to same-origin requests) but
// cannot read it, so a hostile bundle in the checkout has no way to exfiltrate
// the authority it is nonetheless able to use.
func setAttachCookie(w http.ResponseWriter, r *http.Request, token string, expiry time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     attachCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expiry,
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearAttachCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     attachCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
	})
}
