package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedStorageProfilesAreOwnerInventory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sharedA := filepath.Join(t.TempDir(), "shared-a")
	sharedB := filepath.Join(t.TempDir(), "shared-b")
	for _, dir := range []string{sharedA, sharedB} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := SaveConfig(&Config{SharedStorage: []SharedStorageProfile{
		{ID: "first", Name: "First", Type: "local", Path: sharedA},
		{ID: "second", Name: "Second", Type: "local", Path: sharedB},
	}}); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()
	status, body := doRequest(t, "GET", baseURL+"/shared-storage/profiles", "tok", "")
	if status != http.StatusOK {
		t.Fatalf("profiles expected 200, got %d body=%v", status, body)
	}
	profiles, ok := body["profiles"].([]interface{})
	if !ok || len(profiles) != 2 {
		t.Fatalf("expected both owner profiles, got %#v", body["profiles"])
	}
}
