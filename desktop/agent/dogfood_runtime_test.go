package main

import (
	"net/http"
	"net/http/httptest"
	"os"
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
	// Keep the checkout's persisted origin production-real while redirecting
	// network operations to the local bare fixture. This proves the source gate
	// instead of weakening it for tests.
	syncGitCmd(t, local, "remote", "set-url", "origin", dogfoodSourceURL)
	syncGitCmd(t, local, "config", "url."+origin+".insteadOf", dogfoodSourceURL)
	return seed, local, origin
}

func TestDogfoodSourceStatusOffersCloneWhenSourceMissing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	status := dogfoodSourceStatus("")
	if status.Ready || status.Code != "DOGFOOD_SOURCE_MISSING" || status.Action == nil {
		t.Fatalf("missing source did not carry clone route: %+v", status)
	}
	if status.Action.Path != "/repos/clone" || status.Action.Body["url"] != dogfoodSourceURL {
		t.Fatalf("missing source clone route drifted: %+v", status.Action)
	}
}

func TestDogfoodSourceStatusRejectsYaverLookingCheckoutWithWrongOrigin(t *testing.T) {
	_, local, _ := setupSyncRepos(t)
	syncWrite(t, filepath.Join(local, "package.json"), `{"name":"yaver-mobile"}`)
	status := dogfoodSourceStatus(local)
	if status.Ready || status.Code != "DOGFOOD_GIT_UPSTREAM_MISSING" {
		t.Fatalf("wrong origin was reported ready: %+v", status)
	}
}

func TestDogfoodSourceStatusProvesSourceAndCanonicalOrigin(t *testing.T) {
	_, local, _ := setupDogfoodRepos(t)
	status := dogfoodSourceStatus(local)
	if !status.OK || !status.Ready || status.Code != "DOGFOOD_SOURCE_READY" || status.Path != local {
		t.Fatalf("canonical source did not become ready: %+v", status)
	}
}

func TestDogfoodSourceStatusAcceptsContributorForkWithCanonicalUpstream(t *testing.T) {
	_, local, origin := setupDogfoodRepos(t)
	syncGitCmd(t, local, "remote", "set-url", "origin", "https://github.com/contributor/yaver.io.git")
	syncGitCmd(t, local, "remote", "add", "upstream", dogfoodSourceURL)
	syncGitCmd(t, local, "config", "url."+origin+".insteadOf", dogfoodSourceURL)

	status := dogfoodSourceStatus(local)
	if !status.Ready || status.BaseRemote != "upstream" || status.BaseRef != "upstream/main" {
		t.Fatalf("fork + canonical upstream was not accepted: %+v", status)
	}
}

func TestDogfoodSourceStatusRejectsAndRedactsEmbeddedOriginCredential(t *testing.T) {
	_, local, _ := setupDogfoodRepos(t)
	syncGitCmd(t, local, "remote", "set-url", "origin", "https://secret-token@github.com/yaver-io/yaver.io.git")
	status := dogfoodSourceStatus(local)
	if status.Ready || status.Code != "DOGFOOD_GIT_CREDENTIALS_EMBEDDED" {
		t.Fatalf("embedded credential was reported ready: %+v", status)
	}
	if strings.Contains(status.Remote, "secret-token") || status.Remote != dogfoodSourceURL {
		t.Fatalf("embedded credential was not redacted: %+v", status)
	}
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

func TestPrepareCommunityDogfoodMovesMainToContributionBranch(t *testing.T) {
	_, local, origin := setupDogfoodRepos(t)
	remoteBefore := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main")

	status, resp := prepareDogfoodCheckoutWithPolicy(local, false)
	if status != http.StatusOK || !resp.OK || !resp.ContributionBranch || resp.PushPolicy != "canonical-main-protected" {
		t.Fatalf("community preparation did not enforce contribution policy: status=%d resp=%+v", status, resp)
	}
	if resp.Branch == "main" || !strings.HasPrefix(resp.Branch, "dogfood/community-") {
		t.Fatalf("community session remained on main: %+v", resp)
	}
	if got := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main"); got != remoteBefore {
		t.Fatalf("community preparation changed canonical main: got %s want %s", got, remoteBefore)
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

func TestPrepareDogfoodCheckoutStagesMarkerFreeAIResolutionOnRetry(t *testing.T) {
	seed, local, _ := setupDogfoodRepos(t)
	syncWrite(t, filepath.Join(seed, "shared.txt"), "base\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "shared base")
	syncGitCmd(t, seed, "push")
	syncGitCmd(t, local, "pull", "--ff-only")

	// Local work remains uncommitted, exactly like the Dogfood checkout that
	// triggered the real incident. origin/main changes the same file, so Git's
	// autostash restore leaves an unmerged index after the rebase succeeds.
	syncWrite(t, filepath.Join(local, "shared.txt"), "local work\n")
	syncWrite(t, filepath.Join(seed, "shared.txt"), "remote work\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote shared change")
	syncGitCmd(t, seed, "push")

	status, first := prepareDogfoodCheckout(local)
	if status != http.StatusConflict || first.Code != "DOGFOOD_GIT_AUTOSTASH_CONFLICT" {
		t.Fatalf("expected retained autostash conflict, got status=%d resp=%+v", status, first)
	}
	if got := parseConflictedFiles(local); len(got) != 1 || got[0] != "shared.txt" {
		t.Fatalf("expected shared.txt to remain unmerged, got %v", got)
	}

	// The runner selects the content but cannot write .git/index. Retrying the
	// product flow safely performs that mechanical final step.
	syncWrite(t, filepath.Join(local, "shared.txt"), "resolved local plus remote\n")
	status, second := prepareDogfoodCheckout(local)
	if status != http.StatusOK || !second.OK || !second.IndexRecovered {
		t.Fatalf("marker-free AI resolution was not recovered: status=%d resp=%+v", status, second)
	}
	if got := parseConflictedFiles(local); len(got) != 0 {
		t.Fatalf("unmerged index survived successful retry: %v", got)
	}
	resolved, err := os.ReadFile(filepath.Join(local, "shared.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(resolved)); got != "resolved local plus remote" {
		t.Fatalf("product changed the AI-selected resolution: %q", got)
	}
}

func TestRecoverResolvedDogfoodIndexFailsClosedWithMarkers(t *testing.T) {
	seed, local, _ := setupDogfoodRepos(t)
	syncWrite(t, filepath.Join(seed, "shared.txt"), "base\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "shared base")
	syncGitCmd(t, seed, "push")
	syncGitCmd(t, local, "pull", "--ff-only")
	syncWrite(t, filepath.Join(local, "shared.txt"), "local work\n")
	syncWrite(t, filepath.Join(seed, "shared.txt"), "remote work\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote shared change")
	syncGitCmd(t, seed, "push")

	_, _ = prepareDogfoodCheckout(local)
	status, resp := prepareDogfoodCheckout(local)
	if status != http.StatusConflict || resp.Code != "DOGFOOD_GIT_CONFLICT_UNRESOLVED" || !resp.RequiresAgent {
		t.Fatalf("marker-bearing conflict did not fail closed: status=%d resp=%+v", status, resp)
	}
	if got := parseConflictedFiles(local); len(got) == 0 {
		t.Fatal("retry staged a file that still contained conflict markers")
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

func TestDogfoodRuntimeHTTPHasNoProductOwnerGate(t *testing.T) {
	s := &HTTPServer{}
	for _, tc := range []struct {
		method string
		path   string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, "/attach/prepare", s.handleDogfoodPrepare},
		{http.MethodGet, "/dogfood/source/status", s.handleDogfoodSourceStatus},
		{http.MethodGet, "/dogfood/status", s.handleDogfoodStatus},
		{http.MethodPost, "/dogfood/rerender", s.handleDogfoodRerender},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		tc.call(w, r)
		if w.Code == http.StatusForbidden || strings.Contains(w.Body.String(), "DOGFOOD_OWNER_ONLY") {
			t.Fatalf("%s: contributor Dogfood was owner-gated: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}
