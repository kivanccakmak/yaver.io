package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GitStatus represents the status of a git repository.
type GitStatus struct {
	Branch    string    `json:"branch"`
	Ahead     int       `json:"ahead"`
	Behind    int       `json:"behind"`
	Clean     bool      `json:"clean"`
	Staged    []GitFile `json:"staged"`
	Modified  []GitFile `json:"modified"`
	Untracked []GitFile `json:"untracked"`
}

// GitFile represents a file in a git status.
type GitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "added", "modified", "deleted", "renamed"
}

// GitCommit represents a commit in the log.
type GitCommit struct {
	Hash         string `json:"hash"`
	ShortHash    string `json:"shortHash"`
	Message      string `json:"message"`
	Author       string `json:"author"`
	Date         string `json:"date"`
	FilesChanged int    `json:"filesChanged"`
}

const gitCmdTimeout = 30 * time.Second

// runGit runs a git command in the given directory with a timeout.
func runGit(workDir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitCmdTimeout)
	defer cancel()

	cmd := osexec.CommandContext(ctx, "git", args...)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func getGitWorkDir(r *http.Request, taskMgr *TaskManager) string {
	workDir := r.URL.Query().Get("workDir")
	if workDir == "" && taskMgr != nil {
		workDir = taskMgr.workDir
	}
	return workDir
}

// handleGitStatus handles GET /git/status.
func (s *HTTPServer) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	status := GitStatus{}

	// Get current branch
	if out, err := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		status.Branch = out
	}

	// Get ahead/behind
	if out, err := runGit(workDir, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"); err == nil {
		parts := strings.Fields(out)
		if len(parts) == 2 {
			status.Ahead, _ = strconv.Atoi(parts[0])
			status.Behind, _ = strconv.Atoi(parts[1])
		}
	}

	// Get porcelain status
	if out, err := runGit(workDir, "status", "--porcelain"); err == nil {
		if out == "" {
			status.Clean = true
		} else {
			for _, line := range strings.Split(out, "\n") {
				if len(line) < 4 {
					continue
				}
				x := line[0]  // index status
				y := line[1]  // worktree status
				path := strings.TrimSpace(line[3:])

				// Handle renames — "R  old -> new"
				if strings.Contains(path, " -> ") {
					parts := strings.SplitN(path, " -> ", 2)
					if len(parts) == 2 {
						path = parts[1]
					}
				}

				file := GitFile{Path: path}

				// Staged changes (index)
				switch x {
				case 'A':
					file.Status = "added"
					status.Staged = append(status.Staged, file)
				case 'M':
					file.Status = "modified"
					status.Staged = append(status.Staged, file)
				case 'D':
					file.Status = "deleted"
					status.Staged = append(status.Staged, file)
				case 'R':
					file.Status = "renamed"
					status.Staged = append(status.Staged, file)
				}

				// Working tree changes
				switch y {
				case 'M':
					file.Status = "modified"
					status.Modified = append(status.Modified, file)
				case 'D':
					file.Status = "deleted"
					status.Modified = append(status.Modified, file)
				}

				// Untracked
				if x == '?' && y == '?' {
					file.Status = "added"
					status.Untracked = append(status.Untracked, file)
				}
			}
		}
	}

	jsonReply(w, http.StatusOK, status)
}

// handleGitLog handles GET /git/log.
func (s *HTTPServer) handleGitLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	limit := r.URL.Query().Get("limit")
	if limit == "" {
		limit = "20"
	}

	// Format: hash|shortHash|author|date|message
	out, err := runGit(workDir, "log", "--format=%H|%h|%an|%aI|%s", "-n", limit)
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git log failed: " + out})
		return
	}

	var commits []GitCommit
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 5)
		if len(parts) < 5 {
			continue
		}
		commit := GitCommit{
			Hash:      parts[0],
			ShortHash: parts[1],
			Author:    parts[2],
			Date:      parts[3],
			Message:   parts[4],
		}

		// Get files changed count
		if fcOut, err := runGit(workDir, "diff-tree", "--no-commit-id", "--name-only", "-r", commit.Hash); err == nil {
			lines := strings.Split(strings.TrimSpace(fcOut), "\n")
			if len(lines) > 0 && lines[0] != "" {
				commit.FilesChanged = len(lines)
			}
		}

		commits = append(commits, commit)
	}

	jsonReply(w, http.StatusOK, commits)
}

// handleGitDiff handles GET /git/diff.
func (s *HTTPServer) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	file := r.URL.Query().Get("file")

	// Get both staged and unstaged diff
	args := []string{"diff", "HEAD"}
	if file != "" {
		args = append(args, "--", file)
	}

	out, err := runGit(workDir, args...)
	if err != nil {
		// Fallback: try without HEAD (for repos with no commits)
		args = []string{"diff"}
		if file != "" {
			args = append(args, "--", file)
		}
		out, err = runGit(workDir, args...)
		if err != nil {
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git diff failed"})
			return
		}
	}

	jsonReply(w, http.StatusOK, map[string]string{"diff": out})
}

// handleGitBranches handles GET /git/branches.
func (s *HTTPServer) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	out, err := runGit(workDir, "branch", "-a", "--format=%(refname:short)|%(HEAD)")
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git branch failed: " + out})
		return
	}

	type BranchInfo struct {
		Name    string `json:"name"`
		Current bool   `json:"current"`
	}

	var branches []BranchInfo
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		name := parts[0]
		current := len(parts) > 1 && strings.TrimSpace(parts[1]) == "*"
		branches = append(branches, BranchInfo{Name: name, Current: current})
	}

	jsonReply(w, http.StatusOK, branches)
}

// handleGitStash handles POST /git/stash.
func (s *HTTPServer) handleGitStash(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	out, err := runGit(workDir, "stash", "push", "-m", fmt.Sprintf("yaver-stash-%d", time.Now().Unix()))
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git stash failed: " + out})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// handleGitStashPop handles POST /git/stash-pop.
func (s *HTTPServer) handleGitStashPop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	out, err := runGit(workDir, "stash", "pop")
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git stash pop failed: " + out})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// handleGitCheckout handles POST /git/checkout.
func (s *HTTPServer) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	var req struct {
		Branch string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if req.Branch == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing branch"})
		return
	}

	out, err := runGit(workDir, "checkout", req.Branch)
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git checkout failed: " + out})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "branch": req.Branch})
}

// handleGitCommit handles POST /git/commit.
func (s *HTTPServer) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	var req struct {
		Message string   `json:"message"`
		Files   []string `json:"files"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if req.Message == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing message"})
		return
	}

	// Stage files
	if len(req.Files) > 0 {
		args := append([]string{"add"}, req.Files...)
		if out, err := runGit(workDir, args...); err != nil {
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git add failed: " + out})
			return
		}
	} else {
		// Stage all changes
		if out, err := runGit(workDir, "add", "-A"); err != nil {
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git add failed: " + out})
			return
		}
	}

	out, err := runGit(workDir, "commit", "-m", req.Message)
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git commit failed: " + out})
		return
	}

	// Get the new commit hash
	hash, _ := runGit(workDir, "rev-parse", "--short", "HEAD")

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "hash": hash, "message": out})
}

// handleGitPush handles POST /git/push.
func (s *HTTPServer) handleGitPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	out, err := runGit(workDir, "push")
	if err != nil {
		// Try push with --set-upstream
		branch, _ := runGit(workDir, "rev-parse", "--abbrev-ref", "HEAD")
		out, err = runGit(workDir, "push", "--set-upstream", "origin", branch)
		if err != nil {
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git push failed: " + out})
			return
		}
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// handleGitPull handles POST /git/pull.
func (s *HTTPServer) handleGitPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	out, err := runGit(workDir, "pull")
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git pull failed: " + out})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// handleGitRevert handles POST /git/revert.
func (s *HTTPServer) handleGitRevert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use POST"})
		return
	}

	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}

	var req struct {
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if req.Hash == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing hash"})
		return
	}

	out, err := runGit(workDir, "revert", "--no-edit", req.Hash)
	if err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git revert failed: " + out})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "message": out})
}

// GitTreeEntry is one file/dir entry returned by GET /git/tree.
type GitTreeEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// handleGitTree handles GET /git/tree — list the files under a path
// inside a repo. Reads from the working tree (git ls-files) when a
// `ref` is not supplied, or from a commit tree (`ref`) when it is.
// Used by the mobile git viewer's code browser.
func (s *HTTPServer) handleGitTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}
	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}
	sub := strings.TrimPrefix(r.URL.Query().Get("path"), "/")
	ref := r.URL.Query().Get("ref")

	var entries []GitTreeEntry

	if ref != "" {
		// Tree view at a commit — git ls-tree <ref>:<sub>
		args := []string{"ls-tree", "--name-only", ref, "--", sub}
		if sub == "" {
			args = []string{"ls-tree", "--name-only", ref}
		}
		out, err := runGit(workDir, args...)
		if err != nil {
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "git ls-tree failed: " + out})
			return
		}
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			name := strings.TrimPrefix(line, sub+"/")
			// git ls-tree only lists files (blobs) — a path we asked
			// about may itself be a tree that needs recursing. We can't
			// cheaply distinguish dirs from ls-tree --name-only, so fetch
			// types once.
			entries = append(entries, GitTreeEntry{Name: name, Path: joinTreePath(sub, name), IsDir: false})
		}
		// Re-classify dirs: entries that are also a prefix of another
		// entry's path are directories.
		dirSet := map[string]bool{}
		for _, e := range entries {
			for _, other := range entries {
				if other.Path != e.Path && strings.HasPrefix(other.Path, e.Path+"/") {
					dirSet[e.Path] = true
				}
			}
		}
		clean := entries[:0]
		for _, e := range entries {
			if dirSet[e.Path] {
				e.IsDir = true
				e.Size = 0
			}
			clean = append(clean, e)
		}
		entries = clean
	} else {
		// Working-tree view — list the directory on disk, keeping only
		// files that git tracks (plus directories that contain them).
		abs := filepath.Join(workDir, filepath.Clean("/"+sub))
		infos, err := os.ReadDir(abs)
		if err != nil {
			jsonReply(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		type candidate struct {
			name string
			path string
			dir  bool
			size int64
		}
		var cands []candidate
		for _, fi := range infos {
			name := fi.Name()
			// Hidden entries are usually build caches / secrets; skip
			// them so the browser doesn't surface node_modules noise.
			if strings.HasPrefix(name, ".") && name != ".gitignore" && name != ".env.example" {
				continue
			}
			p := filepath.Join(sub, name)
			c := candidate{name: name, path: p, dir: fi.IsDir()}
			if !fi.IsDir() {
				if info, err := fi.Info(); err == nil {
					c.size = info.Size()
				}
			}
			cands = append(cands, c)
		}
		// Tracked file set for filtering.
		tracked := map[string]bool{}
		if out, err := runGit(workDir, "ls-files"); err == nil {
			for _, line := range strings.Split(out, "\n") {
				tracked[line] = true
			}
		}
		// A dir stays visible if it has any tracked file beneath it.
		for _, c := range cands {
			if c.dir {
				hasTracked := false
				for tp := range tracked {
					if strings.HasPrefix(tp, c.path+"/") {
						hasTracked = true
						break
					}
				}
				if !hasTracked {
					continue
				}
			} else if !tracked[c.path] && sub == "" {
				// At the root, only show untracked files if they are
				// clearly not build output (tiny, source-looking).
				continue
			}
			entries = append(entries, GitTreeEntry{Name: c.name, Path: filepath.ToSlash(c.path), IsDir: c.dir, Size: c.size})
		}
	}

	// Sort dirs first, then names.
	sortTreeEntries(entries)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"entries": entries,
	})
}

// handleGitShow handles GET /git/show — read a file's contents.
// Reads the working-tree copy by default, or `git show <ref>:<path>`
// when a ref is supplied. Binary files are reported without content.
func (s *HTTPServer) handleGitShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "use GET"})
		return
	}
	workDir := getGitWorkDir(r, s.taskMgr)
	if workDir == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing workDir"})
		return
	}
	sub := strings.TrimPrefix(r.URL.Query().Get("path"), "/")
	if sub == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing path"})
		return
	}
	ref := r.URL.Query().Get("ref")

	const maxRead = 2 * 1024 * 1024

	if ref != "" {
		// Content at a commit.
		out, err := runGit(workDir, "show", ref+":"+sub)
		if err != nil {
			jsonReply(w, http.StatusNotFound, map[string]string{"error": "not found at " + ref + ": " + out})
			return
		}
		truncated := false
		body := out
		if int64(len(body)) > maxRead {
			body = body[:maxRead]
			truncated = true
		}
		if looksBinary([]byte(body)) {
			jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "binary": true, "size": len(out)})
			return
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "content": body, "truncated": truncated, "size": len(out)})
		return
	}

	abs := filepath.Join(workDir, filepath.Clean("/"+sub))
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	truncated := false
	readSize := info.Size()
	if readSize > maxRead {
		readSize = maxRead
		truncated = true
	}
	f, err := os.Open(abs)
	if err != nil {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	defer f.Close()
	buf := make([]byte, readSize)
	n, _ := f.Read(buf)
	buf = buf[:n]
	if looksBinary(buf) {
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "binary": true, "size": info.Size()})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "content": string(buf), "truncated": truncated, "size": info.Size()})
}

func joinTreePath(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + "/" + name
}

func sortTreeEntries(entries []GitTreeEntry) {
	// Bubble is fine — directory listings are small (< a few hundred).
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0; j-- {
			a, b := entries[j-1], entries[j]
			if b.IsDir && !a.IsDir {
				entries[j-1], entries[j] = entries[j], entries[j-1]
				continue
			}
			if a.IsDir == b.IsDir && a.Name > b.Name {
				entries[j-1], entries[j] = entries[j], entries[j-1]
			}
		}
	}
}
