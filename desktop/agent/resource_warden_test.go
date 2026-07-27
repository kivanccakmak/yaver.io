package main

import (
	"strings"
	"testing"
	"time"
)

// Band logic is pure so a starved box is not needed to prove it.
// Prove-by-breaking: flip any threshold comparison in
// classifyResourcePressure and the matching case here fails.
func TestClassifyResourcePressureBands(t *testing.T) {
	cases := []struct {
		name  string
		in    ResourcePressure
		level string
	}{
		{"healthy", ResourcePressure{CanFork: true, AvailableMb: 4000}, resourceLevelOK},
		{"low memory", ResourcePressure{CanFork: true, AvailableMb: 300}, resourceLevelDegraded},
		{"nearly out of memory", ResourcePressure{CanFork: true, AvailableMb: 100}, resourceLevelCritical},
		{"fork exhaustion", ResourcePressure{CanFork: false, AvailableMb: 4000}, resourceLevelCritical},
		{"fd pressure", ResourcePressure{CanFork: true, AvailableMb: 4000, OpenFDs: resourceFDDegraded + 1}, resourceLevelDegraded},
		{"child pressure", ResourcePressure{CanFork: true, AvailableMb: 4000, Children: resourceChildDegraded + 1}, resourceLevelDegraded},
		// fork exhaustion must dominate: a critical band never downgrades.
		{"fork exhaustion with plenty of fds", ResourcePressure{CanFork: false, AvailableMb: 300}, resourceLevelCritical},
	}
	for _, c := range cases {
		level, reasons := classifyResourcePressure(c.in)
		if level != c.level {
			t.Fatalf("%s: got %s want %s (reasons: %v)", c.name, level, c.level, reasons)
		}
		if level != resourceLevelOK && len(reasons) == 0 {
			t.Fatalf("%s: non-ok level with no reasons — refusals must be NAMED", c.name)
		}
	}
}

// Admission refuses ONLY the critical band, and the refusal carries the
// stable reason code plus a route (another machine), never bare prose.
func TestResourceAdmissionRefusesOnlyCritical(t *testing.T) {
	defer currentResourcePressure.Store(nil)

	set := func(level string, reasons ...string) {
		currentResourcePressure.Store(&ResourcePressure{At: time.Now(), Level: level, Reasons: reasons})
	}

	set(resourceLevelOK)
	if msg := ResourceAdmissionError(); msg != "" {
		t.Fatalf("ok box refused work: %q", msg)
	}
	set(resourceLevelDegraded, "memory is low (300 MB available)")
	if msg := ResourceAdmissionError(); msg != "" {
		t.Fatalf("degraded box must still accept work (it sheds its own load): %q", msg)
	}
	set(resourceLevelCritical, "only 100 MB of memory available")
	msg := ResourceAdmissionError()
	if msg == "" {
		t.Fatal("critical box accepted new work")
	}
	if !strings.Contains(msg, ReasonBoxResourcePressure) {
		t.Fatalf("refusal missing stable reason code: %q", msg)
	}
	if !strings.Contains(msg, "another machine") {
		t.Fatalf("refusal missing the route-to-fix: %q", msg)
	}
}

// Before the watchdog's first tick the accessor must be permissive — an
// unstarted warden must never block work.
func TestResourcePressureNowDefaultsPermissive(t *testing.T) {
	defer currentResourcePressure.Store(nil)
	currentResourcePressure.Store(nil)
	p := ResourcePressureNow()
	if p.Level != resourceLevelOK || !p.CanFork {
		t.Fatalf("zero-value pressure must be permissive, got %+v", p)
	}
	if msg := ResourceAdmissionError(); msg != "" {
		t.Fatalf("unstarted warden blocked admission: %q", msg)
	}
}
