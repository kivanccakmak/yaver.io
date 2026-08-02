package main

// project_preview_capabilities_http.go — GET /project/preview-capabilities
//
// The capability answer already existed behind the `ops` grand-tool
// (ops_project_preview_options.go), which is reachable from MCP but not from a
// surface that just wants to ask a question over plain HTTP. Attach Mode needs
// exactly that: "is this directory Yaver's own checkout?", answered by the
// AGENT from the project's declared identity rather than by the phone guessing
// from a path string.
//
// Same detection, same struct, one more door. Adding a second implementation
// here would be the drift this repo keeps paying for, so this handler does
// nothing but call DetectProjectPreviewCapabilities.

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// previewCapabilityProbeBudget bounds the optional probe pass.
//
// Probing STARTS a browser and shells out to toolchains, so it cannot be
// unbounded on a request path. On timeout the static verdict stands — an
// unknown answer must never be reported as "your box cannot do this".
const previewCapabilityProbeBudget = 12 * time.Second

func (s *HTTPServer) handleProjectPreviewCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	workDir := strings.TrimSpace(r.URL.Query().Get("workDir"))
	if workDir == "" {
		jsonError(w, http.StatusBadRequest, "workDir is required")
		return
	}

	framework := strings.TrimSpace(r.URL.Query().Get("framework"))
	hasPaired := r.URL.Query().Get("hasPairedDevice") == "true"
	caps := DetectProjectPreviewCapabilities(workDir, framework, hasPaired)

	// ?probe=true asks what this box can ACTUALLY run, not just what the stack
	// supports. Opt-in because it is slow: the fast answer stays the default so
	// a caller that only wants `selfDevelopment` (Attach Mode's verification)
	// is never made to wait behind a browser launch.
	if r.URL.Query().Get("probe") == "true" {
		ctx, cancel := context.WithTimeout(r.Context(), previewCapabilityProbeBudget)
		defer cancel()
		caps = RefineProjectPreviewCapabilitiesWithProbes(ctx, caps, workDir)
	}

	writeJSON(w, http.StatusOK, caps)
}
