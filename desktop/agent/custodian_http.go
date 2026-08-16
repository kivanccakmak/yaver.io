package main

// custodian_http.go — the housekeeping feed, exposed so every surface can show
// it. A janitor nobody can see is indistinguishable from no janitor: this file is
// the half of the custodian that makes the other half count.
//
//	GET /custodian/status    snapshot: wardens, recent findings, counts
//	GET /custodian/events    SSE: live findings as they happen
//	GET /custodian/playbook  the failure→remedy table, so a user can audit what
//	                         Yaver will do automatically BEFORE it does it
//	POST /custodian/sweep    run every warden now (the "why is my machine full?"
//	                         button — an answer on demand, not on a 5-minute tick)

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

func (s *HTTPServer) handleCustodianStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, agentCustodian.Snapshot())
}

// handleCustodianPlaybook publishes the lookup table. Deliberately readable by
// any authenticated client: "what will this thing do to my machine without
// asking" must be answerable without reading Go.
func (s *HTTPServer) handleCustodianPlaybook(w http.ResponseWriter, r *http.Request) {
	entries := PlaybookCatalog()
	auto := 0
	for _, e := range entries {
		if e.AutoApply {
			auto++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries":   entries,
		"total":     len(entries),
		"automatic": auto,
		"note":      "automatic entries are unambiguous, idempotent and local to this machine; the rest name their remedy and wait for you",
	})
}

// handleCustodianSweep runs every warden immediately and returns what they found.
// Synchronous on purpose: the caller pressed a button and is waiting for an
// answer, and a sweep that returns "started" teaches the user nothing.
func (s *HTTPServer) handleCustodianSweep(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	agentCustodian.mu.RLock()
	wardens := append([]Warden(nil), agentCustodian.wardens...)
	agentCustodian.mu.RUnlock()

	findings := []CustodianFinding{}
	for _, wd := range wardens {
		findings = append(findings, agentCustodian.SweepOne(wd, now)...)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"swept":    len(wardens),
		"findings": findings,
		// An empty result is an ANSWER, not a shrug — say it in words the UI can
		// show verbatim, so "nothing was wrong" never renders as a blank panel.
		"summary": summariseSweep(len(wardens), findings),
	})
}

func summariseSweep(wardens int, findings []CustodianFinding) string {
	if len(findings) == 0 {
		return fmt.Sprintf("Checked %d housekeeping areas — nothing needed fixing.", wardens)
	}
	fixed, human := 0, 0
	for _, f := range findings {
		switch f.Outcome {
		case OutcomeFixed:
			fixed++
		case OutcomeNeedsHuman, OutcomeNeedsRunner:
			human++
		}
	}
	msg := fmt.Sprintf("Checked %d areas: fixed %d", wardens, fixed)
	if human > 0 {
		msg += fmt.Sprintf(", %d need you", human)
	}
	return msg + "."
}

// handleCustodianEvents streams findings as SSE. Replays recent history first so
// a client that connects after the interesting thing happened still sees it —
// the same reason the dev-server stream keeps a ring buffer.
func (s *HTTPServer) handleCustodianEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(event string, payload any) bool {
		raw, err := json.Marshal(payload)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Snapshot first: a feed that starts empty looks like a feed that is broken.
	if !send("snapshot", agentCustodian.Snapshot()) {
		return
	}

	ch, cancel := agentCustodian.Subscribe()
	defer cancel()

	// Keep-alive: relays and proxies drop an idle stream, and housekeeping is
	// quiet by design — the healthy case emits nothing for minutes.
	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case f, open := <-ch:
			if !open {
				return
			}
			if !send("finding", f) {
				return
			}
		case <-keepAlive.C:
			if _, err := fmt.Fprintf(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
