package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Absolute rootPath was the legacy host-share escape hatch. Owner file APIs
// now accept only a server-discovered root ID, so even an authenticated caller
// cannot turn an arbitrary absolute directory into a writable root.
func TestFilesWriteRejectsLegacyRootPath(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "should-not-exist.txt")
	body := []byte(`{"rootPath":"` + root + `","path":"should-not-exist.txt","content":"blocked"}`)
	req := httptest.NewRequest(http.MethodPost, "/files/write", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	(&HTTPServer{}).handleFilesWrite(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("legacy rootPath wrote outside inventory, stat err=%v", err)
	}
}

func TestFilesDeleteRejectsLegacyRootPath(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "keep.txt")
	if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"rootPath":"` + root + `","path":"keep.txt"}`)
	req := httptest.NewRequest(http.MethodPost, "/files/delete", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	(&HTTPServer{}).handleFilesDelete(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body=%s", rec.Code, rec.Body.String())
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "keep" {
		t.Fatalf("legacy rootPath deleted or changed file: data=%q err=%v", got, err)
	}
}
