package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type ownerDevStubServer struct{ status DevServerStatus }

func (s *ownerDevStubServer) Name() string                               { return "stub" }
func (s *ownerDevStubServer) Detect(string) bool                         { return false }
func (s *ownerDevStubServer) Start(context.Context, DevServerOpts) error { return nil }
func (s *ownerDevStubServer) Stop() error                                { return nil }
func (s *ownerDevStubServer) Port() int                                  { return s.status.Port }
func (s *ownerDevStubServer) BundleURL(string) string                    { return s.status.BundleURL }
func (s *ownerDevStubServer) SupportsHotReload() bool                    { return true }
func (s *ownerDevStubServer) Reload() error                              { return nil }
func (s *ownerDevStubServer) PreStart(string, int, string)               {}
func (s *ownerDevStubServer) Status() DevServerStatus                    { return s.status }
func (s *ownerDevStubServer) Kind() DevServerKind                        { return DevServerKindMobile }

type ownerDevFixture struct {
	baseURL   string
	cancel    context.CancelFunc
	server    *HTTPServer
	taskMgr   *TaskManager
	project   string
	hostToken string
}

func startOwnerDevFixture(t *testing.T) *ownerDevFixture {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	repoRoot := t.TempDir()
	project := filepath.Join(repoRoot, "project")
	if err := os.MkdirAll(filepath.Join(project, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	taskMgr := NewTaskManager(repoRoot, nil, defaultTestRunner())
	taskMgr.DummyMode = true
	port := getFreePort(t)
	hostToken := "owner-agent-token"
	srv := NewHTTPServer(port, hostToken, "owner-user", "owner-device", "", "owner-device", taskMgr)
	srv.execMgr = NewExecManager(taskMgr.workDir, nil)
	srv.devServerMgr = NewDevServerManager()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.Start(ctx) }()
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return &ownerDevFixture{baseURL: baseURL, cancel: cancel, server: srv, taskMgr: taskMgr, project: project, hostToken: hostToken}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	t.Fatalf("owner dev test server did not start within 3s")
	return nil
}
