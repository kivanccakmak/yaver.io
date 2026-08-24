package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// This is the headless half of the real mobile Browser Reload arc. It is
// opt-in because it uses the signed-in operator's primary device, but unlike a
// hand-written curl it exercises the maintained candidate/auth ladder and
// prints only the structured, credential-free doctor result.
func TestLivePrimaryBrowserLane(t *testing.T) {
	if os.Getenv("YAVER_LIVE_PRIMARY_BROWSER_LANE") != "1" {
		t.Skip("set YAVER_LIVE_PRIMARY_BROWSER_LANE=1 to probe the signed-in primary")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	cfg, _, target, err := resolvePrimaryDeviceForRemote(ctx)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := buildRemoteAgentCandidates(cfg, target)
	if err != nil {
		t.Fatal(err)
	}
	raw, status, _, err := primaryFetchWithFallthrough(ctx, candidates, cfg.AuthToken, "/doctor/browser-lane?waitSeconds=45", 90*time.Second)
	if err != nil && status == 0 {
		t.Fatal(err)
	}
	var probe BrowserLaneProbeResult
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("doctor HTTP %d returned an invalid envelope", status)
	}
	t.Logf("stage=%s status=%d ok=%v detail=%s remedy=%s", probe.Stage, probe.Status, probe.OK, probe.Detail, probe.Remedy)
	if status < 200 || status >= 300 {
		t.Fatalf("doctor transport returned HTTP %d", status)
	}
}
