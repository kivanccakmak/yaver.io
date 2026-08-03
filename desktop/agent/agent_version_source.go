package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// agent_version_source.go — ASK NPM WHAT IS LATEST; FETCH THE BINARY FROM GITHUB.
//
// ─── Why the version question moved off GitHub ─────────────────────────────
//
// Three call sites each hand-rolled `api.github.com/repos/<repo>/releases/latest`
// (checkAutoUpdate, buildAgentUpdateStatus, fetchLatestYaverRelease). Two things
// wrong with that, separable:
//
//   • COST is not the problem. The repo is public and release downloads are
//     unmetered. Nothing here is a billing concern.
//   • THROTTLING is. GitHub's REST API allows 60 requests/hour PER SOURCE IP
//     unauthenticated, regardless of the repo being public. It only bites when
//     many agents share one egress — a datacenter — which is precisely the case
//     the original 6-hour check interval was defending against. That interval is
//     now 1-2h (a1f94a25e), which spends the same budget 6x faster.
//
// The version question does not have to go to GitHub at all:
//
//	                   GitHub API                  npm registry
//	rate limit         60/h per IP unauth          none comparable; CDN-fronted
//	canonical for      the signed BINARIES         the VERSION — npm is the only
//	                                               supported install path
//
// So: **check npm, fetch from GitHub.** The "is there something new" poll goes
// to a CDN with no per-IP ceiling; the signed, notarised asset still comes from
// the GitHub release, which is the only place it exists. That removes the
// shared-egress worry entirely — the sole justification for a slow cadence — and
// it is how npm's own `update-notifier` works: it polls the registry, not a git
// host. Precedent in-tree: mcp_registries.go and deploy_tokens.go already call
// registry.npmjs.org.
//
// ─── Why it still falls back to GitHub ─────────────────────────────────────
//
// npm being unreachable must not freeze the fleet on an old build. GitHub is
// tried second, and only if npm gave no answer — so the 60/h budget is spent
// only when the cheap path failed, which is exactly when it is worth spending.
//
// ─── MEASURED, not inferred (2026-08-03) ───────────────────────────────────
//
// Two things about this endpoint were written from memory in the design and are
// WRONG. Both were caught by curling the real registry before shipping, and
// both are recorded here so the next reader inherits evidence rather than
// instinct:
//
//  1. `Accept: application/vnd.npm.install-v1+json` — the well-known
//     "abbreviated packument" media type, and what the docs point you at —
//     returns **HTTP 406** on `/<pkg>/latest`. It applies to the full packument
//     (`/<pkg>`), not the per-version document. Every poll would have failed
//     into the GitHub fallback, silently spending the exact budget this file
//     exists to save. Plain `application/json` is correct, and /latest is tiny
//     anyway.
//
//  2. **The /latest endpoint sends NO ETag.** Only `cache-control: public,
//     max-age=300`. So the "conditional request answering 304" story from the
//     audit does not apply here. The If-None-Match support below is kept
//     because it is correct if the registry ever adds one and costs nothing
//     when it does not — but it is NOT where the saving comes from.
//
// The saving comes from npm having no per-IP ceiling at all. That justification
// stands on its own and does not need the 304.

// agentVersionSource names where an answer came from, so a log line or a
// dashboard can say "npm" instead of implying a single oracle that does not
// exist. Also the thing to look at first when two boxes disagree.
type agentVersionSource string

const (
	versionSourceNPM    agentVersionSource = "npm"
	versionSourceGitHub agentVersionSource = "github"
	versionSourceCache  agentVersionSource = "cache-304"
)

// npmPackageName is the package whose `latest` dist-tag defines the current
// release. CLAUDE.md: `npm install -g yaver-cli` is the ONLY supported install
// path on every platform, which is what makes this authoritative rather than a
// convenient mirror.
const npmPackageName = "yaver-cli"

// URL builders as vars, so a test can point them at an httptest server. Same
// seam the package already uses for latestAgentReleaseVersionFunc — the
// alternative is a test that hits the real registry, which is slow, flaky, and
// would make `go test` a source of traffic to npm.
var (
	npmLatestURL = func() string {
		return fmt.Sprintf("https://registry.npmjs.org/%s/latest", npmPackageName)
	}
	githubLatestReleaseURL = func() string {
		return fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", updateRepo())
	}
)

type versionProbeCache struct {
	mu      sync.Mutex
	etag    string
	version string
	at      time.Time
}

var npmVersionCache versionProbeCache

// latestAgentVersion resolves the newest published agent version.
//
// Returns the bare semver (no leading "v") and where it came from. The caller
// still downloads the binary from the GitHub release for that version — this
// function answers "is there something new", never "where do I get it".
func latestAgentVersion(ctx context.Context) (string, agentVersionSource, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	v, src, npmErr := latestVersionFromNPM(ctx)
	if npmErr == nil && v != "" {
		return v, src, nil
	}

	// npm had no answer. Spend the GitHub budget now — this is the case it is
	// worth spending on.
	v, ghErr := latestVersionFromGitHub(ctx)
	if ghErr == nil && v != "" {
		return v, versionSourceGitHub, nil
	}

	// Name BOTH failures. "could not determine the latest version" sends a
	// reader to guess which half broke; naming them says whether this box has a
	// network problem or the release pipeline does.
	return "", "", fmt.Errorf("could not resolve the latest agent version — npm: %v; github: %v", npmErr, ghErr)
}

func latestVersionFromNPM(ctx context.Context) (string, agentVersionSource, error) {
	npmVersionCache.mu.Lock()
	etag := npmVersionCache.etag
	cached := npmVersionCache.version
	npmVersionCache.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, npmLatestURL(), nil)
	if err != nil {
		return "", "", err
	}
	// PLAIN application/json, measured 2026-08-03 — NOT the abbreviated
	// `application/vnd.npm.install-v1+json`.
	//
	// That media type is the well-known way to ask npm for a smaller document
	// and it is what the docs point you at, so it went in from memory. Against
	// the real registry it returns **HTTP 406** on this endpoint: the
	// abbreviated form applies to the full packument (`/<pkg>`), not to the
	// per-version document (`/<pkg>/latest`). Every poll would have failed
	// straight through to the GitHub fallback, silently spending the exact
	// rate-limit budget this file exists to save.
	//
	// The /latest document is already tiny, so there is nothing to save here
	// anyway. Probe, then write down the measurement — do not infer a header.
	req.Header.Set("Accept", "application/json")
	if etag != "" && cached != "" {
		req.Header.Set("If-None-Match", etag)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified && cached != "" {
		return cached, versionSourceCache, nil
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return "", "", fmt.Errorf("npm registry returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var doc struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return "", "", fmt.Errorf("npm registry response unreadable: %w", err)
	}
	v := strings.TrimPrefix(strings.TrimSpace(doc.Version), "v")
	if v == "" {
		return "", "", fmt.Errorf("npm registry returned an empty version for %s", npmPackageName)
	}

	npmVersionCache.mu.Lock()
	npmVersionCache.etag = resp.Header.Get("ETag")
	npmVersionCache.version = v
	npmVersionCache.at = time.Now()
	npmVersionCache.mu.Unlock()

	return v, versionSourceNPM, nil
}

func latestVersionFromGitHub(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubLatestReleaseURL(), nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		// 403 here is almost always the per-IP rate limit, and saying so beats
		// "github status 403" — it tells the reader this is a shared-egress
		// problem, not a broken repo or a bad token.
		if resp.StatusCode == http.StatusForbidden {
			return "", fmt.Errorf("github status 403 (likely the 60 req/h per-IP unauthenticated limit on a shared egress): %s",
				strings.TrimSpace(string(body)))
		}
		return "", fmt.Errorf("github status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	return strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v"), nil
}
