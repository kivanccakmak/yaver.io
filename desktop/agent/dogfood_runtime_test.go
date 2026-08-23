package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupDogfoodRepos(t *testing.T) (seed, local, origin string) {
	t.Helper()
	seed, local, origin = setupSyncRepos(t)
	syncWrite(t, filepath.Join(seed, "package.json"), `{"name":"yaver-mobile"}`)
	syncGitCmd(t, seed, "add", "package.json")
	syncGitCmd(t, seed, "commit", "-m", "identify yaver")
	syncGitCmd(t, seed, "push")
	syncGitCmd(t, local, "pull", "--ff-only")
	return seed, local, origin
}

func TestPrepareDogfoodCheckoutRebasesOntoOriginMainWithoutPush(t *testing.T) {
	seed, local, origin := setupDogfoodRepos(t)
	syncWrite(t, filepath.Join(local, "local.txt"), "local\n")
	syncGitCmd(t, local, "add", "local.txt")
	syncGitCmd(t, local, "commit", "-m", "local work")
	syncWrite(t, filepath.Join(seed, "remote.txt"), "remote\n")
	syncGitCmd(t, seed, "add", "remote.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote main")
	syncGitCmd(t, seed, "push")
	remoteBefore := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main")

	status, resp := prepareDogfoodCheckout(local)
	if status != http.StatusOK || !resp.OK || !resp.Rebased || resp.Base != "origin/main" {
		t.Fatalf("Dogfood prepare did not become ready: status=%d resp=%+v", status, resp)
	}
	if got := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main"); got != remoteBefore {
		t.Fatalf("Dogfood prepare pushed unexpectedly: got %s want %s", got, remoteBefore)
	}
	if behind := syncGitCmd(t, local, "rev-list", "--count", "HEAD..origin/main"); behind != "0" {
		t.Fatalf("prepared checkout is still behind origin/main: %s", behind)
	}
}

func TestPrepareDogfoodCheckoutAbortsAndRoutesConflictToAI(t *testing.T) {
	seed, local, _ := setupDogfoodRepos(t)
	syncWrite(t, filepath.Join(local, "shared.txt"), "local conflict\n")
	syncGitCmd(t, local, "add", "shared.txt")
	syncGitCmd(t, local, "commit", "-m", "local conflict")
	originalHead := syncGitCmd(t, local, "rev-parse", "HEAD")
	syncWrite(t, filepath.Join(seed, "shared.txt"), "remote conflict\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote conflict")
	syncGitCmd(t, seed, "push")

	status, resp := prepareDogfoodCheckout(local)
	if status != http.StatusConflict || resp.Code != "DOGFOOD_GIT_REBASE_CONFLICT" || !resp.RequiresAgent {
		t.Fatalf("conflict was not fail-closed and structured: status=%d resp=%+v", status, resp)
	}
	if len(resp.Conflicts) == 0 || !strings.Contains(resp.FixPrompt, "never force-push") {
		t.Fatalf("conflict did not carry files + safe AI route: %+v", resp)
	}
	if got := syncGitCmd(t, local, "rev-parse", "HEAD"); got != originalHead {
		t.Fatalf("aborted conflict moved HEAD: got %s want %s", got, originalHead)
	}
}

func TestDogfoodRuntimeStatusExpiresIdleSession(t *testing.T) {
	now := time.Now()
	sess, err := StartAttachSession(yaverCheckoutDir(t), "owner", now.Add(-attachSessionMaxIdle-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := currentDogfoodRuntime(now); got.Active || got.Mode != "production" {
		t.Fatalf("idle session reported active: %+v", got)
	}
	if _, ok := VerifyAttachCapability("", now); ok {
		t.Fatal("invalid capability unexpectedly verified")
	}
	RevokeAttachSession(sess.ID)
}

func TestDogfoodMCPInstructionsNameStatusBeforeRerender(t *testing.T) {
	instructions := mcpInstructions()
	statusAt := strings.Index(instructions, "dogfood_status first")
	rerenderAt := strings.Index(instructions, "call dogfood_rerender")
	if statusAt < 0 || rerenderAt < 0 || statusAt > rerenderAt {
		t.Fatalf("MCP instructions do not route Dogfood reload intent safely: %s", instructions)
	}
}

func TestDogfoodRuntimeHTTPRefusesNonOwner(t *testing.T) {
	previous := attachOwnerAllowed
	attachOwnerAllowed = func() bool { return false }
	t.Cleanup(func() { attachOwnerAllowed = previous })

	s := &HTTPServer{}
	for _, tc := range []struct {
		method string
		path   string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, "/attach/prepare", s.handleDogfoodPrepare},
		{http.MethodGet, "/dogfood/status", s.handleDogfoodStatus},
		{http.MethodPost, "/dogfood/rerender", s.handleDogfoodRerender},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		tc.call(w, r)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "DOGFOOD_OWNER_ONLY") {
			t.Fatalf("%s: got %d %s, want owner-only 403", tc.path, w.Code, w.Body.String())
		}
	}
}
