package main

import "unicode/utf8"

// stream_cursor.go — the one place that knows a transcript cursor is measured
// in BYTES.
//
// # THE TWO-UNIT BUG
//
// `GET /tasks/{id}/output?since=<n>` slices `task.Output` — a Go string — at
// offset n. Every client that produces n counts JavaScript string length,
// which is UTF-16 code units:
//
//	mobile/app/(tabs)/tasks.tsx         received += text.length
//	web/lib/taskStreamWithRecovery.ts   received += String(chunk || "").length
//
// The two units agree for ASCII and diverge for everything else. A coding
// runner's transcript is not ASCII — box-drawing frames, "…", arrows and emoji
// arrive constantly — so on real output the client's number is SMALLER than the
// byte length, and it lands somewhere inside a multi-byte rune. Slicing there
// hands the client half a character: `json.Marshal` substitutes U+FFFD, the
// user sees mojibake at the reattach seam, and nothing on any surface reports
// a fault. That is the inventory-says-yes shape — the resume "succeeded".
//
// Two defences, and they are different defences:
//
//  1. `alignToRuneStart` makes a wrong cursor SAFE. Replaying a few bytes the
//     client already holds is recoverable; a broken character is not.
//  2. The agent states the authoritative offset on every frame it sends
//     (httpserver.go, `"offset"`), so a current client never has to derive the
//     one number only the agent can compute. Client-side counting stays as the
//     fallback for older agents — that is what makes this additive.
//
// Defence 2 alone would not be enough: an OLD client keeps sending its UTF-16
// count forever, and the agent has to keep that safe. Defence 1 alone would not
// be enough either: it stops the corruption but leaves the duplicate replay.

// alignToRuneStart clamps `off` into s and moves it BACK to the nearest rune
// boundary. Moving back rather than forward is deliberate: it can only ever
// resend bytes, never skip them, so a miscounting client loses nothing.
func alignToRuneStart(s string, off int) int {
	if off <= 0 {
		return 0
	}
	if off >= len(s) {
		return len(s)
	}
	// A UTF-8 continuation byte is 0b10xxxxxx. Walk back off the middle of a
	// rune; a well-formed string needs at most 3 steps.
	for off > 0 && !utf8.RuneStart(s[off]) {
		off--
	}
	return off
}
