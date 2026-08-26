package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDeployAllFrontDoorUsesCheckedOutController(t *testing.T) {
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(here), "..", "..", "deploy", "deploy.sh"))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read deploy front door: %v", err)
	}
	script := string(data)
	if !strings.Contains(script, `cd "$ROOT/desktop/agent" && go run . deploy all`) {
		t.Fatal("deploy all must execute the checked-out Go controller")
	}
	if strings.Contains(script, "run yaver deploy all") {
		t.Fatal("deploy all fell back to the potentially stale global yaver wrapper")
	}
}
