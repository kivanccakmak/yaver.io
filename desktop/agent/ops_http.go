package main

// ops_http.go — HTTP surfaces for the unified verb API.
//
//   POST /ops        — dispatch a single verb on this (or a routed) machine
//   POST /ops/plan   — resolve machine/project/access plan without executing
//   GET  /ops/verbs  — list every registered verb with its payload schema
//
// Both routes are owner-authed at registration time (auth() middleware in
// registerRoutes). Non-owner callers (guests / support bearers) hit the
// dispatcher through the same path but with a different caller role
// flag, which lets each verb decide whether to honour the call.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
)

// mcpOps dispatches one ops verb from an MCP tool handler and returns the raw
// result for mcpToolJSON.
//
// Callers reaching the MCP dispatch have already cleared the owner-auth
// boundary upstream (auth() on /mcp); guests and support sessions use their own
// scoped routes, never /mcp. That is why Caller is "owner" here — the same
// reasoning, and the same construction, the `ops` grand-tool uses for its own
// dispatch in handleMCPToolCallWithAddr.
func (s *HTTPServer) mcpOps(machine, verb string, payload json.RawMessage) OpsResult {
	octx := OpsContext{Ctx: context.Background(), Server: s, Caller: "owner"}
	return dispatchOps(octx, OpsRequest{Machine: machine, Verb: verb, Payload: payload})
}

// opsCallIsRemote reports whether this /ops call originates from another machine
// — relay-bridged (X-Yaver-Via-Relay), proxied by another agent
// (X-Yaver-Proxied-By), or a non-loopback peer. A same-machine owner MCP call is
// loopback + unproxied.
func opsCallIsRemote(r *http.Request) bool {
	if isRelayBridged(r) {
		return true
	}
	if strings.TrimSpace(r.Header.Get("X-Yaver-Proxied-By")) != "" {
		return true
	}
	return !isLoopbackAddr(r.RemoteAddr)
}

// opsVerbIsLocalOnlySecret lists verbs that read/write LOCAL secrets and must
// never run for a caller on another machine (REMOTE_WORKER.md: "secrets never
// cross machines"). SECURITY (audit 2026-07-13): the client-side layer4Tools
// denylist keyed on tool names that don't exist at runtime — ops verbs proxy as
// "ops:<verb>", so ops:secrets / ops:env / ops:runner_auth slipped through and a
// same-user remote worker could exfiltrate the owner's vault/env plaintext. This
// holder-side gate cannot be bypassed by a hostile box.
func opsVerbIsLocalOnlySecret(verb string) bool {
	switch strings.TrimSpace(verb) {
	case "secrets", "env", "runner_auth":
		return true
	}
	return false
}

// opsUnknownTopLevelKeys names the top-level request keys /ops does not know.
//
// WHY THIS EXISTS. `json.Decode` into OpsRequest silently DROPS unknown keys, so
// a caller that wraps its arguments under the wrong name — `args`, `arguments`,
// `input`, `params` are all natural guesses — sends a request with no `payload`
// at all. The verb then sees an empty struct and answers with whatever its own
// required-field check says, e.g. desktop_voice's "`transcript` is required".
//
// That reply is TRUE about the payload and FALSE about the request: the caller
// DID send a transcript, and is now told it is missing. Measured 2026-08-05
// against the real box while writing the watch arc — the payload was
// `{"verb":"desktop_voice","args":{"transcript":"…"}}` and the answer named the
// one field that had actually been supplied. Nothing in the reply pointed at the
// wrapper, which is the only thing that was wrong.
//
// This is the four-layer rule at the SIGNAL layer: the agent already HAS the
// information (it saw the `args` key and threw it away), so the fix is to carry
// it, not to make every client author rediscover it. Naming the ignored keys and
// the expected one turns a debugging session into one round trip.
func opsUnknownTopLevelKeys(raw []byte) []string {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil // not an object; the typed decode already reported it
	}
	var unknown []string
	for k := range probe {
		switch k {
		case "machine", "verb", "payload":
		default:
			unknown = append(unknown, k)
		}
	}
	sort.Strings(unknown) // stable message for tests and for humans diffing logs
	return unknown
}

// opsRejectMisnamedPayload returns a refusal when the request carries NO
// `payload` but DOES carry unknown top-level keys — the misnamed-wrapper shape.
//
// Deliberately narrow. A request with a valid `payload` plus stray keys is
// forwarded untouched (a newer client may send fields this build predates), and
// a request with neither is a genuine no-argument call, which many verbs accept.
// Only the combination is diagnosable, and only then does this speak.
func opsRejectMisnamedPayload(req OpsRequest, raw []byte) *OpsResult {
	if len(req.Payload) > 0 {
		return nil
	}
	unknown := opsUnknownTopLevelKeys(raw)
	if len(unknown) == 0 {
		return nil
	}
	return &OpsResult{
		OK:   false,
		Code: "bad_payload",
		Error: "verb arguments go under `payload`; this request had no `payload` and I ignored these top-level keys: " +
			strings.Join(unknown, ", ") + ". Resend as {\"verb\":\"" + req.Verb + "\",\"payload\":{…}}.",
		Initial: map[string]interface{}{
			"ignoredKeys": unknown,
			"expectedKey": "payload",
		},
	}
}

func (s *HTTPServer) handleOps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, `{"error":"could not read request body"}`, http.StatusBadRequest)
		return
	}
	var req OpsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	// Say "your arguments were under the wrong key" instead of letting the verb
	// report the field it never received. See opsRejectMisnamedPayload.
	if bad := opsRejectMisnamedPayload(req, raw); bad != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(*bad)
		return
	}
	if opsVerbIsLocalOnlySecret(req.Verb) && opsCallIsRemote(r) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(OpsResult{
			OK:    false,
			Code:  "local_only",
			Error: "verb is local-only; secrets never cross machines",
		})
		return
	}
	// Derive caller role from the middleware-set headers. Auth is
	// already enforced upstream — this is only about telling the
	// dispatcher whether to honour guest-scoped verbs.
	caller, callerScope := opsCallerFromRequest(r)

	octx := OpsContext{
		Ctx:            r.Context(),
		Server:         s,
		RequestHeaders: r.Header.Clone(),
		ActorUserID:    strings.TrimSpace(r.Header.Get("X-Yaver-GuestUserID")),
		Caller:         caller,
		Scope:          callerScope,
	}
	out := dispatchOps(octx, req)

	w.Header().Set("Content-Type", "application/json")
	// Even typed errors (unknown_verb, unauthorized, bad_payload) are
	// returned as HTTP 200 with `ok:false, code, error`. Agents treat
	// the structured body as authoritative; HTTP 4xx/5xx is reserved
	// for transport-level failures (malformed JSON, method wrong).
	_ = json.NewEncoder(w).Encode(out)
}

func (s *HTTPServer) handleOpsPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, `{"error":"could not read request body"}`, http.StatusBadRequest)
		return
	}
	var req OpsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	// /ops/plan answers the same question about the same request shape, so it
	// must not stay silent where /ops now speaks.
	if bad := opsRejectMisnamedPayload(req, raw); bad != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(*bad)
		return
	}
	caller, callerScope := opsCallerFromRequest(r)
	octx := OpsContext{
		Ctx:            r.Context(),
		Server:         s,
		RequestHeaders: r.Header.Clone(),
		ActorUserID:    strings.TrimSpace(r.Header.Get("X-Yaver-GuestUserID")),
		Caller:         caller,
		Scope:          callerScope,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(buildOpsExecutionPlan(octx, req))
}

func (s *HTTPServer) handleOpsVerbs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	verbs := listOpsVerbs()
	out := make([]map[string]interface{}, 0, len(verbs))
	for _, v := range verbs {
		out = append(out, map[string]interface{}{
			"name":        v.Name,
			"description": v.Description,
			"streaming":   v.Streaming,
			"allowGuest":  v.AllowGuest,
			"payload":     v.Schema,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    true,
		"count": len(out),
		"verbs": out,
	})
}

// opsCallerFromRequest derives the caller role and scope from the
// MIDDLEWARE-SET headers. Auth is already enforced upstream; this only tells
// the dispatcher whether to honour guest-scoped verbs.
//
// SECURITY (audit 2026-07-28): this logic existed TWICE, verbatim, in this file
// — and neither copy knew about companion sessions. A tvOS/watch/vision token
// reaches /ops legitimately (companionSessionAllowed admits POST /ops for the
// watch voice lane) but carries none of the guest/support/host-share headers,
// so both copies fell through to caller="owner". ops.go restricts only
// caller=="guest", so a stolen TV token reached the `run` verb and executed
// commands — while httpserver.go promised in a comment that "a stolen TV token
// can … not run commands".
//
// One function now, so the next surface added here cannot inherit only half the
// rules. Companion sessions are treated as guests carrying the companion scope,
// reusing the existing tested guestVerbAllowed gate instead of a second
// parallel one: a companion verb that genuinely needs to work must be marked
// allowed for that scope explicitly, which is the audit trail we want.
func opsCallerFromRequest(r *http.Request) (caller string, scope string) {
	scope = strings.TrimSpace(r.Header.Get("X-Yaver-GuestScope"))
	switch {
	case r.Header.Get("X-Yaver-Support") == "true":
		return "support", scope
	case r.Header.Get("X-Yaver-HostShare") == "true":
		return "host-share", scope
	case r.Header.Get("X-Yaver-Guest") == "true":
		return "guest", scope
	}
	// X-Yaver-SessionScope is stamped by the auth middleware AFTER Convex
	// validated it, and the inbound copy is stripped, so it cannot be forged.
	if sess := strings.TrimSpace(r.Header.Get("X-Yaver-SessionScope")); isCompanionSessionScope(sess) {
		return "guest", sess
	}
	return "owner", scope
}
