package main

// project_missing_reply.go — when this machine has no such project, say what it
// DOES have.
//
// THE INCIDENT (2026-08-02). A Vibing render probe answered:
//
//	no mobile project named "yaver / mobile" on this machine
//	  — check `yaver projects mobile`
//
// Every word true, and useless where it landed. The user was on the web
// dashboard, three transport hops from a shell on that box, so the one remedy
// offered was unreachable. This is the documented Flutter-install defect
// wearing different clothes: a remedy string naming a fix no surface exposes as
// an action.
//
// The machine was never short of the answer — mobileProjectCache holds the
// full inventory it just finished scanning. It simply never put it in the
// reply. So the browser had to guess, and guessed by escalating to a coding
// agent (see the audit): the most expensive possible answer to "which projects
// are on this box?", which a map lookup answers for free.
//
// This makes the refusal STRUCTURED — a stable code, the requested name, the
// available names, and a near-match when one is obvious — so any surface can
// render a picker instead of quoting a CLI command at someone who has no CLI.

import (
	"sort"
	"strconv"
	"strings"
)

// ReasonProjectNotOnThisMachine is the stable code for the refusal. Surfaces
// key off THIS, never off the prose — the sentence has already been reworded
// twice, and every regex written against it drifted.
const ReasonProjectNotOnThisMachine = "project_not_on_this_machine"

// projectMissingReply is the body returned when a named project is not here.
type projectMissingReply struct {
	Error             string   `json:"error"`
	Code              string   `json:"code"`
	RequestedProject  string   `json:"requestedProject"`
	AvailableProjects []string `json:"availableProjects"`
	// Suggestion is a single near-match, or "" when nothing is close enough.
	// Deliberately at most one: offering five "did you mean"s is a way of
	// admitting we do not know, dressed up as help.
	Suggestion string `json:"suggestion,omitempty"`
}

// maxAdvertisedProjects bounds the list. A box with 300 repos must not ship a
// wall of names to a phone — and a picker nobody can scroll is not a route to a
// fix. The bound is stated in the reply rather than silently truncating: a
// dropped remainder that reads as "these are all of them" is its own small lie.
const maxAdvertisedProjects = 40

// projectNamesFrom returns sorted, de-duplicated project names.
func projectNamesFrom(projects []MobileProject) []string {
	seen := make(map[string]bool, len(projects))
	out := make([]string, 0, len(projects))
	for _, p := range projects {
		n := strings.TrimSpace(p.Name)
		if n == "" || seen[strings.ToLower(n)] {
			continue
		}
		seen[strings.ToLower(n)] = true
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	if len(out) > maxAdvertisedProjects {
		out = out[:maxAdvertisedProjects]
	}
	return out
}

// nearestProjectName returns an obvious near-match for `requested`, or "".
//
// Deliberately conservative — exact-fold, then containment either way. It does
// NOT do fuzzy distance scoring: a wrong "did you mean" sends the user to build
// the wrong project, which is worse than no suggestion at all. Silence is a
// perfectly good answer here; the full list is already in the reply.
func nearestProjectName(requested string, names []string) string {
	want := strings.ToLower(strings.TrimSpace(requested))
	if want == "" {
		return ""
	}
	for _, n := range names {
		if strings.ToLower(n) == want {
			return n
		}
	}
	// "yaver / mobile" vs "mobile", or "sfmg" vs "sfmg / mobile". Only accept a
	// containment match when the shorter side is substantial — a two-character
	// overlap is noise, not a suggestion.
	const minOverlap = 3
	var best string
	for _, n := range names {
		got := strings.ToLower(n)
		short, long := got, want
		if len(want) < len(got) {
			short, long = want, got
		}
		if len(short) < minOverlap || !strings.Contains(long, short) {
			continue
		}
		// Prefer the shortest qualifying name: it is the least presumptuous.
		if best == "" || len(n) < len(best) {
			best = n
		}
	}
	return best
}

// buildProjectMissingReply assembles the structured refusal.
func buildProjectMissingReply(requested string, projects []MobileProject) projectMissingReply {
	names := projectNamesFrom(projects)
	msg := "no mobile project named " + quoteForMsg(requested) + " on this machine"
	switch {
	case len(names) == 0:
		// An empty inventory is a DIFFERENT fault from a wrong name, and saying
		// "pick another" when there are none to pick is the kind of advice that
		// makes a product feel broken.
		msg += " — this machine has no mobile projects at all yet"
	default:
		msg += " — it has " + pluralProjects(len(names)) + " (see availableProjects)"
	}
	return projectMissingReply{
		Error:             msg,
		Code:              ReasonProjectNotOnThisMachine,
		RequestedProject:  strings.TrimSpace(requested),
		AvailableProjects: names,
		Suggestion:        nearestProjectName(requested, names),
	}
}

func quoteForMsg(s string) string { return "\"" + strings.TrimSpace(s) + "\"" }

func pluralProjects(n int) string {
	if n == 1 {
		return "1 mobile project"
	}
	return strconv.Itoa(n) + " mobile projects"
}

// snapshotMobileProjects copies the scanned inventory under the read lock.
func snapshotMobileProjects() []MobileProject {
	mobileProjectCache.mu.RLock()
	defer mobileProjectCache.mu.RUnlock()
	out := make([]MobileProject, len(mobileProjectCache.projects))
	copy(out, mobileProjectCache.projects)
	return out
}
