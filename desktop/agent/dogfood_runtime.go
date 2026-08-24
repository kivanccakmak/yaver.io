package main

// dogfood_runtime.go — fail-closed source readiness + runtime awareness for
// Yaver rendering Yaver.
//
// Dogfood is not "a dev server happened to be running". Entry means all of
// these operations succeeded on the selected render box:
//
//   1. the checkout is Yaver itself;
//   2. origin/main was fetched;
//   3. the current branch rebased onto origin/main with --autostash;
//   4. no rebase or autostash conflict remains;
//   5. an attach session is live and its Expo browser lane is serving.
//
// This file owns 1–4 and exposes live state/re-render to MCP. It never pushes,
// force-pushes, resets, drops a stash, or guesses a conflict resolution. A
// conflict gets a stable code plus an exact coding-task prompt; the user may
// then choose Fix with AI from the same surface.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const dogfoodSourceURL = "https://github.com/yaver-io/yaver.io.git"

type dogfoodAction struct {
	Label  string         `json:"label"`
	Method string         `json:"method"`
	Path   string         `json:"path"`
	Body   map[string]any `json:"body,omitempty"`
}

type dogfoodSourceResponse struct {
	OK            bool           `json:"ok"`
	Ready         bool           `json:"ready"`
	Code          string         `json:"code"`
	Path          string         `json:"path,omitempty"`
	SuggestedPath string         `json:"suggestedPath,omitempty"`
	Branch        string         `json:"branch,omitempty"`
	Remote        string         `json:"remote,omitempty"`
	GitVersion    string         `json:"gitVersion,omitempty"`
	Message       string         `json:"message"`
	Remedy        string         `json:"remedy,omitempty"`
	Action        *dogfoodAction `json:"action,omitempty"`
}

func canonicalYaverRemote(remote string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(remote), ".git"))
	normalized = strings.TrimSuffix(normalized, "/")
	return strings.HasSuffix(normalized, "github.com/yaver-io/yaver.io") ||
		strings.HasSuffix(normalized, "github.com:kivanccakmak/yaver.io") ||
		strings.HasSuffix(normalized, "github.com/kivanccakmak/yaver.io")
}

// findDogfoodCheckout checks only the normal one-level workspace roots. This
// is deliberately bounded: Dogfood readiness must never recursively walk a
// home directory and make an otherwise-live box look offline.
func findDogfoodCheckout() string {
	home, _ := os.UserHomeDir()
	for _, parent := range []string{"Workspace", "Projects", "repos", "code", "src", "dev"} {
		for _, repo := range scanDirForRepos(filepath.Join(home, parent)) {
			remote, _ := runGit(repo.Path, "config", "--get", "remote.origin.url")
			if IsYaverSelfDevelopmentDir(repo.Path) && canonicalYaverRemote(remote) {
				return repo.Path
			}
		}
	}
	return ""
}

func dogfoodSourceStatus(workDir string) dogfoodSourceResponse {
	suggested := filepath.Join(ResolveWorkspaceParent(""), "yaver.io")
	if gitPath, err := exec.LookPath("git"); err != nil || strings.TrimSpace(gitPath) == "" {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_NOT_INSTALLED", SuggestedPath: suggested,
			Message: "Git is not installed on this box.",
			Remedy:  "Install Git here, then Yaver can clone and verify its source.",
			Action:  &dogfoodAction{Label: "Install Git", Method: http.MethodPost, Path: "/install/git"},
		}
	}
	version, _ := runGit("", "--version")
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		workDir = findDogfoodCheckout()
	}
	if workDir == "" {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_SOURCE_MISSING", SuggestedPath: suggested, GitVersion: strings.TrimSpace(version),
			Message: "This box does not have Yaver's source code.",
			Remedy:  "Clone the public Yaver repository on this box, then retry Dogfood mode.",
			Action: &dogfoodAction{Label: "Clone Yaver source", Method: http.MethodPost, Path: "/repos/clone", Body: map[string]any{
				"url": dogfoodSourceURL,
			}},
		}
	}
	if !IsYaverSelfDevelopmentDir(workDir) {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_NOT_YAVER_CHECKOUT", Path: workDir, SuggestedPath: suggested, GitVersion: strings.TrimSpace(version),
			Message: "The selected directory is not Yaver's source checkout.",
			Remedy:  "Choose the yaver.io repository, or clone a fresh copy on this box.",
			Action: &dogfoodAction{Label: "Clone Yaver source", Method: http.MethodPost, Path: "/repos/clone", Body: map[string]any{
				"url": dogfoodSourceURL,
			}},
		}
	}
	if _, err := os.Stat(filepath.Join(workDir, ".git")); err != nil {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_SOURCE_NOT_GIT", Path: workDir, SuggestedPath: suggested, GitVersion: strings.TrimSpace(version),
			Message: "Yaver source exists here, but it is not a Git checkout.",
			Remedy:  "Select or clone a real yaver.io Git checkout so Dogfood can safely sync origin/main.",
		}
	}
	// Read the persisted value rather than `remote get-url`: Git applies
	// url.*.insteadOf rewrites to the latter, which can make a valid canonical
	// origin look like a credential helper or local mirror target.
	remote, remoteErr := runGit(workDir, "config", "--get", "remote.origin.url")
	remote = strings.TrimSpace(remote)
	if remoteErr != nil || remote == "" {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_ORIGIN_MISSING", Path: workDir, SuggestedPath: suggested, GitVersion: strings.TrimSpace(version),
			Message: "The Yaver checkout has no origin remote.",
			Remedy:  "Repair this checkout's origin to the public yaver-io/yaver.io repository, then retry.",
		}
	}
	if clean := stripURLCredentials(remote); clean != remote {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_CREDENTIALS_EMBEDDED", Path: workDir, SuggestedPath: suggested, Remote: clean, GitVersion: strings.TrimSpace(version),
			Message: "The Yaver origin stores a credential inside its URL.",
			Remedy:  "Remove the embedded credential, then use Yaver's Git configuration wizard so secrets stay in the box credential store.",
		}
	}
	if !canonicalYaverRemote(remote) {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_ORIGIN_WRONG", Path: workDir, SuggestedPath: suggested, Remote: stripURLCredentials(remote), GitVersion: strings.TrimSpace(version),
			Message: "The selected Yaver-looking checkout points at a different origin.",
			Remedy:  "Verify the repository before changing its origin; Yaver will not rewrite it automatically.",
		}
	}
	branch, _ := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
	return dogfoodSourceResponse{
		OK: true, Ready: true, Code: "DOGFOOD_SOURCE_READY", Path: workDir,
		SuggestedPath: suggested, Branch: strings.TrimSpace(branch), Remote: stripURLCredentials(remote),
		GitVersion: strings.TrimSpace(version), Message: "Yaver source and its Git origin are ready on this box.",
	}
}

func (s *HTTPServer) handleDogfoodSourceStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	if !attachOwnerAllowed() {
		jsonReply(w, http.StatusForbidden, dogfoodSourceResponse{Code: "DOGFOOD_OWNER_ONLY", Message: "Dogfood mode is owner-only."})
		return
	}
	jsonReply(w, http.StatusOK, dogfoodSourceStatus(r.URL.Query().Get("workDir")))
}

type dogfoodPrepareRequest struct {
	WorkDir string `json:"workDir"`
}

type dogfoodPrepareResponse struct {
	OK            bool     `json:"ok"`
	Code          string   `json:"code,omitempty"`
	WorkDir       string   `json:"workDir,omitempty"`
	Branch        string   `json:"branch,omitempty"`
	Base          string   `json:"base,omitempty"`
	Head          string   `json:"head,omitempty"`
	Rebased       bool     `json:"rebased,omitempty"`
	RequiresAgent bool     `json:"requiresAgent,omitempty"`
	Conflicts     []string `json:"conflicts,omitempty"`
	Error         string   `json:"error,omitempty"`
	Remedy        string   `json:"remedy,omitempty"`
	FixPrompt     string   `json:"fixPrompt,omitempty"`
	Output        string   `json:"output,omitempty"`
}

func dogfoodConflictPrompt(workDir, branch string, conflicts []string, detail string) string {
	files := strings.Join(conflicts, ", ")
	if files == "" {
		files = "ask Git for the unresolved files"
	}
	return fmt.Sprintf(`Prepare Yaver Dogfood mode in %s. The current branch %s could not be safely rebased onto origin/main. Resolve the Git conflict while preserving BOTH the local work and origin/main; never force-push, never drop a stash, and never discard uncommitted changes. Conflicted files: %s. Failure detail: %s. After resolving, run the relevant focused tests and leave the checkout ready for a normal git rebase origin/main.`, workDir, branch, files, strings.TrimSpace(detail))
}

// prepareDogfoodCheckout fetches origin/main and rebases the current named
// branch onto it. --autostash preserves tracked local edits. An active rebase
// is refused rather than inherited. A rebase conflict is aborted immediately;
// an autostash re-apply conflict is reported honestly because Git has already
// completed the rebase and there is no rebase left to abort.
func prepareDogfoodCheckout(workDir string) (int, dogfoodPrepareResponse) {
	workDir = strings.TrimSpace(workDir)
	resp := dogfoodPrepareResponse{WorkDir: workDir, Base: "origin/main"}
	source := dogfoodSourceStatus(workDir)
	if !source.Ready {
		resp.Code = source.Code
		resp.Error = source.Message
		resp.Remedy = source.Remedy
		return http.StatusBadRequest, resp
	}
	workDir = source.Path
	resp.WorkDir = workDir

	branch, err := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
	branch = strings.TrimSpace(branch)
	resp.Branch = branch
	if err != nil {
		resp.Code = "DOGFOOD_GIT_UNAVAILABLE"
		resp.Error = "The Yaver checkout could not be read as a Git repository."
		resp.Remedy = "Repair Git on the primary device, then retry Dogfood mode."
		resp.Output = branch
		return http.StatusConflict, resp
	}
	if branch == "HEAD" || branch == "" {
		resp.Code = "DOGFOOD_GIT_DETACHED_HEAD"
		resp.Error = "The Yaver checkout is on a detached HEAD, so it cannot be safely rebased."
		resp.Remedy = "Check out a named branch, then retry."
		return http.StatusConflict, resp
	}
	if isMergeInProgress(workDir) || isRebaseInProgress(workDir) {
		resp.Code = "DOGFOOD_GIT_OPERATION_IN_PROGRESS"
		resp.Error = "The Yaver checkout already has a merge or rebase in progress."
		resp.Remedy = "Finish or abort that existing Git operation before entering Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = parseConflictedFiles(workDir)
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, resp.Conflicts, resp.Error)
		return http.StatusConflict, resp
	}

	fetchOut, fetchErr := runGit(workDir, "fetch", "origin", "main")
	if fetchErr != nil {
		lower := strings.ToLower(fetchOut)
		if strings.Contains(lower, "authentication failed") || strings.Contains(lower, "permission denied") || strings.Contains(lower, "could not read username") {
			resp.Code = "DOGFOOD_GIT_AUTH_UNCONFIGURED"
			resp.Error = "GitHub authentication is not configured or was rejected on this box."
			resp.Remedy = "Open the Git configuration wizard on mobile, authorize GitHub for this box, then retry."
		} else {
			resp.Code = "DOGFOOD_GIT_FETCH_FAILED"
			resp.Error = "The primary device could not fetch origin/main."
			resp.Remedy = "Check its network and Git configuration, then retry."
		}
		resp.Output = strings.TrimSpace(fetchOut)
		return http.StatusBadGateway, resp
	}
	if _, verifyErr := runGit(workDir, "rev-parse", "--verify", "origin/main"); verifyErr != nil {
		resp.Code = "DOGFOOD_GIT_MAIN_MISSING"
		resp.Error = "The fetched repository does not expose origin/main."
		resp.Remedy = "Restore the Yaver origin remote and its main branch, then retry."
		return http.StatusConflict, resp
	}

	rebaseOut, rebaseErr := runGit(workDir, "rebase", "--autostash", "origin/main")
	if rebaseErr != nil {
		conflicts := parseConflictedFiles(workDir)
		abortOut, abortErr := runGit(workDir, "rebase", "--abort")
		resp.Code = "DOGFOOD_GIT_REBASE_CONFLICT"
		resp.Error = "The Yaver checkout could not be rebased onto origin/main without conflicts."
		resp.Remedy = "Use Fix with AI to resolve the named files, then retry Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = conflicts
		resp.Output = strings.TrimSpace(rebaseOut)
		if abortErr != nil && strings.TrimSpace(abortOut) != "" {
			resp.Output += "\nrebase abort: " + strings.TrimSpace(abortOut)
		}
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, conflicts, resp.Output)
		return http.StatusConflict, resp
	}

	// Git can exit zero after the rebase while restoring its autostash leaves
	// UU entries. Never call that ready and let Metro discover the markers.
	if conflicts := parseConflictedFiles(workDir); len(conflicts) > 0 {
		resp.Code = "DOGFOOD_GIT_AUTOSTASH_CONFLICT"
		resp.Error = "origin/main was rebased, but restoring local edits produced conflicts."
		resp.Remedy = "Use Fix with AI to reconcile the retained autostash, then retry Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = conflicts
		resp.Output = strings.TrimSpace(rebaseOut)
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, conflicts, resp.Output)
		return http.StatusConflict, resp
	}

	head, _ := runGit(workDir, "rev-parse", "--short", "HEAD")
	resp.OK = true
	resp.Code = "DOGFOOD_GIT_READY"
	resp.Head = strings.TrimSpace(head)
	resp.Rebased = true
	return http.StatusOK, resp
}

func (s *HTTPServer) handleDogfoodPrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	if !attachOwnerAllowed() {
		jsonReply(w, http.StatusForbidden, dogfoodPrepareResponse{Code: "DOGFOOD_OWNER_ONLY", Error: "Dogfood mode is owner-only."})
		return
	}
	var req dogfoodPrepareRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		jsonReply(w, http.StatusBadRequest, dogfoodPrepareResponse{Code: "DOGFOOD_BAD_REQUEST", Error: "Invalid Dogfood prepare request."})
		return
	}
	status, resp := prepareDogfoodCheckout(req.WorkDir)
	jsonReply(w, status, resp)
}

type dogfoodRuntimeResponse struct {
	OK        bool   `json:"ok"`
	Active    bool   `json:"active"`
	Mode      string `json:"mode"`
	Code      string `json:"code"`
	WorkDir   string `json:"workDir,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	LastSeen  string `json:"lastSeen,omitempty"`
	Message   string `json:"message,omitempty"`
	Remedy    string `json:"remedy,omitempty"`
}

func currentDogfoodRuntime(now time.Time) dogfoodRuntimeResponse {
	sess, ok := ActiveAttachSession(now)
	if !ok {
		return dogfoodRuntimeResponse{OK: true, Active: false, Mode: "production", Code: "DOGFOOD_INACTIVE", Message: "Yaver is in Production mode."}
	}
	return dogfoodRuntimeResponse{
		OK: true, Active: true, Mode: "dogfood", Code: "DOGFOOD_ACTIVE",
		WorkDir: sess.WorkDir, SessionID: sess.ID,
		StartedAt: sess.CreatedAt.UTC().Format(time.RFC3339), LastSeen: sess.LastSeen.UTC().Format(time.RFC3339),
		Message: "Yaver is rendering its Expo browser lane in Dogfood mode.",
	}
}

func (s *HTTPServer) handleDogfoodStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	if !attachOwnerAllowed() {
		jsonReply(w, http.StatusForbidden, dogfoodRuntimeResponse{OK: false, Active: false, Mode: "production", Code: "DOGFOOD_OWNER_ONLY", Message: "Dogfood mode is owner-only."})
		return
	}
	jsonReply(w, http.StatusOK, currentDogfoodRuntime(time.Now()))
}

func (s *HTTPServer) dogfoodRerender() (int, dogfoodRuntimeResponse) {
	runtime := currentDogfoodRuntime(time.Now())
	if !runtime.Active {
		runtime.OK = false
		runtime.Code = "DOGFOOD_NOT_ACTIVE"
		runtime.Message = "Yaver is not currently in Dogfood mode, so no Dogfood surface was re-rendered."
		runtime.Remedy = "Enter Dogfood mode first, or use the normal project reload tool for Production previews."
		return http.StatusConflict, runtime
	}
	if s.devServerMgr == nil {
		runtime.OK = false
		runtime.Code = "DOGFOOD_RENDERER_UNAVAILABLE"
		runtime.Message = "The Dogfood attach session is live, but the Expo dev-server manager is unavailable."
		runtime.Remedy = "Return to Production, then retry Dogfood mode to restart and prove the browser lane."
		return http.StatusServiceUnavailable, runtime
	}
	status := s.devServerMgr.Status()
	want := filepath.Clean(filepath.Join(runtime.WorkDir, "mobile"))
	if status == nil || filepath.Clean(status.WorkDir) != want || !status.Running {
		runtime.OK = false
		runtime.Code = "DOGFOOD_BROWSER_LANE_NOT_SERVING"
		runtime.Message = "The attach session is live, but its Yaver Expo browser lane is not serving."
		runtime.Remedy = "Return to Production and retry Dogfood mode; entry will re-run Git, Expo and browser render probes."
		return http.StatusConflict, runtime
	}

	body, _ := json.Marshal(map[string]string{"mode": "fast"})
	req, _ := http.NewRequest(http.MethodPost, "/dev/reload", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := newCapturingResponseWriter()
	s.handleDevServerReload(rec, req)
	if rec.Status() >= 300 {
		runtime.OK = false
		runtime.Code = "DOGFOOD_RERENDER_FAILED"
		runtime.Message = "The active Dogfood browser lane rejected the re-render request."
		runtime.Remedy = "Use dogfood_status for the current mode, then retry or return to Production."
		return rec.Status(), runtime
	}
	runtime.Code = "DOGFOOD_RERENDERED"
	runtime.Message = "Re-render requested on the active Yaver Expo browser lane."
	return http.StatusOK, runtime
}

func (s *HTTPServer) handleDogfoodRerender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	if !attachOwnerAllowed() {
		jsonReply(w, http.StatusForbidden, dogfoodRuntimeResponse{OK: false, Active: false, Mode: "production", Code: "DOGFOOD_OWNER_ONLY", Message: "Dogfood mode is owner-only."})
		return
	}
	status, resp := s.dogfoodRerender()
	jsonReply(w, status, resp)
}
