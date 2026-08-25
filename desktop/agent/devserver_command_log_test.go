package main

import (
	"strings"
	"testing"
)

func TestEmitDevCommandUsesRawConsoleGrammar(t *testing.T) {
	var events []DevServerEvent
	emitDevCommand(func(event DevServerEvent) {
		events = append(events, event)
	}, "expo", "npx", []string{"expo", "start", "--web"}, "/workspace/example")

	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	event := events[0]
	if event.Type != "log" || event.Framework != "expo" {
		t.Fatalf("event = %#v, want expo log", event)
	}
	want := "$ npx expo start --web   (in /workspace/example)"
	if event.LogLine != want {
		t.Fatalf("logLine = %q, want %q", event.LogLine, want)
	}
	if strings.TrimSpace(event.Timestamp) == "" {
		t.Fatal("command log must carry a timestamp")
	}
}

func TestEmitDevCommandWithNilEmitterIsSafe(t *testing.T) {
	emitDevCommand(nil, "flutter", "flutter", []string{"run"}, "/workspace/example")
}
