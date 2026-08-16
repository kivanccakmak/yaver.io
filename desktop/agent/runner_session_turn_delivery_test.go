package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// POST /runner/session/turn answered `200 {ok:true, sent:"prompt"}` whenever
// `tmux send-keys` exited 0. That proves tmux accepted the keystrokes and
// nothing else — not that the runner received them, and certainly not that the
// Enter submitted anything. A prompt that lands in a pane and then does nothing
// is the most unfalsifiable state in the product: the surface spins forever on
// a response that already claimed success.
//
// These pin that the verdict claims only what a pane diff can PROVE.

func TestUnchangedPaneIsNotReportedAsDelivered(t *testing.T) {
	// Typing into any runner TUI paints the composer. A byte-identical pane
	// after text + Enter + settle is proof the keystrokes never landed.
	verdict, note := classifyPromptDelivery("$ claude\n> ", "$ claude\n> ")
	if verdict != "unconfirmed" {
		t.Fatalf("an unchanged pane must not be reported as delivered, got %q", verdict)
	}
	if note == "" {
		t.Fatal("an unconfirmed delivery must carry a plain-language note")
	}
	if !strings.Contains(note, "not confirmed") {
		t.Fatalf("note must say the delivery is unconfirmed, got %q", note)
	}
	// Re-sending is the obvious user reaction and the dangerous one.
	if !strings.Contains(note, "twice") {
		t.Fatalf("note must warn that re-sending can double-submit, got %q", note)
	}
}

func TestChangedPaneIsObservedNotClaimedSubmitted(t *testing.T) {
	verdict, note := classifyPromptDelivery("$ claude\n> ", "$ claude\n> fix the header")
	if verdict != "observed" {
		t.Fatalf("a changed pane must be reported as observed, got %q", verdict)
	}
	if note != "" {
		t.Fatalf("an observed delivery needs no note, got %q", note)
	}
	// A composer holding UNSUBMITTED text also counts as "changed", so the
	// positive verdict must never claim submission — that would relocate the
	// original lie rather than remove it.
	if strings.Contains(verdict, "submit") {
		t.Fatalf("verdict must not claim submission it cannot prove, got %q", verdict)
	}
}

func TestDeliveryFieldsRideTheWire(t *testing.T) {
	// A verdict the client cannot see is the same defect one layer down.
	body, err := json.Marshal(runnerSessionTurnResponse{
		OK:           true,
		Sent:         "prompt",
		Delivered:    "unconfirmed",
		DeliveryNote: "…",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"delivered"`, `"deliveryNote"`} {
		if !strings.Contains(string(body), key) {
			t.Fatalf("%s missing from the wire payload: %s", key, body)
		}
	}
	// A choice confirms itself by advancing the menu — no verdict, no noise.
	quiet, err := json.Marshal(runnerSessionTurnResponse{OK: true, Sent: "choice"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(quiet), "delivered") {
		t.Fatalf("a choice must not carry a delivery verdict: %s", quiet)
	}
}
