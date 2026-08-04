package main

// quic_listen_state.go — never advertise a transport we failed to bind.
//
// THE INCIDENT (ubuntu-4gb-hel1-1, measured 2026-08-04, ongoing since
// 2026-07-27). That box runs the Yaver agent AND a `yaver-relay` server, and the
// relay owns UDP 4433. So every agent start since 27 July logged
//
//	QUIC server error: listen udp: listen udp 0.0.0.0:4433: bind: address already in use
//
// …into a goroutine, and then carried on exactly as if nothing had happened:
// registered with the relay, heartbeated a `quicHost`, and showed `online ·
// SIGNED IN` on every surface. For six days the box advertised a direct-QUIC
// address for a socket that did not exist.
//
// That is the canonical false green of this codebase — the INVENTORY says yes
// (registered, online, a host to dial) while the OPERATION is impossible — and
// it costs a real connect leg: a phone dials 4433, waits out the timeout, and
// only then falls back to relay, on every single connection.
//
// Two obligations, both discharged here:
//   1. RECORD it, so the heartbeat can stop publishing an address that cannot
//      answer. An empty quicHost is already a supported, normal state (a box
//      behind NAT sends one), and auth.go deliberately re-sends the empty value
//      so Convex clears a stale address — so suppression is the SAFE path, not
//      the risky one.
//   2. NAME it. "address already in use" tells the reader nothing about which
//      process, and the answer on this box is a Yaver component, which nobody
//      would guess. The remedy differs completely from a stale-agent conflict:
//      you do not kill the relay, you run the agent with --no-quic or move the
//      relay's port.

import (
	"fmt"
	"strings"
	"sync"
)

type quicListenStatus struct {
	// Listening is false from the moment a bind fails until the process exits.
	// There is no recovery path in-process: the listener is created once at
	// startup, so a failed bind is permanent for this agent's lifetime and must
	// be reported as such rather than as a transient.
	Listening bool
	Port      int
	Reason    string
}

var (
	quicStateMu sync.RWMutex
	// Default TRUE: the overwhelmingly common case is a healthy listener, and a
	// default of false would suppress a working transport on every box whose
	// startup order differs. Only an observed failure flips it.
	quicState = quicListenStatus{Listening: true}
)

// markQUICUnavailable records a bind failure and the human-readable cause.
func markQUICUnavailable(port int, err error) {
	quicStateMu.Lock()
	defer quicStateMu.Unlock()
	quicState = quicListenStatus{
		Listening: false,
		Port:      port,
		Reason:    quicBindReason(port, err),
	}
}

// markQUICDisabled records that QUIC was switched off deliberately (--no-quic).
// Distinct from a failed bind: nothing is wrong, and no surface should render a
// conflict for it.
func markQUICDisabled(port int) {
	quicStateMu.Lock()
	defer quicStateMu.Unlock()
	quicState = quicListenStatus{
		Listening: false,
		Port:      port,
		Reason:    "QUIC is disabled on this agent (--no-quic). Connections use LAN HTTP or the relay.",
	}
}

// QUICListenState returns the current listener status.
func QUICListenState() quicListenStatus {
	quicStateMu.RLock()
	defer quicStateMu.RUnlock()
	return quicState
}

// quicAdvertisedHost is what the heartbeat should publish as `quicHost`.
//
// Empty when the listener is not up, because publishing a dialable address for
// a socket that does not exist is the lie this file exists to end. Clients treat
// an empty quicHost as "no direct QUIC path", which is exactly true.
func quicAdvertisedHost(actual string) string {
	if QUICListenState().Listening {
		return actual
	}
	return ""
}

// quicBindReason turns "address already in use" into something a reader can act
// on. The generic sentence sends people to hunt a stale agent; on the box that
// produced this incident the holder was `yaver-relay`, which no one would guess
// and which must NOT be killed.
func quicBindReason(port int, err error) string {
	if err == nil {
		return fmt.Sprintf("QUIC listener on UDP :%d is not running.", port)
	}
	if !isAddrInUseErr(err) {
		return fmt.Sprintf("QUIC listener on UDP :%d failed to start: %v. Direct phone connections are unavailable; the relay lane still works.", port, err)
	}
	return fmt.Sprintf(
		"UDP :%d is already held by another process, so this agent has NO direct-QUIC listener — "+
			"phones and tablets must use the relay. Find the holder with `ss -lunp | grep :%d` "+
			"(on a box that also runs a Yaver relay this is usually yaver-relay.service, which must "+
			"NOT be killed — give the relay a different --quic-port, or start the agent with --no-quic "+
			"so it stops advertising a transport it does not have).",
		port, port)
}

// quicConflictLogLines is the startup diagnosis, one line per fact, in the
// shape the HTTP port-conflict block already uses. Returned rather than logged
// so the caller owns ordering and a test can read it.
func quicConflictLogLines(port int, err error) []string {
	reason := quicBindReason(port, err)
	lines := []string{fmt.Sprintf("[quic-conflict] %s", strings.ReplaceAll(reason, " — ", " — "))}
	if isAddrInUseErr(err) {
		lines = append(lines,
			fmt.Sprintf("[quic-conflict] Find it: ss -lunp | grep :%d   (or: lsof -iUDP:%d)", port, port),
			"[quic-conflict] This agent will NOT advertise a direct QUIC address while the bind is failing.",
		)
	}
	return lines
}
