package main

import "testing"

// install_composite_plan_test.go — every step of every composite recipe must
// resolve, on every platform, from any host.
//
// THE INCIDENT (measured 2026-07-27). `yaver install remote-runtime` and
// `POST /install/remote-runtime` ALWAYS failed on macOS with
// `missing install plan: xcodegen`. The darwin branch appended "xcodegen" and
// "cliclick" and resolved every step through metaInstallPlan alone — neither
// name has a metaInstallPlan case; both live only in the `integrations` table.
//
// Three things made this expensive rather than annoying:
//
//  1. It failed at the END. java, android-sdk and flutter downloaded first —
//     several GB, up to an hour — and then the recipe reported failure with
//     nothing installed that the user asked for by name.
//  2. `yaver install remote-runtime` is the remedy the product PRINTS when
//     adb is missing during WebRTC capture (remote_runtime_video_track.go).
//     A remedy the product refuses is the 2026-07-26 "yaver lies" defect with
//     a bigger price tag.
//  3. It was unreachable on Linux, so no CI run could ever have caught it.
//     That is why the list is now a function of GOOS rather than a
//     runtime.GOOS branch: the platform you are NOT on is the platform that
//     breaks.
func TestEveryCompositePlanStepResolves(t *testing.T) {
	lists := map[string][]string{
		"pi-dev-node":  piDevNodePlanNames,
		"vibe-preview": vibePreviewPlanNames,
		"backend-dev":  backendDevPlanNames,
		"tdd":          tddPlanNames,
	}
	// Both platforms, from whichever one the test happens to run on.
	for _, goos := range []string{"linux", "darwin"} {
		lists["remote-runtime/"+goos] = remoteRuntimePlanNamesFor(goos)
	}

	for recipe, names := range lists {
		if len(names) == 0 {
			t.Errorf("%s: empty step list", recipe)
		}
		for _, name := range names {
			if _, ok := resolveCompositePlan(name); !ok {
				t.Errorf("`yaver install %s` references step %q, which resolves in NEITHER metaInstallPlan nor integrations — this recipe fails, and it fails after every earlier step has already downloaded", recipe, name)
			}
		}
	}
}

// The regression this pass fixed, named on its own so a failure reads as the
// bug rather than as a table row.
func TestRemoteRuntimeInstallResolvesTheDarwinExtras(t *testing.T) {
	for _, name := range []string{"xcodegen", "cliclick"} {
		if _, ok := metaInstallPlan(name); ok {
			t.Logf("%s now has a meta plan too — fine, the fallback just stops being needed", name)
		}
		if _, ok := resolveCompositePlan(name); !ok {
			t.Fatalf("%s does not resolve — `yaver install remote-runtime` is broken on macOS again, and it breaks after several GB of downloads", name)
		}
	}
	darwin := remoteRuntimePlanNamesFor("darwin")
	linux := remoteRuntimePlanNamesFor("linux")
	if len(darwin) <= len(linux) {
		t.Errorf("darwin list (%v) must extend the linux one (%v)", darwin, linux)
	}
	// A fresh slice per call — a shared backing array is how one caller's
	// platform quietly becomes every caller's.
	if &darwin[0] == &linux[0] {
		t.Error("remoteRuntimePlanNamesFor must return a fresh slice")
	}
}

// resolveCompositePlan must keep preferring the curated meta recipe, because
// several names exist in BOTH tables with different steps and the composites
// have always run the meta one. The integrations fallback is additive or it is
// a silent behaviour change.
func TestResolveCompositePlanPrefersTheMetaRecipe(t *testing.T) {
	for _, name := range []string{"android-sdk", "chromium", "ffmpeg", "tmux", "git", "gh", "uv", "docker"} {
		meta, metaOK := metaInstallPlan(name)
		if !metaOK {
			t.Fatalf("fixture drift: %q no longer has a meta plan", name)
		}
		got, ok := resolveCompositePlan(name)
		if !ok {
			t.Fatalf("%q stopped resolving", name)
		}
		if got.description != meta.description {
			t.Errorf("%q resolved to the integrations plan (%q), not the meta plan (%q) — composites just changed what they install", name, got.description, meta.description)
		}
	}
}
