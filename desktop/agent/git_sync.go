package main

// git_sync.go — safe remote-repo rebase + sync for any surface.
//
//	POST /git/pull          {workDir?, rebase?}   hardened pull
//	POST /git/sync-remote   {workDir?}            status → rebase → push
//
// The problem /git/pull used to be: a plain `git pull` on a repo with local
// commits either refuses (non-fast-forward) or merges (creating a merge
// commit a coding agent did not intend). Neither is what "sync my remote
// repo" means from a phone, a TV, or the web. This file makes pull default to
// `--rebase --autostash` — the same lossless, linear-history behaviour the
// vibing commit path already uses — and adds a single deterministic
// status→rebase→push transaction (mirroring git_commit_push.go) for repos
// that have nothing to commit but a remote to catch up with (e.g. the `talos`
// customer repo, which surfaces should be able to rebase without touching a
// terminal).
//
// Safety contract (same as git_commit_push.go):
//   - `--autostash` guarantees a dirty tree is not a reason to refuse: local
//     changes are stashed for the duration of the rebase and restored after.
//   - A rebase that stops mid-way on conflicts is ABORTED immediately so the
//     working tree is never left in a rebasing state. Conflicts are reported
//     to the caller with the file list, not silently resolved. Git has one
//     different edge: autostash re-apply conflicts can exit ZERO after the
//     rebase already completed. We detect the unmerged index, refuse to push,
//     and name that the retained autostash needs resolution; claiming a clean
//     abort there would be a lie because there is no rebase left to abort.
//   - Nothing is ever force-pushed. A rejected push after rebase surfaces as
//     an error for the caller (or a coding agent) to handle.

import (
	"encoding/json"
	"net/http"
	"strings"
)

// gitPullRequest mirrors the existing /git/pull body plus a rebase toggle.
type gitPullRequest struct {
	WorkDir string `json:"workDir,omitempty"`
	// Rebase controls whether the pull rebases (--rebase --autostash, default
	// true) or uses a plain merge pull (old behaviour). Rebasing is the
	// lossless default; a caller that wants a merge can set this false.
	Rebase *bool `json:"rebase,omitempty"`
}

type gitSyncRemoteResponse struct {
	OK      bool     `json:"ok"`
	Branch  string   `json:"branch,omitempty"`
	Hash    string   `json:"hash,omitempty"`
	Actions []string `json:"actions,omitempty"`
	Rebased bool     `json:"rebased,omitempty"`
	Pushed  bool     `json:"pushed,omitempty"`
	// RequiresAgent: true when the rebase introduced conflicts only a coding
	// agent can resolve. Tree was aborted back to clean.
	RequiresAgent bool     `json:"requiresAgent,omitempty"`
	Conflicts     []string `json:"conflicts,omitempty"`
	Error         string   `json:"error,omitempty"`
	Output        string   `json:"output,omitempty"`
}

// handleGitPull serves POST /git/pull. Rebased by default.
func (s *HTTPServer) handleGitPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}
	var req gitPullRequest
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	workDir := strings.TrimSpace(req.WorkDir)
	if workDir == "" {
		workDir = getGitWorkDir(r, s.taskMgr)
	}
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}
	lock := gitOperationLock(workDir)
	lock.Lock()
	defer lock.Unlock()
	rebase := true
	if req.Rebase != nil {
		rebase = *req.Rebase
	}
	args := []string{"pull"}
	if rebase {
		args = append(args, "--rebase", "--autostash")
	}
	out, err := runGit(workDir, args...)
	if err != nil {
		// A rebase that stopped mid-way must not leave the tree in a rebasing
		// state — abort it so the caller's next action sees a clean tree.
		if rebase {
			_, _ = runGit(workDir, "rebase", "--abort")
		}
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git pull failed: " + out})
		return
	}
	if rebase {
		if conflicts := parseConflictedFiles(workDir); len(conflicts) > 0 {
			jsonReply(w, http.StatusConflict, gitSyncRemoteResponse{
				RequiresAgent: true,
				Conflicts:     conflicts,
				Error:         "git pull rebased, but restoring the autostash produced conflicts; nothing was pushed and git retained the autostash for recovery",
				Output:        out,
			})
			return
		}
	}
	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// handleGitSyncRemote serves POST /git/sync-remote.
func (s *HTTPServer) handleGitSyncRemote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}
	var req struct {
		WorkDir string `json:"workDir,omitempty"`
	}
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	workDir := strings.TrimSpace(req.WorkDir)
	if workDir == "" {
		workDir = getGitWorkDir(r, s.taskMgr)
	}
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}
	status, resp := runGitSyncRemote(workDir)
	jsonReply(w, status, resp)
}

// runGitSyncRemote is the transport-agnostic core of a safe remote-repo sync:
// status → pull --rebase --autostash against origin/<branch> → push (never
// force). Returns the HTTP status and the structured response. The MCP
// `git_sync_remote` tool and the `/git/sync-remote` HTTP handler share it so a
// constrained surface reaching Yaver over MCP gets the identical conflict-abort
// guarantee as a direct HTTP caller.
func runGitSyncRemote(workDir string) (int, gitSyncRemoteResponse) {
	lock := gitOperationLock(workDir)
	lock.Lock()
	defer lock.Unlock()

	resp := gitSyncRemoteResponse{}

	branch, err := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		resp.Error = "not a git repo (or git failed): " + branch
		return http.StatusInternalServerError, resp
	}
	resp.Branch = branch
	if branch == "HEAD" {
		resp.Error = "cannot sync a detached HEAD; check out a named branch first"
		return http.StatusConflict, resp
	}

	// 1. Rebase against origin/<branch> with autostash. This is the whole
	//    point: take whatever the remote gained without a merge commit.
	if out, err := runGit(workDir, "pull", "--rebase", "--autostash", "origin", branch); err != nil {
		// Detect a conflict: the rebase stopped, tree is mid-rebase.
		low := strings.ToLower(out)
		if strings.Contains(low, "could not apply") || strings.Contains(low, "conflict") || strings.Contains(low, "fix conflicts") {
			conflicts := parseConflictedFiles(workDir)
			abortOut, abortErr := runGit(workDir, "rebase", "--abort")
			resp.Error = "rebase produced merge conflicts"
			resp.Output = out
			resp.RequiresAgent = true
			resp.Conflicts = conflicts
			resp.Actions = append(resp.Actions, "pull --rebase --autostash")
			if abortErr == nil {
				resp.Actions = append(resp.Actions, "rebase --abort")
			} else if strings.TrimSpace(abortOut) != "" {
				resp.Output += "\nrebase abort: " + abortOut
			}
			return http.StatusConflict, resp
		}
		// Some failures leave a rebase active without using Git's usual English
		// conflict phrases. Abort is idempotent when no rebase exists; attempt it
		// on every failed pull so the next operation never inherits half a rebase.
		if _, abortErr := runGit(workDir, "rebase", "--abort"); abortErr == nil {
			resp.Actions = append(resp.Actions, "rebase --abort")
		}
		resp.Error = "git pull --rebase failed"
		resp.Output = out
		return http.StatusInternalServerError, resp
	}
	resp.Actions = append(resp.Actions, "pull --rebase --autostash")
	resp.Rebased = true
	// INVENTORY vs operation: Git exits 0 when the rebase succeeds but applying
	// its autostash conflicts. The tree then contains unmerged files and the
	// stash is retained. A zero exit is not a successful sync, and pushing here
	// publishes a commit while the user's edits are unresolved.
	if conflicts := parseConflictedFiles(workDir); len(conflicts) > 0 {
		resp.Error = "rebase completed, but restoring the autostash produced conflicts; nothing was pushed and git retained the autostash for recovery"
		resp.Output = "Resolve the listed files, then drop the retained autostash only after verifying the restored changes."
		resp.RequiresAgent = true
		resp.Conflicts = conflicts
		return http.StatusConflict, resp
	}

	// 2. Report the resulting HEAD, then push. Never force.
	hash, _ := runGit(workDir, "rev-parse", "--short", "HEAD")
	resp.Hash = hash

	pushOut, pushErr := runGit(workDir, "push", "origin", "HEAD:refs/heads/"+branch)
	if pushErr == nil {
		resp.Actions = append(resp.Actions, "push origin HEAD:refs/heads/"+branch)
		resp.Pushed = true
		resp.OK = true
		return http.StatusOK, resp
	}
	resp.Error = "git push failed (never force-pushes)"
	resp.Output = pushOut
	return http.StatusInternalServerError, resp
}
