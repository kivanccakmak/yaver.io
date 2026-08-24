package main

import (
	"os"
	"strings"
	"testing"
)

// The public relay must always start in official mode so an absent local
// shared password still routes authentication through Yaver's per-user
// backend. Without this directive, a deploy replaces the live unit and the
// relay correctly refuses to start rather than exposing an open relay.
func TestCanonicalServiceEnablesOfficialAuthentication(t *testing.T) {
	unit, err := os.ReadFile("deploy/yaver-relay.service")
	if err != nil {
		t.Fatalf("read canonical relay service: %v", err)
	}
	if !strings.Contains(string(unit), "Environment=YAVER_RELAY_OFFICIAL=1") {
		t.Fatal("canonical relay service must enable YAVER_RELAY_OFFICIAL=1")
	}
}
