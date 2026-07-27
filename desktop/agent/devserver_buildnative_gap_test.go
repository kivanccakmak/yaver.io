package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// devserver_buildnative_gap_test.go — /dev/build-native must refuse with the
// SAME body /dev/start refuses with.
//
// V7 in the failure-plumbing audit: `/dev/build-native` answered
//   500 {"error":"missing required tools on this machine: bun"}
// for byte-for-byte the failure `/dev/start` answers with a 412 carrying
// missingTools + installEndpoint + installable + helpHint + capabilityGap.
// One producer got an Install button on every surface; the other, one lane
// over on the SAME machine for the SAME missing binary, got a sentence. Two
// producers for one refusal is the structural defect the CapabilityGap seam
// exists to remove — this test pins that build-native uses the shared one.

// The shared body must be complete for the Hermes lane's real missing tools.
func TestBuildNativeRefusalBodyCarriesTheSameRouteAsDevStart(t *testing.T) {
	for _, missing := range [][]string{
		{"bun", "bunx"},
		{"pnpm"},
		{"yarn", "npx"},
	} {
		gap := DetectCapabilityGap(CapabilityGapContext{
			Framework:    "react-native",
			WorkDir:      "/home/dev/app",
			MissingTools: missing,
		})
		body := devStartGapRefusal(gap, missing)

		for _, key := range []string{"error", "missingTools", "installEndpoint", "installable", "helpHint", "capabilityGap"} {
			if _, present := body[key]; !present {
				t.Fatalf("missing %v: refusal body has no %q — the build lane is back to a bare error string", missing, key)
			}
		}
		if body["installable"] != true {
			t.Errorf("missing %v: installable = %v, want true — every one of these has a recipe", missing, body["installable"])
		}
		blob, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var wire map[string]any
		if err := json.Unmarshal(blob, &wire); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		g, _ := wire["capabilityGap"].(map[string]any)
		if g == nil {
			t.Fatalf("missing %v: capabilityGap did not survive JSON", missing)
		}
		fix, _ := g["fix"].(map[string]any)
		if fix == nil {
			t.Fatalf("missing %v: no fix on the wire — the twins render a constraint card with no button", missing)
		}
		path, _ := fix["path"].(string)
		stream, _ := fix["stream"].(string)
		if !strings.HasPrefix(path, "/install/") {
			t.Errorf("missing %v: fix.path = %q, want an /install/ route", missing, path)
		}
		if stream != installStreamNameForEndpoint(path) {
			t.Errorf("missing %v: fix.stream = %q, want %q — a stream name typed by hand is how /streams/install got shipped", missing, stream, installStreamNameForEndpoint(path))
		}
	}
}

// THE WIRING GUARD. devStartGapRefusal existing is not the deliverable; the
// build-native handler CALLING it is. Rule 11: a producer with no call site is
// not shipped.
func TestBuildNativeHandlerUsesTheSharedRefusal(t *testing.T) {
	src, err := os.ReadFile("devserver_http.go")
	if err != nil {
		t.Fatalf("read devserver_http.go: %v", err)
	}
	text := string(src)

	// The two /dev/build-native refusals this pass rerouted.
	if strings.Contains(text, `errMsg := fmt.Sprintf("missing required tools on this machine: %s", strings.Join(prep.MissingTools, ", "))`) &&
		!strings.Contains(text, "devStartGapRefusal(\n\t\t\tDetectCapabilityGap(CapabilityGapContext{") {
		t.Error("build-native's missing-tools refusal no longer routes through devStartGapRefusal — the Hermes lane lost its Install button")
	}
	// Counted, not just "present somewhere": /dev/start owns two call sites
	// and build-native adds two more. A drop below four means one of the four
	// refusals silently went back to a bare string.
	if n := strings.Count(text, "devStartGapRefusal("); n < 5 { // 1 definition + 4 call sites
		t.Errorf("devStartGapRefusal appears %d times (1 def + 4 call sites expected) — a refusal lane regressed to prose", n)
	}
}

// The inverse: a package manager with no recipe must NOT get a button. The
// build-native deps branch degrades to the plain error rather than advertising
// an install the product would 404.
func TestUnknownPackageManagerGetsNoButton(t *testing.T) {
	if installableViaAgent("turbo-mega-pm") {
		t.Fatal("test fixture is wrong — this name must not resolve")
	}
	gap := DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{"turbo-mega-pm"}})
	if gap == nil {
		t.Fatal("still a named gap — the user must learn WHAT is missing even when Yaver cannot fix it")
	}
	if gap.Fix != nil {
		t.Fatalf("advertised %s %s for a tool with no recipe", gap.Fix.Method, gap.Fix.Path)
	}
	if gap.Constraint == "" {
		t.Fatal("no Fix means Constraint is mandatory")
	}
}
