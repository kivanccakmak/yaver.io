package main

// git_operation_lock.go coordinates repository access across every HTTP/MCP
// client of one Yaver Go agent. Desktop, web, mobile, and a standalone CLI can
// all address that same agent concurrently; a multi-command transaction such
// as add -> commit -> fetch -> rebase -> push must not interleave with another
// checkout, stash, or sync on the same repository.
//
// Keys are discovered from the nearest .git marker at runtime. No username,
// home directory, checkout parent, or operating-system layout is assumed.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var gitOperationLocks sync.Map // canonical repository path -> *sync.RWMutex

func canonicalGitOperationKey(workDir string) string {
	key := strings.TrimSpace(workDir)
	if key == "" {
		return ""
	}
	if abs, err := filepath.Abs(key); err == nil {
		key = abs
	}
	if resolved, err := filepath.EvalSymlinks(key); err == nil {
		key = resolved
	}
	key = filepath.Clean(key)
	if info, err := os.Stat(key); err == nil && !info.IsDir() {
		key = filepath.Dir(key)
	}

	// A linked worktree uses a .git file while a normal checkout uses a .git
	// directory, so existence—not marker type—is the correct operation probe.
	for candidate := key; ; candidate = filepath.Dir(candidate) {
		if _, err := os.Lstat(filepath.Join(candidate, ".git")); err == nil {
			key = candidate
			// workDir itself may not exist yet (clone target), so its initial
			// EvalSymlinks can fail even though an ancestor is reachable through
			// an OS-level alias. Resolve the actual .git owner after discovery so
			// both spellings share one lock.
			if resolved, resolveErr := filepath.EvalSymlinks(candidate); resolveErr == nil {
				key = resolved
			}
			break
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
	}
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

func gitOperationLock(workDir string) *sync.RWMutex {
	key := canonicalGitOperationKey(workDir)
	value, _ := gitOperationLocks.LoadOrStore(key, &sync.RWMutex{})
	return value.(*sync.RWMutex)
}
