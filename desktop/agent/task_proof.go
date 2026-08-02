package main

// task_proof.go — the Task Proof package. When a task runs with
// VideoEnabled (the default-OFF "proof" toggle), completion produces a
// documentary evidence record alongside the demo clip: what was asked,
// what the runner claims, and what actually landed (commit + diff), plus
// the proof video routes. Stored on the box, served P2P — the Convex
// privacy contract forbids any of this leaving the machine.
//
// Claims vs evidence (the recap doctrine, recap.go): ResultText is a
// CLAIM the runner makes; CommitSHA/DiffShortstat and the clip are
// EVIDENCE collected independently. A proof that could not be captured
// is a NAMED failure with a route — never a silent success.
//
// Layout:
//   ~/.yaver/proofs/<taskID>/proof.json    — TaskProof record (0600)
//   ~/.yaver/proofs/<taskID>/summary.md    — deterministic narrative (0600)
// Media stays in the clip store (~/.yaver/vibe-preview/clips/…) and is
// referenced by clip ID only — routes on the wire, never paths.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type TaskProof struct {
	TaskID string `json:"taskId"`
	// Status: capturing (clip still recording) | ready | failed.
	Status       string `json:"status"`
	FailedReason string `json:"failedReason,omitempty"`
	FailedRoute  string `json:"failedRoute,omitempty"`
	// Lane is the capture lane that produced (or failed to produce) the
	// video: browser | sim-ios | sim-android | phone.
	Lane   string `json:"lane,omitempty"`
	ClipID string `json:"clipId,omitempty"`
	// Routes, stamped absolute at serve time. Never filesystem paths.
	VideoURL  string `json:"videoUrl,omitempty"`
	PosterURL string `json:"posterUrl,omitempty"`
	// Evidence — collected from git, independent of the runner's claims.
	CommitSHA     string `json:"commitSha,omitempty"`
	CommitSubject string `json:"commitSubject,omitempty"`
	CommitBranch  string `json:"commitBranch,omitempty"`
	DiffShortstat string `json:"diffShortstat,omitempty"`
	// Narrative (markdown) — deterministic draft, safe without an LLM.
	SummaryMarkdown string  `json:"summaryMarkdown,omitempty"`
	DurationSec     float64 `json:"durationSec,omitempty"`
	CostUSD         float64 `json:"costUsd,omitempty"`
	CreatedAt       string  `json:"createdAt"`
}

func taskProofBaseDir() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "proofs"), nil
}

// taskProofIDSafe rejects anything that could escape the proofs dir.
// Task IDs are 8-char uuid prefixes; be strict anyway.
func taskProofIDSafe(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	return !strings.ContainsAny(id, "/\\.")
}

func taskProofDir(taskID string) (string, error) {
	if !taskProofIDSafe(taskID) {
		return "", fmt.Errorf("invalid task id")
	}
	base, err := taskProofBaseDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, taskID), nil
}

func loadTaskProof(taskID string) (*TaskProof, bool) {
	dir, err := taskProofDir(taskID)
	if err != nil {
		return nil, false
	}
	data, err := os.ReadFile(filepath.Join(dir, "proof.json"))
	if err != nil {
		return nil, false
	}
	var p TaskProof
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, false
	}
	return &p, true
}

func saveTaskProof(p *TaskProof) error {
	dir, err := taskProofDir(p.TaskID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename so a concurrent reader never sees a torn file.
	tmp := filepath.Join(dir, ".proof.json.tmp")
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "proof.json"))
}

// BuildTaskProof is called from OnTaskDone right after
// MaybeRecordTaskSummary (main.go). Self-gating: no toggle → no work.
// Non-blocking beyond quick disk writes; the clip-readiness waiter and
// evidence retry run in a goroutine.
//
// bb may be nil (tests / no SDK sessions); when set, a feedback-linked
// task pushes fix-proof-ready to connected SDK apps once the proof is
// watchable, so a tester who never opens Yaver still gets the proof.
func BuildTaskProof(t *Task, bb *BlackBoxManager) {
	if t == nil || !t.VideoEnabled {
		return
	}
	if t.Status != TaskStatusFinished && t.Status != TaskStatusReview {
		return
	}
	if !taskProofIDSafe(t.ID) {
		return
	}
	if _, exists := loadTaskProof(t.ID); exists {
		return // re-entry (auto-retry, restart) — proof already recorded
	}

	proof := &TaskProof{
		TaskID:    t.ID,
		Lane:      t.VideoSource,
		ClipID:    t.VideoClipID,
		CostUSD:   t.CostUSD,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if t.StartedAt != nil && t.FinishedAt != nil {
		proof.DurationSec = t.FinishedAt.Sub(*t.StartedAt).Seconds()
	}
	if proof.Lane == "" {
		proof.Lane = autoDetectVideoSource(t)
	}

	switch {
	case t.VideoClipID != "":
		if t.VideoStatus == "ready" {
			proof.Status = "ready"
		} else {
			proof.Status = "capturing"
		}
	default:
		// The toggle asked for proof and no clip exists — a NAMED
		// failure, not a quiet downgrade to "done".
		proof.Status = "failed"
		proof.FailedReason = fmt.Sprintf("no demo clip was captured (lane %s)", proof.Lane)
		proof.FailedRoute = "POST /vibing/preview/clip/start"
	}

	proof.SummaryMarkdown = taskProofSummaryMarkdown(t, proof)
	if err := saveTaskProof(proof); err != nil {
		log.Printf("[task-proof] %s: save failed: %v", t.ID, err)
		return
	}
	writeTaskProofSummaryFile(proof)
	if tm := ActiveTaskManager(); tm != nil {
		tm.SetTaskProofState(t.ID, proof.Status)
	}
	emitTaskEvent(t, map[string]interface{}{
		"type":     "task_proof",
		"taskId":   t.ID,
		"status":   proof.Status,
		"proofUrl": "/tasks/" + t.ID + "/proof",
	})
	log.Printf("[task-proof] %s: proof recorded (status=%s lane=%s clip=%s)",
		t.ID, proof.Status, proof.Lane, proof.ClipID)

	go finishTaskProofAsync(t, proof, bb)
}

// finishTaskProofAsync completes the parts of the proof that resolve
// after OnTaskDone returns: the git evidence (autoPushAfterTask commits
// concurrently) and the clip finalization (the recorder muxes for up to
// ~40s). Every wait here is wall-clock bounded.
func finishTaskProofAsync(t *Task, proof *TaskProof, bb *BlackBoxManager) {
	defer func() { _ = recover() }()

	// Evidence: poll the live task for the commit the auto-push hook
	// stamped (task_ensure_clone.go). Bounded at 30s.
	deadline := time.Now().Add(30 * time.Second)
	for proof.CommitSHA == "" && time.Now().Before(deadline) {
		tm := ActiveTaskManager()
		if tm == nil {
			break
		}
		live, ok := tm.GetTask(t.ID)
		if !ok {
			break
		}
		tm.mu.RLock()
		sha, subj, branch, stat := live.CommitSHA, live.CommitSubject, live.CommitBranch, live.DiffShortstat
		tm.mu.RUnlock()
		if sha != "" {
			proof.CommitSHA, proof.CommitSubject, proof.CommitBranch, proof.DiffShortstat = sha, subj, branch, stat
			break
		}
		if strings.TrimSpace(t.AutoPush) == "" {
			break // nothing will ever commit — don't wait
		}
		time.Sleep(2 * time.Second)
	}

	// Clip: wait for the recorder to finalize, bounded at 3 minutes
	// (clip max 30s + mux + poster). The vibe SSE clip_ready event is
	// authoritative for vibe subscribers; task surfaces listen on the
	// TASK event channel, so we mirror readiness there.
	if proof.Status == "capturing" && proof.ClipID != "" {
		clipDeadline := time.Now().Add(3 * time.Minute)
		for time.Now().Before(clipDeadline) {
			status := liveClipStatus(proof.ClipID)
			if status == "ready" {
				proof.Status = "ready"
				break
			}
			if status == "failed" {
				proof.Status = "failed"
				proof.FailedReason = "the demo clip recorder failed to finalize the video"
				proof.FailedRoute = "POST /vibing/preview/clip/start"
				break
			}
			time.Sleep(2 * time.Second)
		}
		if proof.Status == "capturing" {
			proof.Status = "failed"
			proof.FailedReason = "the demo clip recorder never finalized (timed out after 3m)"
			proof.FailedRoute = "POST /vibing/preview/clip/start"
		}
	}

	proof.SummaryMarkdown = taskProofSummaryMarkdown(t, proof)
	if err := saveTaskProof(proof); err != nil {
		log.Printf("[task-proof] %s: finalize save failed: %v", t.ID, err)
	}
	writeTaskProofSummaryFile(proof)
	if tm := ActiveTaskManager(); tm != nil {
		tm.SetTaskProofState(t.ID, proof.Status)
	}
	emitTaskEvent(t, map[string]interface{}{
		"type":     "task_proof",
		"taskId":   t.ID,
		"status":   proof.Status,
		"proofUrl": "/tasks/" + t.ID + "/proof",
	})

	// Feedback-SDK return lane: the tester who filed the bug gets the
	// proof in THEIR app, without opening Yaver. Delivered count logged —
	// zero listeners is a visible fact, not a silent ok (the
	// launch-feedback false green, inverted).
	if bb != nil && strings.TrimSpace(t.FeedbackID) != "" {
		delivered := bb.BroadcastCommand(BlackBoxCommand{
			Command: "fix-proof-ready",
			Data: map[string]interface{}{
				"feedbackId": t.FeedbackID,
				"taskId":     t.ID,
				"status":     proof.Status,
				"proofPath":  "/feedback/" + t.FeedbackID + "/fix-proof",
			},
		})
		log.Printf("[task-proof] %s: fix-proof-ready → %d SDK listener(s) (feedback %s)",
			t.ID, delivered, t.FeedbackID)
	}

	go pruneTaskProofsBestEffort()
	go pruneVibeClipsBestEffort()
}

// liveClipStatus asks the in-process manager first, then falls back to
// the on-disk layout (the recorder may live in a sibling process).
func liveClipStatus(clipID string) string {
	if mgr := ActiveVibePreviewManager(); mgr != nil {
		if clip := mgr.ClipByID(clipID); clip != nil && strings.TrimSpace(clip.Status) != "" {
			return strings.TrimSpace(clip.Status)
		}
	}
	if _, _, ready := findClipOnDisk(clipID); ready {
		return "ready"
	}
	return "recording"
}

func taskProofSummaryMarkdown(t *Task, p *TaskProof) string {
	var b strings.Builder
	title := strings.TrimSpace(t.Title)
	if title == "" {
		title = "Task " + t.ID
	}
	fmt.Fprintf(&b, "## %s\n\n", title)
	if d := strings.TrimSpace(t.Description); d != "" && d != title {
		fmt.Fprintf(&b, "**Asked:** %s\n\n", firstNChars(d, 400))
	}
	if r := strings.TrimSpace(t.ResultText); r != "" {
		fmt.Fprintf(&b, "%s\n\n", firstNChars(r, 800))
	}
	b.WriteString("### Evidence\n\n")
	if p.CommitSHA != "" {
		short := p.CommitSHA
		if len(short) > 10 {
			short = short[:10]
		}
		fmt.Fprintf(&b, "- Commit `%s` — %s", short, p.CommitSubject)
		if p.CommitBranch != "" {
			fmt.Fprintf(&b, " (`%s`)", p.CommitBranch)
		}
		b.WriteString("\n")
		if p.DiffShortstat != "" {
			fmt.Fprintf(&b, "- Diff: %s\n", p.DiffShortstat)
		}
	} else {
		b.WriteString("- No commit recorded for this task (push policy off, or nothing changed)\n")
	}
	switch p.Status {
	case "ready":
		fmt.Fprintf(&b, "- Proof video: recorded via %s lane\n", p.Lane)
	case "capturing":
		fmt.Fprintf(&b, "- Proof video: still finalizing (%s lane)\n", p.Lane)
	default:
		fmt.Fprintf(&b, "- Proof video: **not captured** — %s\n", p.FailedReason)
	}
	if p.DurationSec > 0 {
		fmt.Fprintf(&b, "- Duration: %s", (time.Duration(p.DurationSec) * time.Second).String())
		if p.CostUSD > 0 {
			fmt.Fprintf(&b, " · Cost: $%.2f", p.CostUSD)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func writeTaskProofSummaryFile(p *TaskProof) {
	dir, err := taskProofDir(p.TaskID)
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "summary.md"), []byte(p.SummaryMarkdown), 0600)
}

func firstNChars(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return strings.TrimSpace(s[:n]) + "…"
}

// --- retention -------------------------------------------------------------
//
// Neither the proofs dir nor the clip store had ANY pruning before this
// file (the "cautionary tale" in tasks/recap-ops-and-honesty.md). Both
// prune on success AND failure paths — per-task media otherwise grows
// unbounded once the toggle is popular.

const (
	taskProofKeepCount  = 200
	taskProofKeepDays   = 30
	vibeClipKeepCount   = 60
	vibeClipKeepDays    = 21
	vibeClipKeepTotalMB = 500
)

func pruneTaskProofsBestEffort() {
	defer func() { _ = recover() }()
	base, err := taskProofBaseDir()
	if err != nil {
		return
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	type dirAge struct {
		path string
		mod  time.Time
	}
	var dirs []dirAge
	cutoff := time.Now().AddDate(0, 0, -taskProofKeepDays)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(base, e.Name())
		if info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(p)
			continue
		}
		dirs = append(dirs, dirAge{p, info.ModTime()})
	}
	if len(dirs) <= taskProofKeepCount {
		return
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].mod.After(dirs[j].mod) })
	for _, d := range dirs[taskProofKeepCount:] {
		_ = os.RemoveAll(d.path)
	}
}

func pruneVibeClipsBestEffort() {
	defer func() { _ = recover() }()
	cfg, err := ConfigDir()
	if err != nil {
		return
	}
	root := filepath.Join(cfg, "vibe-preview", "clips")
	type clipFile struct {
		path  string
		mod   time.Time
		bytes int64
	}
	var clips []clipFile
	cutoff := time.Now().AddDate(0, 0, -vibeClipKeepDays)
	projects, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, proj := range projects {
		if !proj.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, proj.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".mp4") {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			clips = append(clips, clipFile{
				path:  filepath.Join(root, proj.Name(), f.Name()),
				mod:   info.ModTime(),
				bytes: info.Size(),
			})
		}
	}
	removeClip := func(mp4 string) {
		_ = os.Remove(mp4)
		_ = os.Remove(strings.TrimSuffix(mp4, ".mp4") + ".poster.jpg")
	}
	sort.Slice(clips, func(i, j int) bool { return clips[i].mod.After(clips[j].mod) })
	var total int64
	kept := 0
	for _, c := range clips {
		if c.mod.Before(cutoff) || kept >= vibeClipKeepCount || total+c.bytes > vibeClipKeepTotalMB<<20 {
			removeClip(c.path)
			continue
		}
		total += c.bytes
		kept++
	}
}
