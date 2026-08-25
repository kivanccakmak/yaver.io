package main

// dogfood_runtime.go — fail-closed source readiness + runtime awareness for
// Yaver rendering Yaver.
//
// Dogfood is not "a dev server happened to be running". Entry means all of
// these operations succeeded on the selected render box:
//
//   1. the checkout is Yaver itself;
//   2. canonical main was fetched (origin for a clone, upstream for a fork);
//   3. the current contribution branch rebased onto that base with --autostash;
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
	"io"
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
	BaseRemote    string         `json:"baseRemote,omitempty"`
	BaseRef       string         `json:"baseRef,omitempty"`
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

// dogfoodCanonicalBase accepts both the simple clone layout
// (origin=yaver-io/yaver.io) and the normal contributor layout
// (origin=<their fork>, upstream=yaver-io/yaver.io). The canonical remote is
// fetch-only base truth; it is never inferred from a repo-shaped directory.
func dogfoodCanonicalBase(workDir string) (name, remote string) {
	remotesOut, err := runGit(workDir, "remote")
	if err != nil {
		return "", ""
	}
	remotes := strings.Fields(remotesOut)
	ordered := make([]string, 0, len(remotes)+2)
	for _, preferred := range []string{"upstream", "origin"} {
		for _, candidate := range remotes {
			if candidate == preferred {
				ordered = append(ordered, candidate)
			}
		}
	}
	for _, candidate := range remotes {
		if candidate != "upstream" && candidate != "origin" {
			ordered = append(ordered, candidate)
		}
	}
	for _, candidate := range ordered {
		url, _ := runGit(workDir, "config", "--get", "remote."+candidate+".url")
		url = strings.TrimSpace(url)
		if canonicalYaverRemote(url) {
			return candidate, url
		}
	}
	return "", ""
}

// findDogfoodCheckout checks only the normal one-level workspace roots. This
// is deliberately bounded: Dogfood readiness must never recursively walk a
// home directory and make an otherwise-live box look offline.
func findDogfoodCheckout() string {
	home, _ := os.UserHomeDir()
	bestPath := ""
	bestScore := -1 << 30
	for _, parent := range []string{"Workspace", "Projects", "repos", "code", "src", "dev"} {
		for _, repo := range scanDirForRepos(filepath.Join(home, parent)) {
			baseRemote, _ := dogfoodCanonicalBase(repo.Path)
			if IsYaverSelfDevelopmentDir(repo.Path) && baseRemote != "" {
				score := dogfoodCheckoutScore(repo.Path)
				if score > bestScore {
					bestPath, bestScore = repo.Path, score
				}
			}
		}
	}
	return bestPath
}

// Prefer the user's real named checkout over disposable validation fixtures.
// A detached worktree is still a valid fallback, but it must never beat a
// normal branch just because directory enumeration happened to return it first.
func dogfoodCheckoutScore(workDir string) int {
	name := strings.ToLower(filepath.Base(filepath.Clean(workDir)))
	score := 0
	if name == "yaver.io" {
		score += 200
	} else if name == "yaver" {
		score += 160
	}
	if strings.Contains(name, "validation") || strings.Contains(name, "fixture") || strings.Contains(name, "test-") {
		score -= 200
	}
	branch, _ := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
	if branch = strings.TrimSpace(branch); branch != "" && branch != "HEAD" {
		score += 100
	}
	return score
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
			Remedy:  "Select or clone a real yaver.io Git checkout so Dogfood can safely sync canonical main.",
		}
	}
	// Read the persisted value rather than `remote get-url`: Git applies
	// url.*.insteadOf rewrites to the latter, which can make a valid canonical
	// origin look like a credential helper or local mirror target.
	origin, originErr := runGit(workDir, "config", "--get", "remote.origin.url")
	origin = strings.TrimSpace(origin)
	if originErr != nil || origin == "" {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_ORIGIN_MISSING", Path: workDir, SuggestedPath: suggested, GitVersion: strings.TrimSpace(version),
			Message: "The Yaver checkout has no origin remote for contribution branches.",
			Remedy:  "Add your fork as origin, or clone the public yaver-io/yaver.io repository, then retry.",
		}
	}
	if clean := stripURLCredentials(origin); clean != origin {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_CREDENTIALS_EMBEDDED", Path: workDir, SuggestedPath: suggested, Remote: clean, GitVersion: strings.TrimSpace(version),
			Message: "The Yaver origin stores a credential inside its URL.",
			Remedy:  "Remove the embedded credential, then use Yaver's Git configuration wizard so secrets stay in the box credential store.",
		}
	}
	baseRemote, canonicalURL := dogfoodCanonicalBase(workDir)
	if baseRemote == "" {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_UPSTREAM_MISSING", Path: workDir, SuggestedPath: suggested, Remote: stripURLCredentials(origin), GitVersion: strings.TrimSpace(version),
			Message: "The checkout has no remote pointing to yaver-io/yaver.io.",
			Remedy:  "Keep your fork as origin and add the canonical repository as upstream, then retry.",
		}
	}
	if clean := stripURLCredentials(canonicalURL); clean != canonicalURL {
		return dogfoodSourceResponse{
			Code: "DOGFOOD_GIT_CREDENTIALS_EMBEDDED", Path: workDir, SuggestedPath: suggested, Remote: clean, GitVersion: strings.TrimSpace(version),
			Message: "The canonical Yaver remote stores a credential inside its URL.",
			Remedy:  "Remove the embedded credential; public upstream fetches do not need one.",
		}
	}
	branch, _ := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
	return dogfoodSourceResponse{
		OK: true, Ready: true, Code: "DOGFOOD_SOURCE_READY", Path: workDir,
		SuggestedPath: suggested, Branch: strings.TrimSpace(branch), Remote: stripURLCredentials(origin),
		BaseRemote: baseRemote, BaseRef: baseRemote + "/main",
		GitVersion: strings.TrimSpace(version), Message: "Yaver source and its Git origin are ready on this box.",
	}
}

func (s *HTTPServer) handleDogfoodSourceStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
		return
	}
	jsonReply(w, http.StatusOK, dogfoodSourceStatus(r.URL.Query().Get("workDir")))
}

type dogfoodPrepareRequest struct {
	WorkDir string `json:"workDir"`
}

type dogfoodPrepareResponse struct {
	OK                 bool     `json:"ok"`
	Code               string   `json:"code,omitempty"`
	WorkDir            string   `json:"workDir,omitempty"`
	Branch             string   `json:"branch,omitempty"`
	Base               string   `json:"base,omitempty"`
	Head               string   `json:"head,omitempty"`
	Rebased            bool     `json:"rebased,omitempty"`
	ContributionBranch bool     `json:"contributionBranch,omitempty"`
	PushPolicy         string   `json:"pushPolicy,omitempty"`
	IndexRecovered     bool     `json:"indexRecovered,omitempty"`
	RequiresAgent      bool     `json:"requiresAgent,omitempty"`
	Conflicts          []string `json:"conflicts,omitempty"`
	Error              string   `json:"error,omitempty"`
	Remedy             string   `json:"remedy,omitempty"`
	FixPrompt          string   `json:"fixPrompt,omitempty"`
	Output             string   `json:"output,omitempty"`
}

const dogfoodConflictInspectionLimit = 8 << 20

// recoverResolvedDogfoodIndex closes the narrow gap between an AI runner's
// workspace-write sandbox and Git: Codex can resolve files in the checkout,
// but deliberately cannot write .git/index. On the user's explicit retry we
// may stage only Git's already-unmerged paths, and only after every surviving
// file is marker-free. We never choose content, commit, reset, drop a stash or
// touch a path outside the checkout.
func recoverResolvedDogfoodIndex(workDir string) (recovered bool, pending []string, err error) {
	conflicts := parseConflictedFiles(workDir)
	if len(conflicts) == 0 {
		return false, nil, nil
	}
	root, err := filepath.Abs(workDir)
	if err != nil {
		return false, conflicts, err
	}
	for _, rel := range conflicts {
		clean := filepath.Clean(rel)
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return false, conflicts, fmt.Errorf("conflict path escapes checkout: %q", rel)
		}
		path := filepath.Join(root, clean)
		if path != root && !strings.HasPrefix(path, root+string(filepath.Separator)) {
			return false, conflicts, fmt.Errorf("conflict path escapes checkout: %q", rel)
		}
		info, statErr := os.Lstat(path)
		if os.IsNotExist(statErr) {
			continue // AI intentionally resolved a modify/delete conflict as deletion.
		}
		if statErr != nil {
			return false, conflicts, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue // Git stages the link itself; never follow it during inspection.
		}
		if !info.Mode().IsRegular() {
			return false, conflicts, fmt.Errorf("conflicted path is not a regular file or symlink: %s", rel)
		}
		f, openErr := os.Open(path)
		if openErr != nil {
			return false, conflicts, openErr
		}
		data, readErr := io.ReadAll(io.LimitReader(f, dogfoodConflictInspectionLimit+1))
		closeErr := f.Close()
		if readErr != nil {
			return false, conflicts, readErr
		}
		if closeErr != nil {
			return false, conflicts, closeErr
		}
		if len(data) > dogfoodConflictInspectionLimit {
			return false, conflicts, fmt.Errorf("conflicted file is too large to verify safely: %s", rel)
		}
		if containsGitConflictMarker(data) {
			pending = append(pending, rel)
		}
	}
	if len(pending) > 0 {
		return false, pending, nil
	}
	args := append([]string{"add", "-A", "--"}, conflicts...)
	if output, addErr := runGit(workDir, args...); addErr != nil {
		return false, conflicts, fmt.Errorf("stage resolved conflict paths: %v: %s", addErr, strings.TrimSpace(output))
	}
	return true, nil, nil
}

func containsGitConflictMarker(data []byte) bool {
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		if bytes.HasPrefix(line, []byte("<<<<<<<")) ||
			bytes.Equal(line, []byte("=======")) ||
			bytes.HasPrefix(line, []byte(">>>>>>>")) {
			return true
		}
	}
	return false
}

func dogfoodConflictPrompt(workDir, branch, baseRef string, conflicts []string, detail string) string {
	files := strings.Join(conflicts, ", ")
	if files == "" {
		files = "ask Git for the unresolved files"
	}
	if strings.TrimSpace(baseRef) == "" {
		baseRef = "origin/main"
	}
	return fmt.Sprintf(`Prepare Yaver Dogfood mode in %s. The current branch %s could not be safely rebased onto %s. Resolve the Git conflict while preserving BOTH the local work and %s; never force-push, never drop a stash, and never discard uncommitted changes. Conflicted files: %s. Failure detail: %s. After resolving, run the relevant focused tests and leave the checkout ready for a normal git rebase %s.`, workDir, branch, baseRef, baseRef, files, strings.TrimSpace(detail), baseRef)
}

// prepareDogfoodCheckout fetches the canonical main remote (origin for a
// simple clone, upstream for a fork) and rebases the current named branch onto
// it. --autostash preserves tracked local edits. An active rebase
// is refused rather than inherited. A rebase conflict is aborted immediately;
// an autostash re-apply conflict is reported honestly because Git has already
// completed the rebase and there is no rebase left to abort.
func prepareDogfoodCheckout(workDir string) (int, dogfoodPrepareResponse) {
	return prepareDogfoodCheckoutWithPolicy(workDir, true)
}

// prepareDogfoodCheckoutWithPolicy keeps the maintainer lane unchanged while
// making community Dogfood safe by construction. A contributor who enters on
// main is moved to a fresh local branch before any runner can edit or push.
func prepareDogfoodCheckoutWithPolicy(workDir string, allowCanonicalMainPush bool) (int, dogfoodPrepareResponse) {
	workDir = strings.TrimSpace(workDir)
	resp := dogfoodPrepareResponse{WorkDir: workDir}
	source := dogfoodSourceStatus(workDir)
	if !source.Ready {
		resp.Code = source.Code
		resp.Error = source.Message
		resp.Remedy = source.Remedy
		return http.StatusBadRequest, resp
	}
	workDir = source.Path
	resp.WorkDir = workDir
	resp.Base = source.BaseRef
	if resp.Base == "" {
		resp.Base = "origin/main"
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
	if isMergeInProgress(workDir) || isRebaseInProgress(workDir) {
		resp.Code = "DOGFOOD_GIT_OPERATION_IN_PROGRESS"
		resp.Error = "The Yaver checkout already has a merge or rebase in progress."
		resp.Remedy = "Finish or abort that existing Git operation before entering Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = parseConflictedFiles(workDir)
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, resp.Base, resp.Conflicts, resp.Error)
		return http.StatusConflict, resp
	}
	if branch == "HEAD" || branch == "" {
		recovered, contribution, out, recoverErr := recoverDetachedDogfoodBranch(workDir, resp.Base, allowCanonicalMainPush)
		if recoverErr != nil {
			resp.Code = "DOGFOOD_GIT_DETACHED_RECOVERY_FAILED"
			resp.Error = "Yaver could not preserve the detached checkout on a named branch."
			resp.Remedy = "Choose another Yaver checkout or create a named branch, then retry."
			resp.Output = strings.TrimSpace(out)
			return http.StatusConflict, resp
		}
		branch = recovered
		resp.Branch = branch
		resp.ContributionBranch = contribution
	}
	if !allowCanonicalMainPush {
		resp.PushPolicy = "canonical-main-protected"
		if branch == "main" {
			contributionBranch := "dogfood/community-" + time.Now().UTC().Format("20060102-150405.000")
			if out, switchErr := runGit(workDir, "checkout", "-b", contributionBranch); switchErr != nil {
				resp.Code = "DOGFOOD_CONTRIBUTION_BRANCH_FAILED"
				resp.Error = "Yaver could not create a safe contribution branch from main."
				resp.Remedy = "Create a non-main branch in this checkout, then retry Dogfood mode."
				resp.Output = strings.TrimSpace(out)
				return http.StatusConflict, resp
			}
			branch = contributionBranch
			resp.Branch = branch
			resp.ContributionBranch = true
		}
	}
	// A Fix-with-AI task can edit the resolution but its workspace-write
	// sandbox cannot mutate .git/index. Retry is the user's explicit signal to
	// accept those marker-free file choices. Stage only Git's unmerged paths;
	// fail closed while a marker remains or inspection is not safely bounded.
	recovered, pending, recoverErr := recoverResolvedDogfoodIndex(workDir)
	if recoverErr != nil || len(pending) > 0 {
		resp.Code = "DOGFOOD_GIT_CONFLICT_UNRESOLVED"
		resp.Error = "The retained Dogfood conflict is not fully resolved yet."
		resp.Remedy = "Finish resolving the named files with Fix with AI, then retry Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = pending
		if len(resp.Conflicts) == 0 {
			resp.Conflicts = parseConflictedFiles(workDir)
		}
		if recoverErr != nil {
			resp.Output = recoverErr.Error()
		}
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, resp.Base, resp.Conflicts, resp.Error+" "+resp.Output)
		return http.StatusConflict, resp
	}
	resp.IndexRecovered = recovered

	baseRemote := source.BaseRemote
	if baseRemote == "" {
		baseRemote = "origin"
	}
	fetchOut, fetchErr := runGit(workDir, "fetch", baseRemote, "main")
	if fetchErr != nil {
		lower := strings.ToLower(fetchOut)
		if strings.Contains(lower, "authentication failed") || strings.Contains(lower, "permission denied") || strings.Contains(lower, "could not read username") {
			resp.Code = "DOGFOOD_GIT_AUTH_UNCONFIGURED"
			resp.Error = "GitHub authentication is not configured or was rejected on this box."
			resp.Remedy = "Open the Git configuration wizard on mobile, authorize GitHub for this box, then retry."
		} else {
			resp.Code = "DOGFOOD_GIT_FETCH_FAILED"
			resp.Error = "The primary device could not fetch " + resp.Base + "."
			resp.Remedy = "Check its network and Git configuration, then retry."
		}
		resp.Output = strings.TrimSpace(fetchOut)
		return http.StatusBadGateway, resp
	}
	if _, verifyErr := runGit(workDir, "rev-parse", "--verify", resp.Base); verifyErr != nil {
		resp.Code = "DOGFOOD_GIT_MAIN_MISSING"
		resp.Error = "The fetched repository does not expose " + resp.Base + "."
		resp.Remedy = "Restore the canonical Yaver remote and its main branch, then retry."
		return http.StatusConflict, resp
	}

	rebaseOut, rebaseErr := runGit(workDir, "rebase", "--autostash", resp.Base)
	if rebaseErr != nil {
		conflicts := parseConflictedFiles(workDir)
		abortOut, abortErr := runGit(workDir, "rebase", "--abort")
		resp.Code = "DOGFOOD_GIT_REBASE_CONFLICT"
		resp.Error = "The Yaver checkout could not be rebased onto " + resp.Base + " without conflicts."
		resp.Remedy = "Use Fix with AI to resolve the named files, then retry Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = conflicts
		resp.Output = strings.TrimSpace(rebaseOut)
		if abortErr != nil && strings.TrimSpace(abortOut) != "" {
			resp.Output += "\nrebase abort: " + strings.TrimSpace(abortOut)
		}
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, resp.Base, conflicts, resp.Output)
		return http.StatusConflict, resp
	}

	// Git can exit zero after the rebase while restoring its autostash leaves
	// UU entries. Never call that ready and let Metro discover the markers.
	if conflicts := parseConflictedFiles(workDir); len(conflicts) > 0 {
		resp.Code = "DOGFOOD_GIT_AUTOSTASH_CONFLICT"
		resp.Error = resp.Base + " was rebased, but restoring local edits produced conflicts."
		resp.Remedy = "Use Fix with AI to reconcile the retained autostash, then retry Dogfood mode."
		resp.RequiresAgent = true
		resp.Conflicts = conflicts
		resp.Output = strings.TrimSpace(rebaseOut)
		resp.FixPrompt = dogfoodConflictPrompt(workDir, branch, resp.Base, conflicts, resp.Output)
		return http.StatusConflict, resp
	}

	head, _ := runGit(workDir, "rev-parse", "--short", "HEAD")
	resp.OK = true
	resp.Code = "DOGFOOD_GIT_READY"
	resp.Head = strings.TrimSpace(head)
	resp.Rebased = true
	return http.StatusOK, resp
}

// recoverDetachedDogfoodBranch never moves or deletes a commit. Maintainers
// return to main only when detached HEAD already equals the local main tip;
// otherwise a recovery branch preserves the exact HEAD. Contributors always
// enter their isolated community branch.
func recoverDetachedDogfoodBranch(workDir, baseRef string, allowCanonicalMainPush bool) (branch string, contribution bool, output string, err error) {
	head, headErr := runGit(workDir, "rev-parse", "HEAD")
	if headErr != nil || strings.TrimSpace(head) == "" {
		return "", false, head, headErr
	}
	if allowCanonicalMainPush {
		mainHead, _ := runGit(workDir, "rev-parse", "--verify", "refs/heads/main")
		if strings.TrimSpace(mainHead) == strings.TrimSpace(head) {
			out, checkoutErr := runGit(workDir, "checkout", "main")
			return "main", false, out, checkoutErr
		}
		baseHead, _ := runGit(workDir, "rev-parse", "--verify", baseRef)
		if strings.TrimSpace(mainHead) == "" && strings.TrimSpace(baseHead) == strings.TrimSpace(head) {
			out, checkoutErr := runGit(workDir, "checkout", "-b", "main", "--track", baseRef)
			return "main", false, out, checkoutErr
		}
		branch = "dogfood/recovered-" + time.Now().UTC().Format("20060102-150405.000")
	} else {
		branch = "dogfood/community-" + time.Now().UTC().Format("20060102-150405.000")
		contribution = true
	}
	out, checkoutErr := runGit(workDir, "checkout", "-b", branch)
	return branch, contribution, out, checkoutErr
}

func (s *HTTPServer) handleDogfoodPrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var req dogfoodPrepareRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		jsonReply(w, http.StatusBadRequest, dogfoodPrepareResponse{Code: "DOGFOOD_BAD_REQUEST", Error: "Invalid Dogfood prepare request."})
		return
	}
	status, resp := prepareDogfoodCheckoutWithPolicy(req.WorkDir, currentUserIsOwner())
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
	status, resp := s.dogfoodRerender()
	jsonReply(w, status, resp)
}
