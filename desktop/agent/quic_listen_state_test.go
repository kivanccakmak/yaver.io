package main

// quic_listen_state_test.go — the agent must not advertise a transport it does
// not have.
//
// Measured on ubuntu-4gb-hel1-1, 2026-08-04: `yaver-relay.service` had owned UDP
// 4433 since 27 July, so every agent start logged `bind: address already in use`
// and then heartbeated a quicHost anyway. Six days of `online · SIGNED IN` over
// a direct lane that could not answer — and a wasted connect leg on every phone
// connection before the relay fallback.

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

func resetQUICState(t *testing.T) {
	t.Helper()
	quicStateMu.Lock()
	quicState = quicListenStatus{Listening: true}
	quicStateMu.Unlock()
}

// TestQUICHostSuppressedWhenBindFailed is the whole point: the address stops
// being published the moment the listener is known to be down.
func TestQUICHostSuppressedWhenBindFailed(t *testing.T) {
	resetQUICState(t)

	// Healthy: publish whatever the caller computed.
	if got := quicAdvertisedHost("100.75.123.78"); got != "100.75.123.78" {
		t.Fatalf("healthy listener must publish the host, got %q", got)
	}

	markQUICUnavailable(4433, syscall.EADDRINUSE)
	if got := quicAdvertisedHost("100.75.123.78"); got != "" {
		t.Errorf("quicAdvertisedHost = %q after a failed bind, want empty — publishing a dialable address for a socket that does not exist is the false green this file exists to end", got)
	}
	if QUICListenState().Listening {
		t.Error("state must report not-listening after a bind failure")
	}
	resetQUICState(t)
}

// TestQUICDisabledIsNotAConflict — --no-quic is a deliberate choice, not a
// fault. Rendering a port conflict for it would send the user hunting a process
// that is not there.
func TestQUICDisabledIsNotAConflict(t *testing.T) {
	resetQUICState(t)
	markQUICDisabled(4433)
	st := QUICListenState()
	if st.Listening {
		t.Error("disabled means not listening")
	}
	if strings.Contains(strings.ToLower(st.Reason), "already held") {
		t.Errorf("a deliberate --no-quic must not read as a port conflict: %q", st.Reason)
	}
	if quicAdvertisedHost("1.2.3.4") != "" {
		t.Error("a disabled listener must not advertise a host either")
	}
	resetQUICState(t)
}

// TestQUICBindReasonNamesTheHolderAndProtectsTheRelay — the remedy has to be
// SPECIFIC. "address already in use" sends the reader after a stale agent; on
// the box that produced this incident the holder was yaver-relay, and killing it
// would take the whole relay down for every user of that box.
func TestQUICBindReasonNamesTheHolderAndProtectsTheRelay(t *testing.T) {
	reason := quicBindReason(4433, syscall.EADDRINUSE)
	for _, want := range []string{"4433", "ss -lunp", "yaver-relay", "NOT be killed", "--no-quic"} {
		if !strings.Contains(reason, want) {
			t.Errorf("bind reason must mention %q so the remedy is actionable; got: %s", want, reason)
		}
	}
	// It must also say what still works, or the reader concludes the box is dead.
	if !strings.Contains(strings.ToLower(reason), "relay") {
		t.Error("the reason must say the relay lane still works")
	}

	// A NON-conflict failure must not claim a port conflict.
	other := quicBindReason(4433, errors.New("permission denied"))
	if strings.Contains(other, "already held") {
		t.Errorf("a non-EADDRINUSE failure must not be reported as a conflict: %s", other)
	}
}

// TestQUICConflictLogLinesGiveTheProbe — the startup diagnosis must hand over
// the exact command, in the shape the HTTP port-conflict block already uses.
func TestQUICConflictLogLinesGiveTheProbe(t *testing.T) {
	lines := quicConflictLogLines(4433, syscall.EADDRINUSE)
	if len(lines) < 2 {
		t.Fatalf("a conflict deserves more than one line, got %d", len(lines))
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "ss -lunp") {
		t.Error("the diagnosis must include the probe that finds the holder")
	}
	if !strings.Contains(joined, "NOT advertise") {
		t.Error("the diagnosis must state that the address is being withheld — otherwise the operator sees an empty quicHost later and hunts a second bug")
	}

	// A clean error produces no conflict-specific advice.
	if len(quicConflictLogLines(4433, errors.New("nope"))) != 1 {
		t.Error("a non-conflict failure must not print conflict advice")
	}
}
