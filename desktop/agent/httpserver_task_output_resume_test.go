package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A task SSE stream that is cut mid-render (relay bounce, box drop,
// backgrounded phone) used to be unrecoverable in practice: the agent
// replayed the ENTIRE accumulated transcript on every re-subscribe, so a
// client that reconnected either duplicated everything it already had or
// had to throw its scrollback away. Both are why no surface ever
// reconnected — the recovery existed on the wire and cost the user their
// output, so every client stayed frozen on the last frame instead.
//
// `?since=<bytes>` makes the reattach lossless and duplicate-free, and the
// `resume` frame tells the client deterministically whether what follows
// is an increment or a full snapshot. Without that frame the client is
// back to guessing, which is the defect this fixes.
func newResumeTestServer(t *testing.T, output string, status TaskStatus) (*httptest.Server, *Task) {
	t.Helper()
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	task := &Task{
		ID:       "resume-1",
		Title:    "Resume me",
		Status:   status,
		Output:   output,
		outputCh: make(chan string, 1),
		doneCh:   make(chan struct{}),
	}
	tm.mu.Lock()
	tm.tasks[task.ID] = task
	tm.mu.Unlock()

	srv := &HTTPServer{taskMgr: tm}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv.streamOutput(w, r, task.ID)
	}))
	t.Cleanup(ts.Close)
	return ts, task
}

func readStream(t *testing.T, url string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open SSE: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

func TestTaskOutputResumeReplaysOnlyTheRemainder(t *testing.T) {
	// The client already holds "AAAA" (4 bytes) and reconnects.
	ts, _ := newResumeTestServer(t, "AAAABBBB", TaskStatusFinished)

	text := readStream(t, ts.URL+"?since=4")

	if strings.Contains(text, "AAAA") {
		t.Fatalf("resume re-sent bytes the client already had — transcript would duplicate:\n%s", text)
	}
	if !strings.Contains(text, "BBBB") {
		t.Fatalf("resume dropped the remainder the client is missing:\n%s", text)
	}
	if !strings.Contains(text, `"type":"resume"`) {
		t.Fatalf("no resume frame — client cannot tell increment from snapshot:\n%s", text)
	}
	if !strings.Contains(text, `"full":false`) {
		t.Fatalf("resume frame must mark an incremental replay as full:false:\n%s", text)
	}
}

func TestTaskOutputResumeCaughtUpClientGetsNoReplay(t *testing.T) {
	ts, _ := newResumeTestServer(t, "AAAABBBB", TaskStatusFinished)

	text := readStream(t, ts.URL+"?since=8")

	if strings.Contains(text, `"type":"output"`) {
		t.Fatalf("caught-up client got a redundant output replay:\n%s", text)
	}
	if !strings.Contains(text, `"type":"done"`) {
		t.Fatalf("terminal task must still report done on reattach:\n%s", text)
	}
}

func TestTaskOutputResumeBeyondEndFallsBackToFullSnapshot(t *testing.T) {
	// The box restarted / the task was re-created and its Output is now
	// SHORTER than what the client holds. Silently replaying nothing would
	// strand the client on stale bytes forever; the honest answer is a full
	// snapshot, explicitly marked so the client replaces instead of appends.
	ts, _ := newResumeTestServer(t, "SHORT", TaskStatusFinished)

	text := readStream(t, ts.URL+"?since=999")

	if !strings.Contains(text, "SHORT") {
		t.Fatalf("out-of-range resume must fall back to a full snapshot:\n%s", text)
	}
	if !strings.Contains(text, `"full":true`) {
		t.Fatalf("a full snapshot must be marked full:true so the client replaces:\n%s", text)
	}
}

func TestTaskOutputWithoutSinceIsUnchanged(t *testing.T) {
	// Additive-only: the initial subscribe every existing client already
	// makes must behave exactly as before, with no resume frame at all.
	ts, _ := newResumeTestServer(t, "AAAABBBB", TaskStatusFinished)

	text := readStream(t, ts.URL)

	if strings.Contains(text, `"type":"resume"`) {
		t.Fatalf("a subscribe without ?since must not emit a resume frame:\n%s", text)
	}
	if !strings.Contains(text, "AAAABBBB") {
		t.Fatalf("plain subscribe lost its full replay:\n%s", text)
	}
}
