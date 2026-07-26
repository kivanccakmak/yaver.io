package main

// peer_proxy_http.go — /peer/<deviceId>/<path> HTTP handler.
//
// Lets mobile + web clients call any agent endpoint on a paired peer
// machine by forwarding the request through proxyToDevice (which
// already handles relay routing, auth-header signing, and peer-auth
// via the per-user agent token). The main consumers today are:
//
//   GET  /peer/<id>/install/list        — what's installed on that peer
//   POST /peer/<id>/install/<tool>      — install a tool on that peer
//   GET  /peer/<id>/infra/summary       — CPU/RAM/disk/GPU on that peer
//
// But the route is intentionally generic — any endpoint registered on
// the target agent becomes reachable without teaching each callsite
// about relays.

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
)

func (s *HTTPServer) handlePeerProxy(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/peer/")
	if rest == "" {
		jsonError(w, http.StatusBadRequest, "usage: /peer/<deviceId>/<path>")
		return
	}
	deviceID, tail, found := strings.Cut(rest, "/")
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		jsonError(w, http.StatusBadRequest, "missing deviceId in /peer/<deviceId>/<path>")
		return
	}
	path := "/"
	if found {
		path = "/" + tail
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}

	// proxyToDevice handles Bearer + X-Relay-Password + X-Yaver-Proxied-*
	// headers. We always POST the body verbatim if there is one; the
	// target agent inspects its own Method-check in the specific handler.
	var bodyBytes []byte
	if r.Body != nil {
		var err error
		bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, 8*1024*1024))
		if err != nil {
			jsonError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
	}

	status, resp, err := proxyToDevice(r.Context(), "peer-proxy", deviceID, r.Method, path, bodyBytes)
	if err != nil {
		// errProxyLocal means the deviceId resolved to THIS machine. Serving it
		// here is the whole answer — see serveLocallyInsteadOfRefusing.
		if errors.Is(err, errProxyLocal) {
			s.serveLocallyInsteadOfRefusing(w, r, path, bodyBytes)
			return
		}
		jsonError(w, http.StatusBadGateway, "peer proxy failed: "+err.Error())
		return
	}

	// Pass the target's body through verbatim. Content-Type is best-effort
	// JSON; downstream handlers mostly emit application/json already.
	if status == 0 {
		status = http.StatusOK
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(resp)
}

// serveLocallyInsteadOfRefusing handles a /peer/<deviceId>/<path> call whose
// deviceId resolved to THIS machine, by dispatching <path> into the agent's own
// route table.
//
// ── Why refusing was a bug, not a safety measure ────────────────────────────
//
// This used to answer HTTP 400 "peer target is the local machine; call the
// endpoint directly". Two things were wrong with it, and a user hit both at
// once on 2026-07-26 while trying to sign a runner in from the web Chat:
//
//		Sign in to Claude Code on ubuntu-4gb-hel1-1
//		Couldn't start sign-in
//		startRunnerBrowserAuth(claude) 400: peer target is the local machine;
//		call the endpoint directly
//
//	  1. IT WAS DEVELOPER LANGUAGE ON A USER'S SCREEN. "Call the endpoint
//	     directly" is an instruction to whoever wrote the client. The person
//	     reading it wanted to sign in to Claude, could do nothing with the
//	     sentence, and had no next step. Identical failure for codex — so every
//	     runner sign-in was dead on the box the user had actually chosen.
//
//	  2. THE REQUEST WAS ALWAYS SERVABLE. The client named a machine; that
//	     machine is this one; this process owns the handler. Answering "you asked
//	     the right box for something it can do, ask differently" is the inventory
//	     saying yes while the operation says no. There is nothing to protect here:
//	     dropping the prefix is a rewrite the agent can do for itself.
//
// The original guard's real purpose was to stop a RELAY RECURSION — a proxy hop
// that resolves to self and dials out again forever. Serving from the local mux
// cannot do that: it never touches the relay. The only genuine loop is a nested
// prefix (/peer/a/peer/b/...), and that is still refused below.
//
// ── Security: the same boundary, never a weaker one ────────────────────────
//
// The rewritten request goes through the SAME mux as a direct call, so the
// target route runs its OWN auth exactly as it always does. This adds no
// bypass: it does not copy an authorization decision from the proxy layer, and
// a caller who could not reach /runner-auth/browser/start directly still
// cannot reach it through /peer/<self>/. Body is capped upstream (8 MiB) and
// re-attached verbatim.
func (s *HTTPServer) serveLocallyInsteadOfRefusing(w http.ResponseWriter, r *http.Request, path string, bodyBytes []byte) {
	if s.localMux == nil {
		// Start() has not captured the route table (only possible in a partially
		// constructed server, e.g. a unit test). Say what is true rather than
		// pretending the call was invalid.
		jsonError(w, http.StatusServiceUnavailable,
			"this machine is the requested target but its route table is not ready yet — retry in a moment")
		return
	}

	rawPath, rawQuery, _ := strings.Cut(path, "?")
	// A nested peer prefix is the one shape that could still loop: /peer/self/
	// peer/self/... would re-enter this handler forever. Multi-hop peer routing
	// is not a feature today, so refuse it explicitly instead of recursing.
	if strings.HasPrefix(rawPath, "/peer/") {
		jsonError(w, http.StatusBadRequest,
			"nested /peer/ routing is not supported — address the final machine directly")
		return
	}

	r2 := r.Clone(r.Context())
	r2.URL.Path = rawPath
	r2.URL.RawQuery = rawQuery
	r2.RequestURI = path
	if len(bodyBytes) > 0 {
		r2.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		r2.ContentLength = int64(len(bodyBytes))
	} else {
		r2.Body = http.NoBody
		r2.ContentLength = 0
	}
	// Mark the hop so a handler that logs its caller can tell this apart from a
	// direct hit, and so an infinite-loop bug would be visible in one header.
	r2.Header.Set("X-Yaver-Peer-Self-Dispatch", "1")

	s.localMux.ServeHTTP(w, r2)
}
