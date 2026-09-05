package main

import (
	"strings"
	"testing"
)

func TestTailscaleBinaryCandidatesCoverGUIInstalls(t *testing.T) {
	env := func(key string) string {
		if key == "ProgramFiles" {
			return `C:\Program Files`
		}
		return ""
	}
	windows := tailscaleBinaryCandidates("windows", env)
	if len(windows) == 0 || !strings.EqualFold(windows[0], `C:\Program Files\Tailscale\tailscale.exe`) {
		t.Fatalf("windows GUI candidate missing: %v", windows)
	}
	darwin := tailscaleBinaryCandidates("darwin", func(string) string { return "" })
	if len(darwin) == 0 || darwin[0] != "/Applications/Tailscale.app/Contents/MacOS/Tailscale" {
		t.Fatalf("macOS app candidate missing: %v", darwin)
	}
}
