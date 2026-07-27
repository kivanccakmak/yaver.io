package main

import (
	"strings"
	"testing"
	"time"
)

// These fixtures are VERBATIM from the 2026-07-27 incident on the user's own
// box (agent 1.99.383). `/runner-auth/status` reported claude as
// authConfigured:true authVerified:true ready:true authSource:"claude.ai · max"
// while the PTY the user was looking at showed the first string below.
//
// Every one of these was invisible to the pre-fix classifier.
const (
	claudeRevokedPTY  = "Please run /login · API Error: 401 OAuth access token has been revoked."
	claudeRevokedLong = "\x1b[31m✗\x1b[0m API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"," +
		"\"message\":\"OAuth access token has been revoked\"}}\nPlease run /login to authenticate.\n"
	codexSignedOut  = "ERROR: Please run `codex login` to authenticate with your ChatGPT account."
	codexRefreshBad = "stream error: refresh_token_reused (401)"
	codexExpired    = "auth error: token_expired; re-run codex login --device-auth"
)

func TestClassifierMatchesTheStringTheUserActuallySaw(t *testing.T) {
	// The whole defect in one assertion: this exact sentence used to return "".
	for _, in := range []string{claudeRevokedPTY, claudeRevokedLong} {
		id, reason := ClassifyRunnerAuthFailure(in)
		if id != "claude" {
			t.Fatalf("ClassifyRunnerAuthFailure(%q) = %q, want claude — this is the string the PTY showed while the chip stayed green", in, id)
		}
		if strings.TrimSpace(reason) == "" {
			t.Fatalf("no reason for %q — a chip that flips with no sentence is only half the fix", in)
		}
		if !strings.Contains(strings.ToLower(reason), "sign in") {
			t.Fatalf("reason %q does not name the remedy", reason)
		}
	}
}

func TestClassifierNamesRevocationDistinctlyFromExpiry(t *testing.T) {
	// A revoked grant cannot be refreshed; an expired one can. Collapsing them
	// into one "token rejected" sentence sends the user looking for a refresh
	// that will never come.
	_, revoked := ClassifyRunnerAuthFailure(claudeRevokedPTY)
	if !strings.Contains(strings.ToUpper(revoked), "REVOKED") {
		t.Fatalf("revocation reason %q must say revoked", revoked)
	}
	_, expired := ClassifyRunnerAuthFailure(codexExpired)
	if strings.Contains(strings.ToUpper(expired), "REVOKED") {
		t.Fatalf("expiry reason %q must not claim revocation", expired)
	}
}

func TestClassifierCoversCodexEquivalents(t *testing.T) {
	for _, in := range []string{codexSignedOut, codexRefreshBad, codexExpired} {
		id, reason := ClassifyRunnerAuthFailure(in)
		if id != "codex" {
			t.Fatalf("ClassifyRunnerAuthFailure(%q) = %q, want codex", in, id)
		}
		if strings.TrimSpace(reason) == "" {
			t.Fatalf("no reason for codex fixture %q", in)
		}
	}
}

func TestBareHTTP401IsOnlyAttributedWhenTheRunnerIsKnown(t *testing.T) {
	// A task that curls a third-party API and gets a 401 must NOT sign the user
	// out of claude. The unscoped classifier therefore refuses to guess.
	bare := "curl: the server replied 401 Unauthorized"
	if id, _ := ClassifyRunnerAuthFailure(bare); id != "" {
		t.Fatalf("unscoped classifier attributed a bare 401 to %q — that would sign users out of a healthy runner", id)
	}
	// Scoped to the runner that produced the stream, the same evidence counts.
	ok, reason := ClassifyRunnerAuthFailureFor("claude", "API Error: 401")
	if !ok {
		t.Fatal("scoped classifier missed a bare `API Error: 401` from claude's own stream")
	}
	if strings.TrimSpace(reason) == "" {
		t.Fatal("scoped classifier produced no reason")
	}
}

func TestKnownGoodOutputIsNeverClassifiedAsAnAuthFailure(t *testing.T) {
	for _, in := range []string{
		"Reply with OK",
		"OK, sounds good.",
		"Successfully completed",
		"the login page component renders at /login route", // contains "/login"!
		"HTTP 200 OK",
	} {
		if id, _ := ClassifyRunnerAuthFailure(in); id != "" {
			t.Errorf("ClassifyRunnerAuthFailure(%q) = %q, want empty", in, id)
		}
	}
}

// ---------------------------------------------------------------------------
// authVerified is verified-by-OPERATION, and only that
// ---------------------------------------------------------------------------

func TestPresenceAloneNeverSetsAuthVerified(t *testing.T) {
	// THE GUARD FOR THE WHOLE INCIDENT. detectClaudeStatus / detectCodexStatus /
	// detectGLMStatus may set AuthPresent from a local store. None of them may
	// set AuthVerified — a local store cannot see a server-side revocation.
	//
	// PROVE THIS BY BREAKING IT: change `status.AuthPresent = true` back to
	// `status.AuthVerified = true` in detectGLMStatus and this test fails.
	t.Setenv("ZAI_API_KEY", "zai-test-key")
	ClearRunnerAuthProven("glm")
	ClearRunnerAuthInvalid("glm")

	st := detectGLMStatus()
	if !st.AuthConfigured || !st.AuthPresent {
		t.Fatalf("fixture did not produce a present credential: %+v", st)
	}
	if st.AuthVerified {
		t.Fatal("a detector set AuthVerified from local evidence — that is the exact false green: " +
			"`claude auth status` said loggedIn:true off a token the provider had already revoked")
	}
}

func TestOnlyAnObservedOperationSetsAuthVerified(t *testing.T) {
	t.Setenv("ZAI_API_KEY", "zai-test-key")
	cfg := GetRunnerConfig("glm")
	ClearRunnerAuthProven("glm")
	ClearRunnerAuthInvalid("glm")
	defer func() { ClearRunnerAuthProven("glm"); ClearRunnerAuthInvalid("glm") }()

	if got := DetectRunnerRuntimeStatus(cfg, ""); got.AuthVerified {
		t.Fatalf("unproven credential reported AuthVerified: %+v", got)
	}
	MarkRunnerAuthProven("glm")
	got := DetectRunnerRuntimeStatus(cfg, "")
	if !got.AuthVerified || !got.AuthConfigured {
		t.Fatalf("a proven credential must report AuthVerified: %+v", got)
	}
	if runnerAuthVerifiedAtMillis("glm") == 0 {
		t.Fatal("a proven credential must carry the timestamp of the proof — otherwise Convex stores a verdict with no age")
	}
}

func TestObservedRevocationOutranksAStandingProof(t *testing.T) {
	t.Setenv("ZAI_API_KEY", "zai-test-key")
	cfg := GetRunnerConfig("glm")
	defer func() { ClearRunnerAuthProven("glm"); ClearRunnerAuthInvalid("glm") }()

	MarkRunnerAuthProven("glm")
	if got := DetectRunnerRuntimeStatus(cfg, ""); !got.AuthVerified {
		t.Fatalf("setup failed: %+v", got)
	}
	MarkRunnerAuthInvalidReason("glm", "the provider said no")
	got := DetectRunnerRuntimeStatus(cfg, "")
	if got.AuthConfigured {
		t.Fatal("a rejection must clear AuthConfigured even with a standing proof")
	}
	if !got.AuthVerified {
		t.Fatal("a rejection IS verified evidence — just of the negative; AuthVerified must stay true")
	}
	if got.Ready {
		t.Fatal("a rejected runner must not be Ready — pickers filter on Ready")
	}
	if got.Warning != "the provider said no" {
		t.Fatalf("the named reason was dropped; got %q. A chip that flips without saying why is the old generic error again", got.Warning)
	}
}

func TestObservingARevocationOnTheStreamKicksTheHeartbeat(t *testing.T) {
	// Convex is how a revoked runner stops being green on a surface with NO
	// live connection to this box. That only works if the transition PUSHES.
	kicked := make(chan struct{}, 4)
	SetRunnerAuthChangeHook(func() { kicked <- struct{}{} })
	defer SetRunnerAuthChangeHook(nil)
	ClearRunnerAuthInvalid("claude")

	ObserveRunnerAuthFromOutput("claude", claudeRevokedPTY, string(TaskStatusFinished))
	select {
	case <-kicked:
	case <-time.After(time.Second):
		t.Fatal("no heartbeat kick after an observed revocation — the corrected state would sit in agent memory for up to 30s")
	}
	if _, rejected := runnerAuthFailureRecent("claude"); !rejected {
		t.Fatal("the revocation was not recorded")
	}
	ClearRunnerAuthInvalid("claude")
}

func TestAZeroExitTurnThatAnnouncesRevocationIsNotProof(t *testing.T) {
	// The user's turn EXITED ZERO. Only the hard-failure branch used to run the
	// classifier, so a polite auth death was read as a successful run.
	ClearRunnerAuthProven("claude")
	ClearRunnerAuthInvalid("claude")
	defer func() { ClearRunnerAuthProven("claude"); ClearRunnerAuthInvalid("claude") }()

	ObserveRunnerAuthFromOutput("claude", claudeRevokedLong, string(TaskStatusFinished))
	if runnerAuthProofRecent("claude") {
		t.Fatal("a turn whose entire content is an auth error was recorded as PROOF the credential works")
	}
	if _, rejected := runnerAuthFailureRecent("claude"); !rejected {
		t.Fatal("a completed-status turn carrying a revocation must still mark the runner invalid")
	}
}

func TestARealTurnIsProof(t *testing.T) {
	ClearRunnerAuthProven("codex")
	ClearRunnerAuthInvalid("codex")
	defer ClearRunnerAuthProven("codex")
	ObserveRunnerAuthFromOutput("codex",
		"Here is the refactor you asked for. I moved the parser into its own package and updated the callers.",
		string(TaskStatusFinished))
	if !runnerAuthProofRecent("codex") {
		t.Fatal("a completed turn with real content is the free proof that the credential works")
	}
}

func TestAnEmptyOrTinyReplyIsNotProof(t *testing.T) {
	ClearRunnerAuthProven("codex")
	defer ClearRunnerAuthProven("codex")
	ObserveRunnerAuthFromOutput("codex", "ok", string(TaskStatusFinished))
	if runnerAuthProofRecent("codex") {
		t.Fatal("a two-byte reply was accepted as proof a paid generation happened")
	}
}

// ---------------------------------------------------------------------------
// Sign-in start policy — the mirror of the false green
// ---------------------------------------------------------------------------

func TestAutoTriggerNeverSpawnsSignInOnAVerifiedRunner(t *testing.T) {
	// PROVE THIS BY BREAKING IT: delete the `st.AuthConfigured && st.AuthVerified`
	// branch in DecideRunnerAuthStart and this test fails by name. Spawning here
	// reaps a live session, burns a PKCE flow, and for claude can REPLACE a
	// working credential.
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:  "claude",
		Trigger: RunnerAuthTriggerAuto,
		Status:  RunnerRuntimeStatus{Ready: true, AuthConfigured: true, AuthPresent: true, AuthVerified: true, AuthSource: "claude.ai · max"},
	})
	if d.Action != RunnerAuthStartNoop {
		t.Fatalf("an automatic trigger spawned %q on a verified runner — this is how the user got sign-in dialogs for runners that were fine", d.Action)
	}
	if !strings.Contains(d.Reason, "claude.ai · max") {
		t.Fatalf("the no-op must name the existing sign-in, got %q", d.Reason)
	}
	// Discriminating on purpose: "confirmed by a successful run" is the
	// VERIFIED branch's sentence. Without it, deleting that branch would fall
	// through to the presence branch — also a no-op — and this test would pass
	// over a removed guard.
	if !strings.Contains(d.Reason, "confirmed by a successful run") {
		t.Fatalf("a verified runner must be refused with the verified sentence, got %q", d.Reason)
	}
}

func TestExplicitTapOnAHealthyRunnerIsAnsweredNotObeyed(t *testing.T) {
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:  "codex",
		Trigger: RunnerAuthTriggerExplicit,
		Status:  RunnerRuntimeStatus{Ready: true, AuthConfigured: true, AuthPresent: true, AuthVerified: true, AuthSource: "codex login status"},
	})
	if d.Action != RunnerAuthStartNoop {
		t.Fatalf("explicit tap on a healthy runner = %q, want noop-with-explanation", d.Action)
	}
	if !d.Reauthable {
		t.Fatal("a user who taps Sign in must be offered a confirmed re-sign-in — silently refusing is its own dead end")
	}
}

func TestOnlyAConfirmedTapMayReapAHealthySession(t *testing.T) {
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:  "claude",
		Trigger: RunnerAuthTriggerConfirmed,
		Status:  RunnerRuntimeStatus{Ready: true, AuthConfigured: true, AuthPresent: true, AuthVerified: true},
	})
	if d.Action != RunnerAuthStartNew {
		t.Fatalf("a confirmed re-sign-in (switching accounts) must start = %q", d.Action)
	}
}

func TestTwoSurfacesAskingAtOnceReuseOneSession(t *testing.T) {
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:   "claude",
		Trigger:  RunnerAuthTriggerExplicit,
		Status:   RunnerRuntimeStatus{AuthConfigured: false},
		InFlight: true,
	})
	if d.Action != RunnerAuthStartReuse {
		t.Fatalf("phone + web asking together produced %q — reaping would leave the first surface polling a dead session id", d.Action)
	}
}

func TestARevokedRunnerStillStartsSignIn(t *testing.T) {
	// The guard must not become a wall: the whole point is that a genuinely
	// signed-out runner routes into sign-in immediately.
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:  "claude",
		Trigger: RunnerAuthTriggerExplicit,
		Status:  RunnerRuntimeStatus{AuthConfigured: false, AuthVerified: true, Warning: "revoked"},
	})
	if d.Action != RunnerAuthStartNew {
		t.Fatalf("a revoked runner must route into sign-in, got %q", d.Action)
	}
}

func TestAutoTriggerLeavesAPresentButUnprovenRunnerAlone(t *testing.T) {
	d := DecideRunnerAuthStart(RunnerAuthStartInput{
		Runner:  "claude",
		Trigger: RunnerAuthTriggerAuto,
		Status:  RunnerRuntimeStatus{Ready: true, AuthConfigured: true, AuthPresent: true, AuthVerified: false},
	})
	if d.Action != RunnerAuthStartNoop {
		t.Fatalf("a background trigger reauthed a probably-working credential (%q)", d.Action)
	}
}

// ---------------------------------------------------------------------------
// Convex privacy: labels, booleans and timestamps only
// ---------------------------------------------------------------------------

func TestHeartbeatRunnerRowsCarryNoAbsoluteFilesystemPaths(t *testing.T) {
	// AuthSource is set to the matched CREDENTIAL FILE PATH by the codex and
	// opencode detectors — and it has been riding the heartbeat into Convex the
	// whole time. Absolute paths leak the home-directory username, which the
	// privacy contract forbids outright. Carrying MORE per-runner auth state
	// into Convex is exactly the wrong moment to leave that in place.
	in := []RunnerInfo{
		{RunnerID: "codex", AuthSource: "/Users/kivanc/.codex/auth.json"},
		{RunnerID: "opencode", AuthSource: "/home/pokayoke/.config/opencode/opencode.json"},
		{RunnerID: "claude", AuthSource: "claude.ai · max"},
		{RunnerID: "glm", Warning: "no key at /root/.config/zai/key", Error: "read /home/bob/.codex/auth.json: denied"},
	}
	out := sanitizeRunnerInfosForConvex(in)
	for _, leak := range []string{"/Users/", "/home/", "/root/"} {
		for _, r := range out {
			for _, field := range []string{r.AuthSource, r.Warning, r.Error} {
				if strings.Contains(field, leak) {
					t.Fatalf("runner row field %q still carries %q — that is a username leak into Convex", field, leak)
				}
			}
		}
	}
	if out[2].AuthSource != "claude.ai · max" {
		t.Fatalf("a plain label must survive untouched, got %q", out[2].AuthSource)
	}
	if in[0].AuthSource != "/Users/kivanc/.codex/auth.json" {
		t.Fatal("sanitize mutated the caller's slice — the agent's own status view must keep the real path")
	}
}
