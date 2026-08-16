package main

// codex_credential.go — reading, dating, and safely rewriting ~/.codex/auth.json.
//
// WHY THIS FILE EXISTS (audit 2026-08-02, user driving tasks from a phone against an
// Ubuntu 4 GB box while on holiday): Codex signed out repeatedly, and the follow-up
// prompt was the thing that discovered it. Three measured facts drove the design:
//
//  1. The Codex access token lives 240 h (10 days); the id_token lives 1 h. Both are
//     plain JWTs sitting in a file we already open. The expiry is therefore FREE to
//     know — zero network, zero fork, zero tokens.
//  2. `codex login status` is a PRESENCE probe: 0.08 s, does not read `exp`, does not
//     refresh, does not touch the file. It answers "Logged in using ChatGPT" over a
//     ten-day-dead token. It is not, and cannot be made into, a liveness check.
//  3. The refresh token ROTATES on every use. So the file is not a static secret —
//     it is a lineage, and whoever writes it carelessly destroys the login. That is
//     why every write here is atomic, mode-preserving, and field-preserving.
//
// The field-preservation point is the subtle one. Codex's auth.json schema has shifted
// across versions and will shift again. If we unmarshal into a struct we know and
// marshal it back, every field we do not model is SILENTLY DROPPED — and the file we
// hand back to Codex is a strictly worse file than the one we found. So the document
// is carried as a generic map and only the two leaves we actually rotate are touched.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// codexCredentialDoc is the whole auth.json, preserved verbatim except for the leaves
// we deliberately rotate. `raw` is the source of truth for writing; the typed accessors
// are conveniences for reading.
type codexCredentialDoc struct {
	raw  map[string]any
	path string
	// mode is the file mode observed on read, re-applied on write so we never
	// widen permissions on a credential (0600 is the floor, never the ceiling).
	mode os.FileMode
}

var errNoCodexCredential = errors.New("no codex credential on this machine")

// readCodexCredentialDoc loads auth.json. A missing file is errNoCodexCredential
// (a normal, expected state — not signed in), distinguishable from a corrupt one.
func readCodexCredentialDoc(path string) (*codexCredentialDoc, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errNoCodexCredential
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errNoCodexCredential
		}
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		// A zero-byte auth.json is the fingerprint of a process killed mid-write —
		// the OOM shape on a 4 GB box. Name it, because "invalid JSON" would send
		// the reader looking for a parser bug.
		return nil, fmt.Errorf("codex credential at %s is EMPTY (0 bytes) — a write was interrupted, most likely by an OOM kill; the credential must be re-established", path)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("codex credential at %s is not valid JSON (%d bytes) — a write was likely interrupted: %w", path, len(data), err)
	}
	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0600
	}
	return &codexCredentialDoc{raw: raw, path: path, mode: mode}, nil
}

// tokens returns the mutable tokens sub-object, or nil when absent.
func (d *codexCredentialDoc) tokens() map[string]any {
	if d == nil || d.raw == nil {
		return nil
	}
	t, _ := d.raw["tokens"].(map[string]any)
	return t
}

func (d *codexCredentialDoc) tokenString(key string) string {
	t := d.tokens()
	if t == nil {
		return ""
	}
	s, _ := t[key].(string)
	return strings.TrimSpace(s)
}

func (d *codexCredentialDoc) accessToken() string  { return d.tokenString("access_token") }
func (d *codexCredentialDoc) refreshToken() string { return d.tokenString("refresh_token") }
func (d *codexCredentialDoc) accountID() string    { return d.tokenString("account_id") }

// apiKeyMode reports whether this credential is an API-key login rather than a
// ChatGPT subscription one. House law is subscription-only, and an API-key
// credential has no refresh lineage at all — refreshing it is meaningless.
func (d *codexCredentialDoc) apiKeyMode() bool {
	if d == nil || d.raw == nil {
		return false
	}
	if k, ok := d.raw["OPENAI_API_KEY"].(string); ok && strings.TrimSpace(k) != "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(fmt.Sprint(d.raw["auth_mode"])), "apikey")
}

// accessTokenExpiry returns the access token's `exp` as a time, and whether it was
// readable. Unreadable is NOT an error state — an opaque token is a legitimate future
// shape; callers fall back to "unknown" and must not treat that as expired.
func (d *codexCredentialDoc) accessTokenExpiry() (time.Time, bool) {
	return jwtUnverifiedExpiry(d.accessToken())
}

// lastRefresh reads the `last_refresh` stamp Codex maintains.
func (d *codexCredentialDoc) lastRefresh() (time.Time, bool) {
	if d == nil || d.raw == nil {
		return time.Time{}, false
	}
	s, _ := d.raw["last_refresh"].(string)
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if ts, err := time.Parse(layout, s); err == nil {
			return ts, true
		}
	}
	return time.Time{}, false
}

// jwtUnverifiedExpiry decodes a JWT payload and returns its `exp`.
//
// UNVERIFIED, and that is correct here: we are reading the expiry of a token we
// already hold in our own 0600 file in order to decide WHEN TO REFRESH IT. No
// authorization decision is made from this value, so there is no signature to check
// and no key to check it with. Never use this function to trust a token's contents.
func jwtUnverifiedExpiry(token string) (time.Time, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return time.Time{}, false
	}
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(claims.Exp), 0), true
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

// codexRefreshWindow is how long before expiry we start renewing.
//
// 24 h against a 240 h token. Wide enough that a box which is asleep, offline, or
// merely busy gets many chances to renew before anything breaks; narrow enough that
// we are not refreshing constantly. The cost asymmetry is the whole argument: a
// refresh is one HTTP request, and a miss costs the user their session.
const codexRefreshWindow = 24 * time.Hour

// codexCredentialFreshness is the verdict, computed with zero I/O beyond the file.
type codexCredentialFreshness struct {
	// ExpiresAt is the access token expiry; zero when unreadable.
	ExpiresAt time.Time
	// Known is false when the token carried no readable expiry.
	Known bool
	// Expired is true only when we KNOW the token is past its expiry.
	Expired bool
	// NeedsRefresh is true when the token is inside the renewal window (or past it).
	// Always false when Known is false — we do not renew on a guess.
	NeedsRefresh bool
	// APIKeyMode credentials have no refresh lineage.
	APIKeyMode bool
	// HasRefreshToken reports whether a renewal is even possible.
	HasRefreshToken bool
}

func codexCredentialFreshnessOf(d *codexCredentialDoc, now time.Time) codexCredentialFreshness {
	f := codexCredentialFreshness{
		APIKeyMode:      d.apiKeyMode(),
		HasRefreshToken: d.refreshToken() != "",
	}
	exp, ok := d.accessTokenExpiry()
	if !ok {
		return f
	}
	f.ExpiresAt, f.Known = exp, true
	f.Expired = !now.Before(exp)
	f.NeedsRefresh = now.Add(codexRefreshWindow).After(exp)
	return f
}

// describe renders the freshness for a human, without ever printing token material.
func (f codexCredentialFreshness) describe(now time.Time) string {
	if f.APIKeyMode {
		return "API-key credential (no refresh lineage)"
	}
	if !f.Known {
		return "expiry unknown (token is not a readable JWT)"
	}
	if f.Expired {
		return fmt.Sprintf("EXPIRED %s ago", now.Sub(f.ExpiresAt).Round(time.Minute))
	}
	return fmt.Sprintf("valid for %s", f.ExpiresAt.Sub(now).Round(time.Minute))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// applyRefreshedTokens updates only the leaves a refresh rotates, leaving every other
// field — known or unknown, now or in a future Codex version — exactly as found.
//
// An empty newRefresh is NOT an error: a server that does not rotate on this call
// legitimately omits it, and blanking our only refresh token in that case would
// destroy the lineage. Keep what we have.
func (d *codexCredentialDoc) applyRefreshedTokens(newAccess, newRefresh, newID string, at time.Time) error {
	if d == nil || d.raw == nil {
		return errors.New("no credential document")
	}
	if strings.TrimSpace(newAccess) == "" {
		return errors.New("refresh response carried no access token")
	}
	t := d.tokens()
	if t == nil {
		t = map[string]any{}
		d.raw["tokens"] = t
	}
	t["access_token"] = newAccess
	if strings.TrimSpace(newRefresh) != "" {
		t["refresh_token"] = newRefresh
	}
	if strings.TrimSpace(newID) != "" {
		t["id_token"] = newID
	}
	d.raw["last_refresh"] = at.UTC().Format(time.RFC3339Nano)
	return nil
}

// writeAtomic persists the document via tmp-file + fsync + rename in the SAME
// directory, so a reader (Codex, or our own probe) never observes a partial file and
// a crash mid-write cannot truncate the credential.
//
// This is the direct countermeasure to the empty/corrupt auth.json shape called out
// in readCodexCredentialDoc: with rename(2) the file is either the old one or the new
// one, never half of either.
func (d *codexCredentialDoc) writeAtomic() error {
	if d == nil || d.raw == nil || strings.TrimSpace(d.path) == "" {
		return errors.New("no credential document to write")
	}
	data, err := json.MarshalIndent(d.raw, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	mode := d.mode
	if mode == 0 {
		mode = 0600
	}
	// Never widen. If the file was somehow group/world readable we tighten it here
	// rather than faithfully reproducing a bad permission on a credential.
	mode &= 0600

	dir := filepath.Dir(d.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".auth-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once renamed

	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, d.path)
}
