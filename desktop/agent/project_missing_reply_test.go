package main

import (
	"strconv"
	"strings"
	"testing"
)

func projectsNamed(names ...string) []MobileProject {
	out := make([]MobileProject, 0, len(names))
	for _, n := range names {
		out = append(out, MobileProject{Name: n, Path: "/tmp/" + n})
	}
	return out
}

// The refusal must carry a STABLE code. Surfaces have already drifted three
// different regexes against relay prose; this class must not repeat it.
func TestProjectMissingReply_CarriesStableCode(t *testing.T) {
	r := buildProjectMissingReply("yaver / mobile", projectsNamed("sfmg", "todo-rn"))
	if r.Code != ReasonProjectNotOnThisMachine {
		t.Fatalf("missing stable code, got %q", r.Code)
	}
	if r.RequestedProject != "yaver / mobile" {
		t.Fatalf("the requested name must survive verbatim, got %q", r.RequestedProject)
	}
}

// The whole point: say what this machine DOES have, so a surface can render a
// picker instead of quoting a CLI command at someone who has no CLI.
func TestProjectMissingReply_AdvertisesWhatItHas(t *testing.T) {
	r := buildProjectMissingReply("nope", projectsNamed("todo-rn", "sfmg"))
	if len(r.AvailableProjects) != 2 {
		t.Fatalf("expected the inventory, got %v", r.AvailableProjects)
	}
	// Sorted case-insensitively so the picker is stable between renders.
	if r.AvailableProjects[0] != "sfmg" || r.AvailableProjects[1] != "todo-rn" {
		t.Fatalf("expected sorted names, got %v", r.AvailableProjects)
	}
	if !strings.Contains(r.Error, "2 mobile projects") {
		t.Fatalf("the sentence should say how many it has, got %q", r.Error)
	}
	if strings.Contains(r.Error, "yaver projects mobile") {
		t.Fatal("the CLI-only remedy must be gone — it is unreachable from the web")
	}
}

// An EMPTY inventory is a different fault from a wrong name. Telling someone to
// "pick another project" when there are none is how a product feels broken.
func TestProjectMissingReply_EmptyInventoryIsItsOwnFault(t *testing.T) {
	r := buildProjectMissingReply("anything", nil)
	if len(r.AvailableProjects) != 0 {
		t.Fatalf("expected no projects, got %v", r.AvailableProjects)
	}
	if !strings.Contains(r.Error, "no mobile projects at all") {
		t.Fatalf("an empty box must say so, got %q", r.Error)
	}
	if r.Suggestion != "" {
		t.Fatalf("nothing to suggest from an empty inventory, got %q", r.Suggestion)
	}
}

func TestNearestProjectName_ObviousMatches(t *testing.T) {
	names := []string{"sfmg", "todo-rn", "yaver / mobile"}
	if got := nearestProjectName("YAVER / MOBILE", names); got != "yaver / mobile" {
		t.Fatalf("an exact case-fold match must win, got %q", got)
	}
	if got := nearestProjectName("sfmg / mobile", names); got != "sfmg" {
		t.Fatalf("a containment match should find sfmg, got %q", got)
	}
}

// NO FALSE REDS — a wrong "did you mean" sends the user to build the WRONG
// project, which is worse than no suggestion. Silence is a fine answer; the
// full list is in the reply either way.
func TestNearestProjectName_RefusesToGuess(t *testing.T) {
	names := []string{"sfmg", "todo-rn"}
	if got := nearestProjectName("completely-unrelated", names); got != "" {
		t.Fatalf("must not invent a near match, got %q", got)
	}
	// A two-character overlap is noise, not a suggestion.
	if got := nearestProjectName("rn", names); got != "" {
		t.Fatalf("a tiny overlap must not qualify, got %q", got)
	}
	if got := nearestProjectName("", names); got != "" {
		t.Fatalf("an empty request suggests nothing, got %q", got)
	}
}

// A box with hundreds of repos must not ship a wall of names to a phone.
func TestProjectNamesFrom_BoundedAndDeduped(t *testing.T) {
	many := make([]string, 0, 120)
	for i := 0; i < 120; i++ {
		many = append(many, "proj-"+strconv.Itoa(i))
	}
	if got := len(projectNamesFrom(projectsNamed(many...))); got != maxAdvertisedProjects {
		t.Fatalf("expected the list bounded to %d, got %d", maxAdvertisedProjects, got)
	}
	dup := projectNamesFrom(projectsNamed("Same", "same", "SAME"))
	if len(dup) != 1 {
		t.Fatalf("case-different duplicates must collapse, got %v", dup)
	}
	if len(projectNamesFrom(projectsNamed("", "  ", "real"))) != 1 {
		t.Fatal("blank names must be dropped rather than rendered as empty picker rows")
	}
}
