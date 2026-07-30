package main

import (
	"os"
	"strings"
	"testing"
)

func TestPrewarmMobileProjectsHasStartupPrebuildKillSwitch(t *testing.T) {
	data, err := os.ReadFile("mobile_projects.go")
	if err != nil {
		t.Fatalf("read mobile_projects.go: %v", err)
	}
	src := string(data)
	fn := strings.Index(src, "func PrewarmMobileProjects()")
	if fn < 0 {
		t.Fatal("PrewarmMobileProjects not found")
	}
	body := src[fn:]
	guard := strings.Index(body, "YAVER_DISABLE_STARTUP_PREBUILD")
	prebuild := strings.Index(body, "go prebuildExpoProject(p)")
	if guard < 0 {
		t.Fatal("startup prebuild has no kill switch; autorun agents can mutate unrelated cached projects and fill disk")
	}
	if prebuild < 0 {
		t.Fatal("startup prebuild call not found")
	}
	if guard > prebuild {
		t.Fatal("startup prebuild kill switch appears after the prebuild goroutine launch")
	}
}
