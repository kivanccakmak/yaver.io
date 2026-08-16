package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// THE CURSOR HAS TWO UNITS AND ONLY ONE OF THEM IS TRUE.
//
// `?since=<n>` is sliced as a BYTE offset into a Go string
// (httpserver.go: `existingOutput[since:]`). Every client that produces that
// number counts JavaScript string length instead — UTF-16 code units:
//
//	mobile/app/(tabs)/tasks.tsx   `received += text.length`
//	web/lib/taskStreamWithRecovery.ts `received += String(chunk || "").length`
//
// For pure ASCII the two agree, which is why every test in
// httpserver_task_output_resume_test.go passes: "AAAABBBB", "SHORT". Real
// transcripts are not ASCII — a claude/codex TUI emits box-drawing runes, "…"
// and emoji constantly — and there the client's count is SMALLER than the byte
// length. Two failures follow, neither of which any surface can see:
//
//  1. `since` lands short of the true position, so the agent replays bytes the
//     client already holds. That is duplicated scrollback: the exact defect
//     `?since=` was built to remove, reappearing only for non-English output.
//  2. `since` lands INSIDE a multi-byte rune, so `existingOutput[since:]` cuts
//     a character in half and ships invalid UTF-8. `json.Marshal` replaces the
//     broken bytes with U+FFFD, so the user gets mojibake at the seam and
//     nothing anywhere reports a problem.
//
// The per-chunk trim at `maxStreamChunkBytes` has the same rune-cutting bug,
// AND it injects a "[chunk trimmed: N bytes more in Logs]" marker that is not
// part of task.Output — so a client counting what it received drifts from the
// agent's real offset by the marker length on EVERY trimmed chunk, and never
// recovers.
//
// The fix is to stop asking the client to derive a number only the agent can
// know: the agent states the authoritative byte offset on every frame it
// sends, and clamps every slice to a rune boundary. Counting on the client is
// then a fallback for old agents, not the contract.

// multibyte is deliberately the kind of text a coding runner actually emits.
const multibyteHead = "┌─ build ─┐\n" // 3-byte runes
const multibyteTail = "└─ done ─┘\n"

func sseFrames(t *testing.T, raw string) []map[string]interface{} {
	t.Helper()
	var out []map[string]interface{}
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m); err != nil {
			t.Fatalf("unparseable SSE frame %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestResumeNeverSplitsARuneEvenWhenTheClientMiscounts(t *testing.T) {
	full := multibyteHead + multibyteTail

	// Sweep EVERY offset rather than one hand-picked number. The client's count
	// is derived from a different unit than the agent's slice, so in practice it
	// can be any value — and picking one by hand is how this stays green by
	// luck: a first draft of this test used len([]rune(head)), which happened to
	// land exactly on a rune boundary and passed with the alignment removed.
	// The honest contract is "no value of `since` may produce a broken rune".
	for since := 1; since < len(full); since++ {
		ts, _ := newResumeTestServer(t, full, TaskStatusFinished)
		raw := readStream(t, ts.URL+"?since="+strconv.Itoa(since))

		for _, f := range sseFrames(t, raw) {
			text, _ := f["text"].(string)
			if text == "" {
				continue
			}
			if !utf8.ValidString(text) {
				t.Fatalf("since=%d: replay shipped invalid UTF-8 — mojibake at the seam: %q", since, text)
			}
			if strings.ContainsRune(text, '�') {
				t.Fatalf("since=%d: replay sliced mid-rune; U+FFFD reached the client: %q", since, text)
			}
		}
	}
}

func TestEveryOutputFrameStatesTheAuthoritativeByteOffset(t *testing.T) {
	// The agent already tells a resuming client the true offset. It must say
	// so on the OUTPUT frames too, otherwise the client is forced back to
	// counting the one number it cannot compute correctly.
	full := multibyteHead + multibyteTail
	ts, _ := newResumeTestServer(t, full, TaskStatusFinished)

	raw := readStream(t, ts.URL+"?since=0")

	sawOutput := false
	for _, f := range sseFrames(t, raw) {
		if f["type"] != "output" {
			continue
		}
		sawOutput = true
		off, ok := f["offset"].(float64)
		if !ok {
			t.Fatalf("output frame carries no offset — the client must guess it: %v", f)
		}
		if int(off) != len(full) {
			t.Fatalf("offset %d is not the transcript's byte length %d — a client adopting it would desync", int(off), len(full))
		}
	}
	if !sawOutput {
		t.Fatal("no output frame at all")
	}
}
