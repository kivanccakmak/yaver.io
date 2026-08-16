package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The yaver-tmp class must take only trees whose NEWEST file is stale. A tree
// with one fresh file deep inside is a live session's scratch — deleting it
// mid-preview is a worse failure than a week of parked bytes.
func TestDiskGuardYaverTempSparesLiveTrees(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	old := time.Now().Add(-14 * 24 * time.Hour)

	stale := filepath.Join(tmp, "yaver-expo-web-stale")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "bundle.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(stale, "bundle.js"), stale} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}

	// Root dir LOOKS old (old mtime) but holds a fresh file — must be spared.
	live := filepath.Join(tmp, "yaver-expo-web-live", "assets")
	if err := os.MkdirAll(live, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "fresh.js"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(tmp, "yaver-expo-web-live"), old, old); err != nil {
		t.Fatal(err)
	}

	// Non-yaver entries are never candidates, stale or not.
	other := filepath.Join(tmp, "someone-elses-dir")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, old, old); err != nil {
		t.Fatal(err)
	}

	cands, err := diskGuardCollectYaverTemp()
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 {
		t.Fatalf("want exactly the stale yaver tree, got %d candidates: %+v", len(cands), cands)
	}
	if !strings.HasSuffix(cands[0].Path, "yaver-expo-web-stale") {
		t.Fatalf("wrong candidate: %s", cands[0].Path)
	}
}

// The journald mirror must survive the file logger's death — a full disk kills
// the file writer, and that is exactly the run whose trace matters. If someone
// re-couples the mirror to file health, this fails.
func TestDiagJournalMirrorSurvivesDisabledFile(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	origStderr := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = origStderr }()

	d := &diagLogger{disabled: true, journal: true, journalMin: diagInfo}
	d.logf(diagWarn, "task", "poll answered %d", 502)
	d.logf(diagDebug, "connect", "debug noise must not reach the journal")
	_ = w.Close()

	buf := make([]byte, 4096)
	n, _ := r.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, "poll answered 502") || !strings.Contains(got, "[task]") {
		t.Fatalf("WARN line did not reach the journal mirror: %q", got)
	}
	if strings.Contains(got, "debug noise") {
		t.Fatalf("DEBUG leaked past journalMin into the journal: %q", got)
	}
}
