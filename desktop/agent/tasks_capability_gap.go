package main

// tasks_capability_gap.go — carry the capability gap on the TASKS wire.
//
// The Tasks lane had no route to any fixer. Both of its failure shapes ended
// in prose:
//
//   • 500 {"ok":false,"error":"failed to create task: runner not ready:
//     claude not found in PATH or common locations"} — httpserver.go, when
//     CreateTaskWithOptions returns a nil task.
//   • 201 {"ok":true,"status":"failed",…} with the reason only inside
//     task.Output, deliberately, so the chat renders a failed bubble rather
//     than a transient banner.
//
// Both are correct decisions about SHAPE and wrong about CONTENT: neither
// carries the `method + path + stream` triple that lets a phone render an
// Install button. `POST /install/claude` has worked the whole time and streams
// to /streams/install:claude — the fixer existed, the route did not. Same
// structural defect as the 2026-07-26 Flutter incident, one lane over.
//
// Additive by construction. The legacy keys are untouched, so every shipped
// client keeps working bit-for-bit; `capabilityGap` is a new key that the
// clients which read it (mobile/src/lib/capabilityGap.ts, web/lib/
// capabilityGap.ts — parity-tested twins) turn into a button.

// taskCreateFailureBody is the body of the 500 a nil-task create failure
// produces. Same {ok,error} shape jsonError writes, plus the route when the
// failure is a missing toolchain.
func taskCreateFailureBody(runnerCommand, errText string) map[string]interface{} {
	body := map[string]interface{}{
		"ok":    false,
		"error": errText,
	}
	if gap := DetectTaskCapabilityGap(runnerCommand, errText); gap != nil {
		body["capabilityGap"] = gap
		// The summary is the sentence a human should read; the raw error stays
		// in `error` for logs and for clients that predate the gap. Never
		// REPLACE the error — a shipped client that shows `error` must not
		// suddenly lose the technical detail it has always shown.
		body["errorSummary"] = gap.Summary
	}
	return body
}

// decorateTaskResponseWithGap adds the route to the 201-with-status-failed
// response. The reason text lives in task.Output (which the chat bubble
// already renders); this adds the tap next to it.
//
// Called with the same output text the bubble shows, so the gap can never
// disagree with the sentence beside it.
func decorateTaskResponseWithGap(resp map[string]interface{}, runnerCommand, outputText string) map[string]interface{} {
	if resp == nil {
		return resp
	}
	if gap := DetectTaskCapabilityGap(runnerCommand, outputText); gap != nil {
		resp["capabilityGap"] = gap
	}
	return resp
}
