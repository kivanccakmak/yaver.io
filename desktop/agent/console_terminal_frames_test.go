package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// These guard the /ws/terminal frame protocol described at the top of
// console_terminal.go. Both directions have already failed in production with
// the SAME frame, so both directions get a test:
//
//   - outbound: the keepalive reply must never appear in the byte stream a
//     client paints into xterm (the `{"pong":1}{"pong":1}` on a user's prompt).
//   - inbound: a keepalive-shaped payload the USER typed must reach the shell,
//     and a control frame must never be typed into it (the `/login {"ping":1…}`).

// dialTestTerminal opens an authenticated /ws/terminal against a throwaway
// agent and returns the connection with the session-meta frame drained.
func dialTestTerminal(t *testing.T) (*websocket.Conn, func()) {
	t.Helper()
	srv := &HTTPServer{token: "owner-token", ownerUserID: "owner-user"}
	server := httptest.NewServer(http.HandlerFunc(srv.auth(srv.handleTerminalWS)))

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/terminal?shell=" + url.QueryEscape("/bin/sh")
	header := http.Header{}
	header.Set("Authorization", "Bearer owner-token")

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		server.Close()
		t.Fatalf("dial /ws/terminal: %v", err)
	}
	return conn, func() {
		_ = conn.Close()
		server.Close()
	}
}

// collectTerminalFrames drains the socket for d, returning the concatenated
// BINARY payload — exactly the bytes a client hands to xterm — and every TEXT
// payload separately.
//
// One deadline for the whole window, and it stops at the first read error:
// gorilla marks a connection permanently failed on ANY read error including a
// deadline expiry, and panics on the next read. So this is called once per
// test, last.
func collectTerminalFrames(t *testing.T, conn *websocket.Conn, d time.Duration) (rendered string, control []string) {
	t.Helper()
	var painted strings.Builder
	_ = conn.SetReadDeadline(time.Now().Add(d))
	for {
		mt, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		switch mt {
		case websocket.BinaryMessage:
			painted.Write(payload)
		case websocket.TextMessage:
			control = append(control, string(payload))
		}
	}
	return painted.String(), control
}

// controlFramesOfType filters collected control frames by their "type", and
// fails the test on any text frame that is not a JSON object — the invariant a
// client relies on to drop text frames without inspecting them.
func controlFramesOfType(t *testing.T, frames []string, kind string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, frame := range frames {
		var probe map[string]any
		if json.Unmarshal([]byte(frame), &probe) != nil {
			t.Fatalf("server sent a non-JSON text frame %q; every server text frame must be JSON control", frame)
		}
		if probe["type"] == kind {
			out = append(out, probe)
		}
	}
	return out
}

// TestTerminalKeepaliveNeverReachesRenderedBytes is the direct guard on the
// reported bug: the user's terminal showed `{"pong":1}{"pong":1}` at the
// prompt because the keepalive reply shared the data channel.
func TestTerminalKeepaliveNeverReachesRenderedBytes(t *testing.T) {
	conn, cleanup := dialTestTerminal(t)
	defer cleanup()

	// Two keepalives, exactly as the web terminal's 30s timer sends them —
	// two is what the user's screenshot had accumulated.
	for i := 0; i < 2; i++ {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"ping":1,"t":1785067684755}`)); err != nil {
			t.Fatalf("write keepalive: %v", err)
		}
	}

	rendered, control := collectTerminalFrames(t, conn, 1500*time.Millisecond)

	// The bytes a client paints must be innocent of the control plane.
	if strings.Contains(rendered, "pong") {
		t.Fatalf("keepalive reply leaked into the rendered PTY byte stream: %q", rendered)
	}
	if strings.Contains(rendered, "ping") {
		t.Fatalf("keepalive was echoed back through the PTY: %q", rendered)
	}

	// ...and the reply must still EXIST, on the control channel. Dropping it
	// would make an idle-but-healthy terminal self-disconnect after 60s.
	pongs := controlFramesOfType(t, control, "pong")
	if len(pongs) != 2 {
		t.Fatalf("got %d pong control frames, want 2 (one per keepalive); frames=%v", len(pongs), control)
	}
	for _, p := range pongs {
		// Legacy field kept for clients that match on it (old TestFlight
		// build, browser tab open since before the deploy).
		if _, ok := p["pong"]; !ok {
			t.Fatalf("pong frame dropped the legacy \"pong\" field: %v", p)
		}
	}
}

// TestTerminalPongIsNeverSentSpontaneously: a client that never pings must
// never receive a pong. The reply is a reply, not a push — that is what keeps
// it harmless for clients that predate this protocol.
func TestTerminalPongIsNeverSentSpontaneously(t *testing.T) {
	conn, cleanup := dialTestTerminal(t)
	defer cleanup()

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo __QUIET__\n")); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	_, control := collectTerminalFrames(t, conn, 1500*time.Millisecond)
	for _, frame := range control {
		if strings.Contains(frame, "pong") {
			t.Fatalf("server pushed a pong to a client that never pinged: %q", frame)
		}
	}
}

// TestTerminalUserTypedControlJSONReachesTheShell: the inbound half. A user
// typing keepalive-shaped JSON at their prompt is ordinary input — a real
// terminal sends keystrokes as BINARY, and binary is stdin, always.
func TestTerminalUserTypedControlJSONReachesTheShell(t *testing.T) {
	conn, cleanup := dialTestTerminal(t)
	defer cleanup()

	// `cat` echoes stdin back verbatim, so the PTY byte stream proves the
	// bytes reached the process — not merely the terminal.
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("cat\n")); err != nil {
		t.Fatalf("start cat: %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(`{"type":"ping"}`+"\n")); err != nil {
		t.Fatalf("type control-shaped text: %v", err)
	}

	rendered, _ := collectTerminalFrames(t, conn, 1500*time.Millisecond)
	if strings.Count(rendered, `{"type":"ping"}`) < 2 {
		// One occurrence is the PTY's own echo; the second is cat writing it
		// back, which only happens if the bytes actually reached the process.
		t.Fatalf("user-typed {\"type\":\"ping\"} was swallowed as control instead of delivered to the shell: %q", rendered)
	}
}

// TestTerminalControlFrameIsNeverTypedIntoThePTY: the 2026-07-26 incident.
// An unrecognised control frame must be dropped, not appended to whatever the
// user was in the middle of typing.
func TestTerminalControlFrameIsNeverTypedIntoThePTY(t *testing.T) {
	conn, cleanup := dialTestTerminal(t)
	defer cleanup()

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("cat\n")); err != nil {
		t.Fatalf("start cat: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	// A frame from a client newer than this agent: valid JSON object, no
	// field this switch knows.
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"keepalive":1,"nonce":"abc"}`)); err != nil {
		t.Fatalf("write unknown control frame: %v", err)
	}
	// A marker AFTER it, so a missing control payload means "dropped" and not
	// "hasn't arrived yet".
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("__MARKER__\n")); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	rendered, _ := collectTerminalFrames(t, conn, 1500*time.Millisecond)
	if !strings.Contains(rendered, "__MARKER__") {
		t.Fatalf("marker never echoed; the PTY is not running as expected: %q", rendered)
	}
	if strings.Contains(rendered, "keepalive") || strings.Contains(rendered, "nonce") {
		t.Fatalf("unknown control frame was typed into the PTY: %q", rendered)
	}
}

// TestTerminalLegacyTextStdinStillReachesTheShell: the support console
// (web/app/support/page.tsx) shipped sending the operator's typed line as a
// TEXT frame. Tightening the control plane must not mute an already-open tab,
// so non-JSON text is still stdin.
func TestTerminalLegacyTextStdinStillReachesTheShell(t *testing.T) {
	conn, cleanup := dialTestTerminal(t)
	defer cleanup()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("echo __LEGACY_TEXT_STDIN__\n")); err != nil {
		t.Fatalf("write legacy text stdin: %v", err)
	}
	rendered, _ := collectTerminalFrames(t, conn, 1500*time.Millisecond)
	if !strings.Contains(rendered, "__LEGACY_TEXT_STDIN__") {
		t.Fatalf("legacy text-frame stdin no longer reaches the shell: %q", rendered)
	}
}

// TestTerminalServerTextFramesAreAlwaysJSONControl locks the invariant a
// client depends on to drop text frames blind: no bare prose on the control
// channel, ever.
func TestTerminalServerTextFramesAreAlwaysJSONControl(t *testing.T) {
	for _, frame := range [][]byte{
		terminalPongFrame(),
		terminalErrorFrame("pty start failed: boom"),
		terminalErrorFrame("terminal session mismatch"),
		terminalControlFrame("sudo_prompt", map[string]any{"prompt": "[sudo] password for x:"}),
		terminalControlFrame("error", map[string]any{"type": "ignored", "error": "e"}),
	} {
		var probe map[string]any
		if err := json.Unmarshal(frame, &probe); err != nil {
			t.Fatalf("control frame %q is not a JSON object: %v", frame, err)
		}
		if _, ok := probe["type"].(string); !ok {
			t.Fatalf(`control frame %q has no string "type"; every client classifier keys on it`, frame)
		}
	}
	// The caller must not be able to overwrite the frame kind via fields.
	var probe map[string]any
	_ = json.Unmarshal(terminalControlFrame("error", map[string]any{"type": "pong"}), &probe)
	if probe["type"] != "error" {
		t.Fatalf(`fields overrode the frame kind: type = %v, want "error"`, probe["type"])
	}
}

func TestTerminalTextFrameIsControlClassification(t *testing.T) {
	control := []string{
		`{"ping":1,"t":1785067684755}`,
		`{"type":"ping"}`,
		`  {"resize":{"cols":80,"rows":24}}`,
		`{}`,
		`{"unknown":true}`,
	}
	for _, s := range control {
		if !terminalTextFrameIsControl([]byte(s)) {
			t.Fatalf("%q should classify as control", s)
		}
	}
	stdin := []string{
		"ls -la\n",
		"echo '{\"type\":\"ping\"}'\n",
		`{not json`,
		`["type","ping"]`,
		"",
		"{",
	}
	for _, s := range stdin {
		if terminalTextFrameIsControl([]byte(s)) {
			t.Fatalf("%q should classify as stdin, not control", s)
		}
	}
}
