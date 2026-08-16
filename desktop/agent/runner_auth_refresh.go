package main

// runner_auth_refresh.go — the keep-alive leg the product never had.
//
// THE PREMISE THIS FILE CORRECTS. `runner_preflight.go` opens by asserting that Yaver
// "cannot silently refresh a subscription OAuth token (claude / codex tokens are
// re-auth-only)". For Codex that is FALSE, and measurably so: codex-cli 0.142.5 speaks
// a standard `grant_type=refresh_token` exchange against
// https://auth.openai.com/oauth/token, and a login from April was still alive in August
// purely on rotation. That one wrong sentence is why the health loop only ever
// OBSERVED, why the 6 h probe could not see a 10-day expiry, and why the first thing
// to discover a dead credential was the user's next prompt.
//
// WHY YAVER MUST DO THIS ITSELF, AND WHY THAT IS SAFE HERE. Codex refreshes correctly
// *inside* a running process — proactively during a session, reactively on a 401. The
// gap is entirely "nothing runs between visits". There is no `codex login refresh`
// subcommand to delegate to (`codex login` exposes only `status`), so the choice is
// Yaver refreshing or nobody refreshing. The load-bearing safety fact is that Yaver
// spawns a FRESH Codex process for every turn: refreshing before the spawn both keeps
// the credential alive and sidesteps the open upstream bug where a live session cannot
// pick up an external refresh (openai/codex#17041).
//
// THE ONE WAY THIS CAN HURT, AND THE FOUR GUARDS. The refresh token ROTATES: every
// exchange consumes the old one. So a careless refresher does not degrade — it
// DESTROYS the login, and under RFC 9700's reuse-detection guidance a replayed token
// can revoke the whole family and sign out every machine on the account. Hence:
//
//  1. SINGLE FLIGHT — one refresh at a time per credential root, in-process and
//     across processes. Two concurrent refreshes is precisely the reuse the server
//     is watching for.
//  2. RE-READ UNDER THE LOCK — the winner may have already renewed it. If the file on
//     disk is fresh by the time we hold the lock, we make no network call at all.
//  3. ALL-OR-NOTHING WRITE — atomic rename, unknown fields preserved, and on ANY
//     failure the existing file is left exactly as found. A failed refresh must never
//     be worse than no refresh.
//  4. NEVER BLANK THE LINEAGE — a response without a rotated refresh token keeps the
//     one we hold (codex_credential.go: applyRefreshedTokens).
//
// Nothing here logs token material, and nothing here reaches Convex (privacy contract
// per CLAUDE.md — the credential never leaves the box).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// codexOAuthTokenURL is Codex's token endpoint, read out of the shipped binary
// (`strings` → https://auth.openai.com/oauth/token) rather than assumed.
const codexOAuthTokenURL = "https://auth.openai.com/oauth/token"

// codexOAuthClientID is the Codex CLI's PUBLIC OAuth client id, likewise read out of
// the shipped binary. A public client id is an identifier, not a secret — it is in
// every user's binary and it authorizes nothing on its own, so it belongs in code per
// CLAUDE.md's "public key material may live in code" split.
const codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

// codexRefreshHTTPTimeout bounds the exchange. Per CLAUDE.md's connectivity law every
// await in this path is wall-clock bounded; this is a request/response call, so it
// gets a deadline, not an unbounded wait.
const codexRefreshHTTPTimeout = 20 * time.Second

// codexRefreshOutcome names what happened, for logs and for the surfaces.
type codexRefreshOutcome string

const (
	codexRefreshRenewed     codexRefreshOutcome = "renewed"      // we exchanged and wrote a new token
	codexRefreshNotNeeded   codexRefreshOutcome = "not_needed"   // still outside the renewal window
	codexRefreshRacedFresh  codexRefreshOutcome = "raced_fresh"  // someone else renewed while we waited
	codexRefreshImpossible  codexRefreshOutcome = "impossible"   // no credential / no refresh token / api-key mode
	codexRefreshLineageLost codexRefreshOutcome = "lineage_lost" // invalid_grant — re-auth is the only fix
	codexRefreshFailed      codexRefreshOutcome = "failed"       // transient: network, 5xx, malformed
)

// codexRefreshResult is the verdict.
type codexRefreshResult struct {
	Outcome   codexRefreshOutcome `json:"outcome"`
	Reason    string              `json:"reason,omitempty"`
	Code      string              `json:"code,omitempty"`
	ExpiresAt time.Time           `json:"expiresAt,omitempty"`
	// Reauthable is true when the only remaining fix is a human sign-in.
	Reauthable bool `json:"reauthable,omitempty"`
}

// Renewed reports whether the credential is now good, whether or not we are the one
// who made it so.
func (r codexRefreshResult) Healthy() bool {
	switch r.Outcome {
	case codexRefreshRenewed, codexRefreshNotNeeded, codexRefreshRacedFresh:
		return true
	}
	return false
}

// codexRefreshMu serializes refreshes inside this process. Yaver runs concurrent
// tasks; without this, two follow-up turns starting together would both refresh and
// one would burn the other's token.
var codexRefreshMu sync.Mutex

// codexRefreshLockStale is how long a cross-process lock file may sit before a newer
// attempt takes it over. Bounded by construction: the holder can only legitimately
// hold it for one HTTP exchange, so anything older than this is a dead process, not a
// slow one. A guard that only its owner can release is exactly the wedge CLAUDE.md's
// connectivity law forbids.
const codexRefreshLockStale = 2 * time.Minute

// refreshCodexCredentialIfNeeded is the entry point every caller should use. It is
// cheap when there is nothing to do: one stat + one read + a base64 decode, no fork,
// no network, no tokens spent.
func refreshCodexCredentialIfNeeded(ctx context.Context, force bool) codexRefreshResult {
	path := codexAuthPath()
	doc, err := readCodexCredentialDoc(path)
	if err != nil {
		if errors.Is(err, errNoCodexCredential) {
			return codexRefreshResult{
				Outcome:    codexRefreshImpossible,
				Reason:     "Codex is not signed in on this machine.",
				Code:       ReasonRunnerCodexNotAuthenticated,
				Reauthable: true,
			}
		}
		// Corrupt / truncated file. Say what it is; do NOT try to "fix" it by
		// writing over it — the bytes are all the forensics there will be.
		return codexRefreshResult{
			Outcome:    codexRefreshImpossible,
			Reason:     err.Error(),
			Code:       ReasonRunnerCodexCredentialCorrupt,
			Reauthable: true,
		}
	}

	now := time.Now()
	fresh := codexCredentialFreshnessOf(doc, now)
	if fresh.APIKeyMode {
		return codexRefreshResult{
			Outcome: codexRefreshImpossible,
			Reason:  "This machine's Codex credential is an API key, which has no refresh lineage.",
		}
	}
	if !fresh.HasRefreshToken {
		return codexRefreshResult{
			Outcome:    codexRefreshImpossible,
			Reason:     "This machine's Codex credential carries no refresh token — only a fresh sign-in can renew it.",
			Code:       ReasonRunnerCodexNotAuthenticated,
			Reauthable: true,
		}
	}
	if !force && !fresh.NeedsRefresh {
		// Includes the "expiry unknown" case: we never renew on a guess.
		return codexRefreshResult{Outcome: codexRefreshNotNeeded, ExpiresAt: fresh.ExpiresAt}
	}
	// Guard 1a: do not renew somebody else's lineage. If this credential arrived as
	// a copy from another machine, renewing here consumes the refresh token THAT
	// machine still holds and signs it out — the oscillation described in
	// runner_auth_lineage.go. Refuse, and say which box it came from.
	if foreign, why := codexCredentialIsForeignCopy(path); foreign {
		return codexRefreshResult{
			Outcome:    codexRefreshImpossible,
			Reason:     why,
			Code:       ReasonRunnerCodexCredentialIsCopy,
			Reauthable: true,
		}
	}

	return refreshCodexCredentialLocked(ctx, path, force)
}

// refreshCodexCredentialLocked performs the exchange under both locks, re-reading the
// credential once it holds them.
func refreshCodexCredentialLocked(ctx context.Context, path string, force bool) codexRefreshResult {
	codexRefreshMu.Lock()
	defer codexRefreshMu.Unlock()

	release, ok := acquireCodexRefreshLock(path)
	if !ok {
		// Another PROCESS is mid-exchange. Its write is atomic, so the right move is
		// to do nothing and let the next caller read the result — not to pile a
		// second exchange onto a rotating token.
		return codexRefreshResult{
			Outcome: codexRefreshRacedFresh,
			Reason:  "Another process on this machine is already renewing the Codex credential.",
		}
	}
	defer release()

	// Guard 2: re-read under the lock. The process we queued behind may have just
	// renewed it, in which case we make no network call at all.
	doc, err := readCodexCredentialDoc(path)
	if err != nil {
		return codexRefreshResult{
			Outcome:    codexRefreshImpossible,
			Reason:     err.Error(),
			Code:       ReasonRunnerCodexCredentialCorrupt,
			Reauthable: true,
		}
	}
	now := time.Now()
	fresh := codexCredentialFreshnessOf(doc, now)
	if !force && !fresh.NeedsRefresh {
		return codexRefreshResult{Outcome: codexRefreshRacedFresh, ExpiresAt: fresh.ExpiresAt}
	}
	if !fresh.HasRefreshToken {
		return codexRefreshResult{
			Outcome:    codexRefreshImpossible,
			Reason:     "This machine's Codex credential carries no refresh token — only a fresh sign-in can renew it.",
			Code:       ReasonRunnerCodexNotAuthenticated,
			Reauthable: true,
		}
	}

	resp, err := exchangeCodexRefreshToken(ctx, doc.refreshToken())
	if err != nil {
		var lineage *codexLineageLostError
		if errors.As(err, &lineage) {
			// invalid_grant. The token we hold has been consumed or revoked. This is
			// the copied-credential / logged-out-elsewhere case, and it is the ONE
			// outcome a human must resolve. Name the real cause — a vague error here
			// costs whole sessions.
			return codexRefreshResult{
				Outcome:    codexRefreshLineageLost,
				Reason:     lineage.Error(),
				Code:       ReasonRunnerCodexRefreshLineageLost,
				Reauthable: true,
			}
		}
		return codexRefreshResult{
			Outcome: codexRefreshFailed,
			Reason:  fmt.Sprintf("Could not renew the Codex credential: %v", err),
			Code:    ReasonRunnerCodexRefreshFailed,
		}
	}

	// Guard 3 + 4: preserve every unmodelled field, keep the lineage if the server
	// did not rotate, and write all-or-nothing.
	if err := doc.applyRefreshedTokens(resp.AccessToken, resp.RefreshToken, resp.IDToken, time.Now()); err != nil {
		return codexRefreshResult{
			Outcome: codexRefreshFailed,
			Reason:  fmt.Sprintf("Refresh response was unusable: %v", err),
			Code:    ReasonRunnerCodexRefreshFailed,
		}
	}
	if err := doc.writeAtomic(); err != nil {
		return codexRefreshResult{
			Outcome: codexRefreshFailed,
			Reason:  fmt.Sprintf("Renewed the Codex credential but could not persist it: %v", err),
			Code:    ReasonRunnerCodexRefreshFailed,
		}
	}

	// The verdict cache is now stale in both directions: a previously-rejected runner
	// may be good again, and the 60 s login-status cache holds a pre-refresh answer.
	invalidateCodexLoginStatusCache()
	ClearRunnerAuthInvalid("codex")

	newFresh := codexCredentialFreshnessOf(doc, time.Now())
	log.Printf("[codex-keepalive] renewed credential — %s", newFresh.describe(time.Now()))

	// A renewal is PROOF the blocker cleared, which is the only honest trigger for
	// replaying a parked follow-up. Anything the user typed while the credential was
	// stale now runs, in its original session, without them retyping it.
	replayParkedTurnsAfterAuthRecovery("codex credential renewed")

	return codexRefreshResult{Outcome: codexRefreshRenewed, ExpiresAt: newFresh.ExpiresAt}
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

type codexRefreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

// codexLineageLostError is invalid_grant — the refresh token is gone for good.
type codexLineageLostError struct{ detail string }

func (e *codexLineageLostError) Error() string {
	msg := "This machine's Codex refresh token is no longer accepted. That happens when the same credential was copied to another machine (each refresh rotates the token, so only one copy stays valid), or when Codex was signed out elsewhere. Sign in again on this machine with `codex login --device-auth`."
	if strings.TrimSpace(e.detail) != "" {
		msg += " Provider said: " + e.detail
	}
	return msg
}

// codexTokenEndpoint resolves the endpoint, honoring an override ONLY for https or
// loopback http. The override exists so the exchange is testable against a local
// server; refusing plaintext to a non-loopback host keeps that from becoming a way to
// walk a refresh token off the box.
func codexTokenEndpoint() string {
	raw := strings.TrimSpace(os.Getenv("YAVER_CODEX_TOKEN_URL"))
	if raw == "" {
		return codexOAuthTokenURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return codexOAuthTokenURL
	}
	if u.Scheme == "https" {
		return raw
	}
	// isLoopbackHost lives in agent_mesh_remote.go; url.Hostname() has already
	// stripped any [::1] brackets by this point.
	if u.Scheme == "http" && isLoopbackHost(u.Hostname()) {
		return raw
	}
	log.Printf("[codex-keepalive] ignoring YAVER_CODEX_TOKEN_URL — plaintext to a non-loopback host is refused")
	return codexOAuthTokenURL
}

func exchangeCodexRefreshToken(ctx context.Context, refreshToken string) (*codexRefreshResponse, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return nil, errors.New("no refresh token")
	}
	ctx, cancel := context.WithTimeout(ctx, codexRefreshHTTPTimeout)
	defer cancel()

	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	form.Set("client_id", codexOAuthClientID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexTokenEndpoint(), strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Bounded read: a token response is small, and an unbounded ReadAll on a hostile
	// or broken endpoint is a memory bomb on a 4 GB box.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		var oauthErr struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		_ = json.Unmarshal(body, &oauthErr)
		if strings.EqualFold(strings.TrimSpace(oauthErr.Error), "invalid_grant") {
			return nil, &codexLineageLostError{detail: strings.TrimSpace(oauthErr.Description)}
		}
		detail := strings.TrimSpace(oauthErr.Error)
		if d := strings.TrimSpace(oauthErr.Description); d != "" {
			detail = strings.TrimSpace(detail + " " + d)
		}
		if detail == "" {
			detail = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		// NOTE: body is deliberately not logged or returned wholesale — a token
		// endpoint's response can carry credential material.
		return nil, fmt.Errorf("token endpoint refused the refresh (%s)", detail)
	}

	var out codexRefreshResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("token endpoint returned a body we could not parse")
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return nil, errors.New("token endpoint returned no access token")
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

// acquireCodexRefreshLock takes an O_EXCL lock file next to the credential. Returns a
// release func and whether it was acquired.
//
// Non-blocking on purpose. A refresh is not urgent to THIS caller — if someone else
// holds the lock, their atomic write will serve us. Blocking here would put a network
// exchange in the critical path of a user's follow-up turn for no benefit.
func acquireCodexRefreshLock(credentialPath string) (func(), bool) {
	lockPath := credentialPath + ".refresh.lock"

	tryCreate := func() (*os.File, bool) {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, false
		}
		return f, true
	}

	f, ok := tryCreate()
	if !ok {
		// Stale takeover: a holder older than one bounded exchange is a dead process.
		if info, err := os.Stat(lockPath); err == nil && time.Since(info.ModTime()) > codexRefreshLockStale {
			log.Printf("[codex-keepalive] taking over a stale refresh lock (%s old)", time.Since(info.ModTime()).Round(time.Second))
			_ = os.Remove(lockPath)
			f, ok = tryCreate()
		}
	}
	if !ok {
		return func() {}, false
	}
	_ = f.Close()
	return func() { _ = os.Remove(lockPath) }, true
}
