package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpsReloadDevDelegatesToDevReloadHandler(t *testing.T) {
	fx := startOwnerDevFixture(t)
	defer fx.cancel()
	defer fx.taskMgr.Shutdown()
	fx.server.devServerMgr = &DevServerManager{active: &devServerSession{server: &ownerDevStubServer{status: DevServerStatus{
		Framework: "expo", Running: true, WorkDir: fx.project, Port: 8081,
	}}}}
	res := opsReloadHandler(OpsContext{Ctx: context.Background(), Server: fx.server}, json.RawMessage(`{"mode":"dev"}`))
	if !res.OK {
		t.Fatalf("reload mode=dev failed: code=%s err=%s", res.Code, res.Error)
	}
	initial, ok := res.Initial.(map[string]interface{})
	if !ok {
		t.Fatalf("Initial is %T, want map", res.Initial)
	}
	if _, ok := initial["deliveredTo"]; !ok {
		t.Fatalf("mode=dev did not go through /dev/reload: %#v", initial)
	}
}

func TestOpsReloadBundleSendsProjectPathNotWorkDir(t *testing.T) {
	fx := startOwnerDevFixture(t)
	defer fx.cancel()
	defer fx.taskMgr.Shutdown()
	fx.server.devServerMgr = &DevServerManager{}
	bb, err := NewBlackBoxManager()
	if err != nil {
		t.Fatalf("NewBlackBoxManager: %v", err)
	}
	fx.server.blackboxMgr = bb
	projectDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(projectDir, "README.md"), []byte("not rn\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	payload, _ := json.Marshal(map[string]string{"mode": "bundle", "workDir": projectDir})
	res := opsReloadHandler(OpsContext{Ctx: context.Background(), Server: fx.server}, payload)
	if strings.Contains(res.Error, "PROJECT_REQUIRED") {
		t.Fatalf("reload-app did not receive projectPath: %s", res.Error)
	}
	if !strings.Contains(res.Error, projectDir) {
		t.Fatalf("resolved project path did not reach build handler: %s", res.Error)
	}
}

func TestWithDeliveredToMergesWithoutLosingBuildFields(t *testing.T) {
	build := []byte(`{"ok":true,"bundleUrl":"http://x/main.jsbundle","platform":"ios"}`)
	var got map[string]interface{}
	if err := json.Unmarshal(withDeliveredTo(build, 0), &got); err != nil {
		t.Fatalf("merged body is not valid JSON: %v", err)
	}
	if got["deliveredTo"] != float64(0) {
		t.Fatalf("deliveredTo = %v, want 0", got["deliveredTo"])
	}
	for _, key := range []string{"ok", "bundleUrl", "platform"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("merge dropped %q", key)
		}
	}
	raw := []byte("not json at all")
	if string(withDeliveredTo(raw, 3)) != string(raw) {
		t.Fatal("non-JSON body should pass through untouched")
	}
}
