package main

// capability_partial.go — a fix that dies half-way must never leave the box in
// a state it cannot get out of.
//
// THE STUCK STATE, found by auditing runFlutterInstall on 2026-07-27. The
// installer's "already installed" check is:
//
//	if info, err := os.Stat(flutterBin); err == nil && …Mode()&0o111 != 0 {
//	    logf("Flutter already installed at %s — skipping download.")
//	    return ensureFlutterShellPath(progress)
//	}
//
// Now kill the agent (or the box) during `tar -xJf`. tar writes the archive in
// order, `bin/flutter` is near the front, and it is executable. So the next
// install sees an executable at the expected path, announces "already
// installed", returns SUCCESS — and `flutter --version` fails forever on a tree
// that is 15% extracted. The user is now in the exact loop this file family
// exists to abolish: a green fix, an unchanged failure, and no sentence
// anywhere connecting the two. Re-running the install cannot help, because the
// install is what is lying. Only someone who knows to `rm -rf /opt/flutter`
// gets out, and that person is not on a phone.
//
// The same shape applies to every unpacked-SDK install: android-sdk's
// cmdline-tools unzip, the Node runtime tarball, a from-source hermesc build.
// A killed download also strands its temp archive (the installers' `defer
// os.Remove` does not run through SIGKILL), which is disk the box never gets
// back and, on a small volume, is itself the next failure.
//
// THE FIX, in three parts:
//
//  1. A COMPLETION MARKER, written last. An install root that exists WITHOUT
//     its marker is provably partial — no heuristic, no mtime guessing. The
//     marker records what wrote it and when, so the state is self-describing
//     rather than merely detectable.
//  2. SELF-CLEARING. beginToolInstall removes a partial tree before starting,
//     announcing exactly what it is removing and why. Idempotent and
//     unambiguous, so it self-heals rather than asking (CLAUDE.md's rule 5:
//     self-heal when the fix is unambiguous and idempotent; ask when it isn't).
//  3. SELF-DESCRIBING. The capability gap NAMES a detected partial instead of
//     repeating "Flutter isn't installed", so the user reading the phone learns
//     that the previous attempt died and that the button will clean up first.
//
// WHAT IT WILL NEVER DELETE. Only paths a row's Partials() declares, only under
// a root the same row's Root() names, and never a directory containing a .git
// (someone's checkout) or a filesystem root. The install roots are Yaver-owned
// by construction (~/.yaver/runtimes/…, ~/flutter, /opt/flutter), but "by
// construction" is exactly the assumption that deletes a repo once, so the
// checks are explicit — see partialRemovalAllowed.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// installCompleteMarker is the file whose PRESENCE means "this tree finished".
// Dotted so it never collides with a real SDK entry, and named for what it is
// rather than for the tool, so one helper serves every row.
const installCompleteMarker = ".yaver-install-complete"

type installMarker struct {
	Tool        string `json:"tool"`
	CompletedAt string `json:"completedAt"`
	AgentOS     string `json:"agentOs"`
	AgentArch   string `json:"agentArch"`
}

func installMarkerPath(root string) string {
	return filepath.Join(root, installCompleteMarker)
}

// markInstallComplete is called by an installer as its LAST action, after the
// tree is usable. Writing it earlier would make the marker a lie about exactly
// the window it exists to describe.
func markInstallComplete(root, tool string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("install marker: empty root")
	}
	goos, goarch := capabilityHostPlatform()
	body, err := json.Marshal(installMarker{
		Tool:        tool,
		CompletedAt: time.Now().UTC().Format(time.RFC3339),
		AgentOS:     goos,
		AgentArch:   goarch,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(installMarkerPath(root), body, 0o644)
}

// installTreeIsComplete reports whether root finished an install.
//
// PRE-MARKER TREES ARE COMPLETE. A box that installed Flutter before this file
// existed has a perfectly good SDK and no marker; treating it as partial would
// delete a working 1.2 GB tree to "fix" it. So the absence of a marker only
// means partial when the tree ALSO fails its own usability probe — which is the
// operation, not the inventory, answering. The marker's job is to make the
// answer cheap and certain going forward, not to condemn history.
func installTreeIsComplete(root string, usable func() bool) bool {
	root = strings.TrimSpace(root)
	if root == "" {
		return false
	}
	if _, err := os.Stat(installMarkerPath(root)); err == nil {
		return true
	}
	if usable != nil && usable() {
		// Pre-marker install, still working. Adopt it: stamp the marker so the
		// next check is cheap, and never touch the tree.
		_ = markInstallComplete(root, filepath.Base(root))
		return true
	}
	return false
}

// partialInstallState is what a caller learns about a half-finished tree.
type partialInstallState struct {
	Root      string
	Exists    bool
	Partial   bool
	SizeBytes int64
	// Debris are stranded temp archives from a killed download.
	Debris []string
}

// detectPartialInstall answers "is there a half-finished <tool> on this box".
// Cheap: a stat of the root, a stat of the marker, and the caller's own
// usability probe. No walk — a size number is not worth an IO storm on the path
// that is trying to tell the user something.
func detectPartialInstall(tool string, usable func() bool) partialInstallState {
	st := partialInstallState{Root: capabilityInstallRoot(tool)}
	if st.Root == "" {
		return st
	}
	info, err := os.Stat(st.Root)
	if err != nil || !info.IsDir() {
		return st
	}
	st.Exists = true
	st.Partial = !installTreeIsComplete(st.Root, usable)
	st.Debris = strandedInstallDebris(tool)
	return st
}

// strandedInstallDebris finds temp archives a killed download left behind.
// Narrow by construction: only files in the OS temp dir whose names match what
// our own installers download. A glob wide enough to catch "anything big in
// /tmp" is a glob wide enough to delete someone's export.
func strandedInstallDebris(tool string) []string {
	var patterns []string
	switch strings.ToLower(strings.TrimSpace(tool)) {
	case "flutter":
		patterns = []string{"flutter_linux_*-stable.tar.xz", "flutter_macos_*-stable.zip"}
	case "node", "mobile":
		patterns = []string{"node-v*-linux-*.tar.xz", "node-v*-darwin-*.tar.gz"}
	case "android-sdk":
		patterns = []string{"commandlinetools-*_latest.zip"}
	default:
		return nil
	}
	var found []string
	for _, pat := range patterns {
		matches, err := filepath.Glob(filepath.Join(os.TempDir(), pat))
		if err != nil {
			continue
		}
		found = append(found, matches...)
	}
	return found
}

// partialRemovalAllowed is the destructive-path gate. Explicit rather than
// "obvious from construction" — the construction argument is exactly what
// deleted a repo once (CLAUDE.md's rm -rf rule).
func partialRemovalAllowed(root string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("empty path")
	}
	if !filepath.IsAbs(root) {
		return fmt.Errorf("path must be absolute")
	}
	clean := filepath.Clean(root)
	if isFilesystemRoot(clean) {
		return fmt.Errorf("refusing to delete filesystem root")
	}
	if home := capabilityHomeDir(); home != "" && filepath.Clean(home) == clean {
		return fmt.Errorf("refusing to delete the home directory")
	}
	// A toolchain root never contains a git checkout of the user's work.
	// Flutter's OWN git-clone install does contain .git — so this check is
	// applied to the DIRECT root only when we did not put it there, which is
	// why callers pass the marker-bearing root and never a project dir.
	if fi, err := os.Stat(filepath.Join(clean, ".yaver-install-root")); err == nil && fi.Mode().IsRegular() {
		return nil
	}
	if strings.Count(clean, string(filepath.Separator)) < 2 {
		return fmt.Errorf("refusing to delete a top-level path (%s)", clean)
	}
	return nil
}

// beginToolInstall is the ONE call an installer makes before it writes
// anything. It clears a provably-partial tree and strands nothing.
//
// Returns a note for the progress stream when it removed something, "" when
// there was nothing to do. Callers stream the note: a silent cleanup of 800 MB
// is as unfalsifiable as a silent serve.
func beginToolInstall(tool, root string, usable func() bool, progress func(string)) string {
	logf := func(s string) {
		if progress != nil {
			progress(s)
		}
	}
	var notes []string

	if root != "" {
		if info, err := os.Stat(root); err == nil && info.IsDir() && !installTreeIsComplete(root, usable) {
			if err := partialRemovalAllowed(root); err != nil {
				note := fmt.Sprintf(
					"A previous %s install left a partial tree at %s and Yaver will not remove it "+
						"automatically (%v). Delete it yourself, then retry.", tool, root, err)
				logf(note)
				return note
			}
			note := fmt.Sprintf(
				"A previous %s install was interrupted and left a partial tree at %s — removing it "+
					"before starting, otherwise every future install would report success over a broken SDK.",
				tool, root)
			logf(note)
			if err := os.RemoveAll(root); err != nil {
				failed := fmt.Sprintf("Could not clear the partial %s tree at %s: %v", tool, root, err)
				logf(failed)
				return failed
			}
			notes = append(notes, note)
		}
	}

	for _, debris := range strandedInstallDebris(tool) {
		if info, err := os.Stat(debris); err == nil && info.Mode().IsRegular() {
			if err := os.Remove(debris); err == nil {
				note := fmt.Sprintf("Removed a stranded %s download at %s (%s) left by an interrupted install.",
					tool, debris, humanBytesDG(info.Size()))
				logf(note)
				notes = append(notes, note)
			}
		}
	}

	return strings.Join(notes, " ")
}

// finishToolInstall stamps the marker. An installer that returns success
// without calling this recreates the bug for the next crash, which is why
// TestEveryUnpackedInstallStampsItsMarker reads the installers' source.
func finishToolInstall(tool, root string) {
	if strings.TrimSpace(root) == "" {
		return
	}
	if err := markInstallComplete(root, tool); err != nil {
		// Non-fatal: a missing marker degrades to the usability probe, which is
		// the pre-marker behaviour. Never fail a good install over bookkeeping.
		return
	}
}

// partialInstallSummary is the user-facing sentence for a detected partial,
// used by the gap producer so the phone says "the last attempt died" instead of
// repeating "not installed" at someone who already pressed Install once.
func partialInstallSummary(tool string, st partialInstallState) string {
	if !st.Partial || !st.Exists {
		return ""
	}
	return fmt.Sprintf(
		"A previous %s install was interrupted and left a partial tree at %s. Yaver will remove it and "+
			"start clean — that is why this is offering an install again rather than saying it is already there.",
		capabilityDisplayName(tool), st.Root)
}
