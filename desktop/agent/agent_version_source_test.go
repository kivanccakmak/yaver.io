package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// agent_version_source_test.go — real HTTP servers on random ports, no mocks,
// matching the pattern in the rest of this package.
//
// The behaviour under test is a fallback ladder, and the failure mode of a
// fallback ladder is that nobody notices the primary is dead because the
// secondary quietly covers for it. So every test asserts WHICH SOURCE answered,
// not just that an answer arrived.

// resetVersionProbeState clears the ETag cache between tests. Without it, a
// cached version from an earlier case satisfies a later 304 and the test passes
// for the wrong reason.
func resetVersionProbeState(t *testing.T) {
	t.Helper()
	npmVersionCache.mu.Lock()
	npmVersionCache.etag = ""
	npmVersionCache.version = ""
	npmVersionCache.mu.Unlock()
}

// npmStub serves the abbreviated `/<pkg>/latest` document, with ETag support.
func npmStub(t *testing.T, version string, hits *int32) *httptest.Server {
	t.Helper()
	const etag = `"v1"`
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			atomic.AddInt32(hits, 1)
		}
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"name":%q,"version":%q}`, npmPackageName, version)
	}))
}

// The resolver builds its URLs from constants, so the tests exercise the two
// probe functions through a seam that lets the host be swapped. Rather than
// adding production-only indirection, they drive the same logic against stub
// servers via the helpers below.
func probeNPMAt(t *testing.T, base string) (string, agentVersionSource, error) {
	t.Helper()
	orig := npmLatestURL
	npmLatestURL = func() string { return base + "/" + npmPackageName + "/latest" }
	t.Cleanup(func() { npmLatestURL = orig })
	return latestVersionFromNPM(context.Background())
}

func probeGitHubAt(t *testing.T, base string) (string, error) {
	t.Helper()
	orig := githubLatestReleaseURL
	githubLatestReleaseURL = func() string { return base + "/releases/latest" }
	t.Cleanup(func() { githubLatestReleaseURL = orig })
	return latestVersionFromGitHub(context.Background())
}

// The happy path: npm answers, and it is npm that answered.
func TestLatestAgentVersion_PrefersNPM(t *testing.T) {
	resetVersionProbeState(t)
	srv := npmStub(t, "1.99.403", nil)
	defer srv.Close()

	v, src, err := probeNPMAt(t, srv.URL)
	if err != nil {
		t.Fatalf("npm probe failed: %v", err)
	}
	if v != "1.99.403" {
		t.Fatalf("got %q, want 1.99.403", v)
	}
	if src != versionSourceNPM {
		t.Fatalf("source %q, want %q", src, versionSourceNPM)
	}
}

// The poll that MATTERS is the one that finds nothing, and it should be free.
// A second call must send If-None-Match, take the 304, and still return the
// version — transferring no body.
func TestLatestAgentVersion_ConditionalRequestReusesTheCachedVersion(t *testing.T) {
	resetVersionProbeState(t)
	var hits int32
	srv := npmStub(t, "1.99.403", &hits)
	defer srv.Close()

	if _, src, err := probeNPMAt(t, srv.URL); err != nil || src != versionSourceNPM {
		t.Fatalf("first probe: src=%v err=%v", src, err)
	}
	v, src, err := probeNPMAt(t, srv.URL)
	if err != nil {
		t.Fatalf("second probe failed: %v", err)
	}
	if src != versionSourceCache {
		t.Fatalf("second probe source %q — the ETag was not sent, so every hourly poll pays full price", src)
	}
	if v != "1.99.403" {
		t.Fatalf("304 lost the version: got %q", v)
	}
	if hits != 2 {
		t.Fatalf("expected 2 requests, got %d", hits)
	}
}

// npm down must NOT freeze the fleet on an old build.
//
// This drives latestAgentVersion — the LADDER — not latestVersionFromGitHub.
// The first version of this test called the GitHub probe directly, which meant
// deleting the fallback branch entirely left it green: it asserted that a
// function works, not that anything calls it. Verified by deleting the branch
// and watching this fail.
func TestLatestAgentVersion_FallsBackToGitHubWhenNPMIsDown(t *testing.T) {
	resetVersionProbeState(t)

	deadNPM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer deadNPM.Close()
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"tag_name":"v1.99.404"}`)
	}))
	defer gh.Close()

	origNPM, origGH := npmLatestURL, githubLatestReleaseURL
	npmLatestURL = func() string { return deadNPM.URL + "/x/latest" }
	githubLatestReleaseURL = func() string { return gh.URL + "/releases/latest" }
	t.Cleanup(func() { npmLatestURL, githubLatestReleaseURL = origNPM, origGH })

	v, src, err := latestAgentVersion(context.Background())
	if err != nil {
		t.Fatalf("the ladder gave up while GitHub was answering: %v", err)
	}
	if v != "1.99.404" {
		t.Fatalf("got %q, want 1.99.404 (the leading v must be stripped)", v)
	}
	if src != versionSourceGitHub {
		t.Fatalf("source %q, want %q — a fallback that does not say it fell back hides a dead primary",
			src, versionSourceGitHub)
	}
}

// And the mirror: npm answering must NOT reach GitHub at all. A ladder that
// always queries both spends the 60 req/h budget it was built to save.
func TestLatestAgentVersion_NPMAnsweringNeverTouchesGitHub(t *testing.T) {
	resetVersionProbeState(t)
	npm := npmStub(t, "1.99.405", nil)
	defer npm.Close()

	var ghHits int32
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&ghHits, 1)
		fmt.Fprint(w, `{"tag_name":"v0.0.1"}`)
	}))
	defer gh.Close()

	origNPM, origGH := npmLatestURL, githubLatestReleaseURL
	npmLatestURL = func() string { return npm.URL + "/" + npmPackageName + "/latest" }
	githubLatestReleaseURL = func() string { return gh.URL + "/releases/latest" }
	t.Cleanup(func() { npmLatestURL, githubLatestReleaseURL = origNPM, origGH })

	v, src, err := latestAgentVersion(context.Background())
	if err != nil || v != "1.99.405" || src != versionSourceNPM {
		t.Fatalf("npm path: v=%q src=%q err=%v", v, src, err)
	}
	if ghHits != 0 {
		t.Fatalf("GitHub was queried %d time(s) even though npm answered — the rate-limit saving is gone", ghHits)
	}
}

// A 403 from GitHub is almost always the per-IP rate limit on a shared egress.
// Saying so is the difference between "our datacenter shares one IP" and a
// wild-goose chase through repo permissions and tokens.
func TestLatestAgentVersion_GitHub403NamesTheRateLimit(t *testing.T) {
	resetVersionProbeState(t)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
	}))
	defer gh.Close()

	_, err := probeGitHubAt(t, gh.URL)
	if err == nil {
		t.Fatal("a 403 was reported as success")
	}
	if !strings.Contains(err.Error(), "per-IP") {
		t.Fatalf("403 did not name the rate limit: %v", err)
	}
}

// Both down: the error must name BOTH halves, or a reader cannot tell whether
// this box has a network problem or the release pipeline does.
func TestLatestAgentVersion_BothDownNamesBothFailures(t *testing.T) {
	resetVersionProbeState(t)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	dead.Close() // closed → connection refused on both probes

	origNPM, origGH := npmLatestURL, githubLatestReleaseURL
	npmLatestURL = func() string { return dead.URL + "/x/latest" }
	githubLatestReleaseURL = func() string { return dead.URL + "/releases/latest" }
	t.Cleanup(func() { npmLatestURL, githubLatestReleaseURL = origNPM, origGH })

	_, _, err := latestAgentVersion(context.Background())
	if err == nil {
		t.Fatal("both sources down was reported as success")
	}
	for _, want := range []string{"npm:", "github:"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name %q", err, want)
		}
	}
}

// REGRESSION GUARD for the 406.
//
// The first version of this file sent `Accept:
// application/vnd.npm.install-v1+json` — the well-known abbreviated-packument
// media type, written from memory. The real registry answers **406** to that on
// /<pkg>/latest, so every poll would have failed into the GitHub fallback:
// working, quiet, and spending the exact rate-limit budget the change exists to
// save. Caught only by curling the live endpoint before shipping.
//
// This stub rejects anything that does not accept plain JSON, the same way the
// registry does.
func TestLatestAgentVersion_AcceptHeaderIsOneTheRegistryAccepts(t *testing.T) {
	resetVersionProbeState(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept := r.Header.Get("Accept")
		if strings.Contains(accept, "vnd.npm.install-v1+json") {
			w.WriteHeader(http.StatusNotAcceptable) // exactly what registry.npmjs.org does
			return
		}
		if accept != "" && !strings.Contains(accept, "application/json") && !strings.Contains(accept, "*/*") {
			w.WriteHeader(http.StatusNotAcceptable)
			return
		}
		fmt.Fprint(w, `{"name":"yaver-cli","version":"1.99.402"}`)
	}))
	defer srv.Close()

	v, src, err := probeNPMAt(t, srv.URL)
	if err != nil {
		t.Fatalf("the registry refused our Accept header (this is the 406 that made npm look down): %v", err)
	}
	if v != "1.99.402" || src != versionSourceNPM {
		t.Fatalf("v=%q src=%q", v, src)
	}
}

// An empty version must be an ERROR, never an answer. checkAutoUpdate compares
// semver, and "" would either skip silently or, worse, be treated as a version.
func TestLatestAgentVersion_EmptyVersionIsAnError(t *testing.T) {
	resetVersionProbeState(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"name":"yaver-cli","version":""}`)
	}))
	defer srv.Close()

	if _, _, err := probeNPMAt(t, srv.URL); err == nil {
		t.Fatal("an empty version string was accepted as an answer")
	}
}
