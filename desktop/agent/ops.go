package main

// ops.go — the unified verb-based API that collapses 744 specialist MCP
// tools into a single `ops(machine, verb, payload)` surface. The
// existing tools keep working; `ops` is additive, aimed at external
// AI agents (Cursor, Claude Desktop, Aider, Codex, Goose) that want to
// learn ONE schema and drive every Yaver capability through it.
//
// Verbs live in individual ops_<verb>.go files and register themselves
// here via registerOpsVerb in their init(). The dispatcher picks the
// handler by name, enforces the machine-routing policy, and returns a
// uniform {ok, streamId?, initial?, error?, code?} shape so the
// caller never has to branch on verb-specific success shapes.
//
// Design invariants (from YAVER_MCP_COVERAGE.md):
//
//   1. One tool, one verb, one payload shape per verb.
//   2. Long-running verbs return a streamId; the agent subscribes to
//      /streams/<streamId> for real-time frames. Short verbs put the
//      result in `initial` and leave streamId empty.
//   3. Typed errors — code is stable for agents to branch on.
//   4. Idempotent by default; destructive verbs accept confirm:true.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// OpsRequest is the single input shape every ops call takes.
type OpsRequest struct {
	// Machine: "local" (this agent), "auto" (project-aware best
	// effort placement), a full deviceId, or an alias such as
	// "primary".
	Machine string `json:"machine"`
	// Verb: name registered via registerOpsVerb.
	Verb string `json:"verb"`
	// Payload: verb-specific JSON; each verb documents its own shape.
	Payload json.RawMessage `json:"payload,omitempty"`
}

// OpsResult is the single return shape. Every verb fills either
// Initial (for sync results) or StreamID (for long-running work) —
// never both and never neither.
type OpsResult struct {
	OK       bool        `json:"ok"`
	StreamID string      `json:"streamId,omitempty"`
	Initial  interface{} `json:"initial,omitempty"`
	Error    string      `json:"error,omitempty"`
	// Stable code for programmatic error branching by agents.
	// Known codes: "unknown_verb", "bad_payload", "unauthorized",
	// "remote_not_implemented", "not_found", "invalid_machine",
	// "slot_busy", "area_owned".
	//
	// "slot_busy" and "area_owned" are RETRYABLE refusals, not failures: a live
	// autorun already owns the slot or the source area, and the same request
	// will succeed once it finishes. Initial carries the holder. See
	// autorun_coordination.go.
	Code string `json:"code,omitempty"`
}

// OpsContext gives a verb handler access to the HTTPServer's helpers
// (auth, task manager, project manager, etc.) without couplig it to
// package-global state. Every verb handler takes this.
type OpsContext struct {
	Ctx            context.Context
	Server         *HTTPServer
	RequestHeaders http.Header
	ActorUserID    string
	// Caller is "owner", "companion", or "capability", derived from
	// server-validated authentication state.
	Caller string
	// Scope is the companion or service capability scope. Empty for owners.
	// Capability scopes (see isCapabilityScope) restrict a service token to ONE verb family —
	// e.g. a "circuit" token can ONLY invoke circuit_* verbs, nothing else.
	Scope string
}

// capabilityScopeVerbPrefix maps a service capability scope to the single verb
// family it unlocks. A token with one of these scopes is an ISOLATED service
// credential: it can reach the named verbs and NOTHING else on the box (no
// exec, no vault, no AI tasks) — even companion-safe verbs are denied. This
// is how Yaver lets an external product (Talos, OCPP) drive one resource (the
// circuit simulator) without exposing the rest of the owner's machine.
var capabilityScopeVerbPrefix = map[string]string{
	"circuit": "circuit_",
}

// isCapabilityScope reports whether a scope is a single-capability service
// credential (allowlist of exactly one verb family).
func isCapabilityScope(scope string) bool {
	_, ok := capabilityScopeVerbPrefix[strings.TrimSpace(scope)]
	return ok
}

// firstCapabilityScope returns the first capability scope present in an SDK
// token's scopes (e.g. "circuit"), or "" if none.
func firstCapabilityScope(scopes []string) string {
	for _, s := range scopes {
		if isCapabilityScope(s) {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// scopedVerbAllowed keeps non-owner credentials narrow. Service capabilities
// can call only their one verb family; companion surfaces may call only verbs
// explicitly exposed to those constrained device sessions.
func scopedVerbAllowed(caller, scope, verb string, spec opsVerbSpec) bool {
	switch caller {
	case "capability":
		prefix, ok := capabilityScopeVerbPrefix[strings.TrimSpace(scope)]
		return ok && strings.HasPrefix(verb, prefix)
	case "companion":
		return spec.AllowCompanion
	default:
		return caller == "owner"
	}
}

// VerbHandler is the contract a verb implementation satisfies.
// Return the result directly; panics are recovered by the dispatcher.
type VerbHandler func(c OpsContext, payload json.RawMessage) OpsResult

type opsVerbSpec struct {
	Name        string
	Description string
	Schema      map[string]interface{} // JSON Schema for Payload
	Handler     VerbHandler
	// Streaming: true when this verb typically returns a streamId.
	// Only affects documentation; handlers always return OpsResult.
	Streaming bool
	// AllowCompanion defaults false. A verb is owner-only unless it is
	// explicitly safe for a signed watch/TV/vision companion session.
	AllowCompanion bool
}

var (
	opsRegistry   = map[string]opsVerbSpec{}
	opsRegistryMu sync.RWMutex
)

// registerOpsVerb is called from a verb file's init(). Double-registration
// panics at startup — drift is louder than silent overwrites.
func registerOpsVerb(spec opsVerbSpec) {
	opsRegistryMu.Lock()
	defer opsRegistryMu.Unlock()
	if spec.Name == "" || spec.Handler == nil {
		panic("ops: verb name and handler required")
	}
	if _, exists := opsRegistry[spec.Name]; exists {
		panic("ops: duplicate verb registration: " + spec.Name)
	}
	opsRegistry[spec.Name] = spec
}

// listOpsVerbs returns the registered verbs sorted by name. Used by
// the `ops_verbs` MCP tool for agent self-discovery.
func listOpsVerbs() []opsVerbSpec {
	opsRegistryMu.RLock()
	defer opsRegistryMu.RUnlock()
	out := make([]opsVerbSpec, 0, len(opsRegistry))
	for _, v := range opsRegistry {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// dispatchOps is the single entry point invoked from the HTTP handler,
// MCP tool dispatch, and the CLI. It resolves the machine, looks up the
// verb, and calls the handler — with a panic recovery so one verb's
// bug can't take the whole agent down.
func dispatchOps(octx OpsContext, req OpsRequest) (res OpsResult) {
	defer func() {
		if r := recover(); r != nil {
			res = OpsResult{OK: false, Code: "internal", Error: fmt.Sprintf("verb %q panicked: %v", req.Verb, r)}
		}
	}()

	machine := req.Machine
	if machine == "" {
		machine = "local"
	}

	// Gate non-owner scoped callers BEFORE any
	// remote routing happens. The previous order (proxy first, gate
	// later) was a confused-deputy: a scoped call to /ops on the local
	// agent would proxy to "primary" with the host's owner token,
	// reaching the destination as caller="owner" and bypassing the
	// companion gate entirely. Look up the spec early and refuse when the
	// scoped credential cannot invoke the verb. The same
	// check still runs at line ~227 for the local-dispatch path so we
	// don't depend on the early exit.
	if octx.Caller == "capability" || octx.Caller == "companion" {
		opsRegistryMu.RLock()
		spec, ok := opsRegistry[req.Verb]
		opsRegistryMu.RUnlock()
		if !ok {
			return OpsResult{
				OK:    false,
				Code:  "unknown_verb",
				Error: fmt.Sprintf("unknown verb %q; call ops_verbs to list available verbs", req.Verb),
			}
		}
		if !scopedVerbAllowed(octx.Caller, octx.Scope, req.Verb, spec) {
			return OpsResult{
				OK:    false,
				Code:  "unauthorized",
				Error: fmt.Sprintf("verb %q is not permitted for this scoped session", req.Verb),
			}
		}
		// Scoped callers cannot use machine aliases that resolve via the owner's
		// own Convex token (machine="primary", machine="auto" when it
		// resolves elsewhere). Force machine="local" so the caller's
		// scope is enforced at the destination it actually called, not
		// at the host's primaryDeviceId. Explicit deviceIds the caller
		// could legitimately reach (their own host's deviceId) still
		// work since machine != "primary" / "auto" stays untouched.
		if machine == "primary" || machine == "auto" {
			machine = "local"
			req.Machine = "local"
		}
	}

	executionPlan := buildOpsExecutionPlan(octx, req)
	autoDecision := autoMachineDecision{}
	if machine == "auto" {
		autoDecision = autoMachineDecision{
			Machine: executionPlan.ResolvedMachine,
			Reason:  executionPlan.SelectionReason,
		}
		machine = autoDecision.Machine
	}

	// Resolve aliases to deviceIds before we decide between local and
	// remote dispatch. "primary" follows userSettings.primaryDeviceId;
	// "local" is always the local dispatcher. Full deviceIds pass
	// through unchanged.
	if machine == "primary" {
		if octx.Server == nil {
			return OpsResult{OK: false, Code: "invalid_machine", Error: "primary alias needs a server context to resolve"}
		}
		resolved, err := resolvePrimaryDeviceID(octx.Ctx, octx.Server)
		if err != nil || resolved == "" {
			return OpsResult{OK: false, Code: "invalid_machine", Error: "no primary device set; run `yaver primary set <deviceId>` first"}
		}
		machine = resolved
	}

	if machine != "local" {
		// Remote routing via the existing peer proxy. Loopback is
		// handled transparently by proxyToDevice — when the caller
		// passes its own deviceId, we get errProxyLocal back and
		// fall through to the local dispatcher. refuseRemoteLayer4
		// blocks sensitive verbs (vault/secrets/session on hosts we
		// don't trust to not log tokens) before the call even fires.
		payloadBytes, _ := json.Marshal(map[string]interface{}{
			"machine": "local",
			"verb":    req.Verb,
			"payload": req.Payload,
		})
		// Forward the ORIGINAL caller's user bearer so the target device
		// validates the real user (not this gateway's token). Empty for
		// MCP/CLI callers → proxyToDeviceAs keeps the legacy gateway-token path.
		userBearer := ""
		if octx.RequestHeaders != nil {
			userBearer = strings.TrimSpace(strings.TrimPrefix(octx.RequestHeaders.Get("Authorization"), "Bearer "))
		}
		status, body, err := proxyToDeviceAs(octx.Ctx, "ops:"+req.Verb, machine, "POST", "/ops", payloadBytes, userBearer)
		if err != nil {
			if errors.Is(err, errProxyLocal) {
				// Caller asked for a machine that resolves to this one —
				// treat as local. Drop through.
				machine = "local"
			} else if errors.Is(err, errLayer4Remote) {
				return OpsResult{
					OK:    false,
					Code:  "unauthorized",
					Error: err.Error(),
				}
			} else {
				return OpsResult{
					OK:    false,
					Code:  "remote_failed",
					Error: err.Error(),
				}
			}
		}
		if machine != "local" {
			if status >= 500 {
				return OpsResult{OK: false, Code: "remote_failed", Error: fmt.Sprintf("peer returned HTTP %d: %s", status, string(body))}
			}
			// Peer already returned an OpsResult-shaped body — forward
			// verbatim so stable codes + streamIds pass through.
			var forwarded OpsResult
			if err := json.Unmarshal(body, &forwarded); err != nil {
				return OpsResult{OK: false, Code: "remote_malformed", Error: "peer returned a non-OpsResult body: " + string(body)}
			}
			return annotateOpsResultMachine(forwarded, autoDecision)
		}
	}

	opsRegistryMu.RLock()
	spec, ok := opsRegistry[req.Verb]
	opsRegistryMu.RUnlock()
	if !ok {
		return OpsResult{
			OK:    false,
			Code:  "unknown_verb",
			Error: fmt.Sprintf("unknown verb %q; call ops_verbs to list available verbs", req.Verb),
		}
	}

	if (octx.Caller == "capability" || octx.Caller == "companion") && !scopedVerbAllowed(octx.Caller, octx.Scope, req.Verb, spec) {
		return OpsResult{
			OK:    false,
			Code:  "unauthorized",
			Error: fmt.Sprintf("verb %q is not permitted for this scoped session", req.Verb),
		}
	}

	return annotateOpsResultMachine(spec.Handler(octx, req.Payload), autoDecision)
}
