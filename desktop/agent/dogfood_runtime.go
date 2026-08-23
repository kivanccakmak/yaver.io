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
	"path/filepath"
	"strings"
	"time"
)

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
	if workDir == "" || !IsYaverSelfDevelopmentDir(workDir) {
		resp.Code = "DOGFOOD_NOT_YAVER_CHECKOUT"
		resp.Error = "Dogfood mode can prepare only Yaver's own checkout."
		resp.Remedy = "Select the yaver.io checkout on the primary device and retry."
		return http.StatusBadRequest, resp
	}

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
		resp.Code = "DOGFOOD_GIT_FETCH_FAILED"
		resp.Error = "The primary device could not fetch origin/main."
		resp.Remedy = "Check its GitHub authentication and network, then retry."
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
