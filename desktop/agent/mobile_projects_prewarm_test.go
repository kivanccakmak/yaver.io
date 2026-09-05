package main

import (
	"os"
	"strings"
	"testing"
)

func TestPrewarmMobileProjectsRequiresExplicitOptInAndRunsSerially(t *testing.T) {
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
	guard := strings.Index(body, "YAVER_ENABLE_STARTUP_PREBUILD")
	prebuild := strings.Index(body, "prebuildExpoProject(p)")
	if guard < 0 {
		t.Fatal("startup prebuild is not opt-in; an agent restart can mutate unrelated cached projects and fill disk")
	}
	if prebuild < 0 {
		t.Fatal("startup prebuild call not found")
	}
	if guard > prebuild {
		t.Fatal("startup prebuild opt-in guard appears after the prebuild launch")
	}
	if strings.Contains(body, "go prebuildExpoProject(p)") {
		t.Fatal("startup prebuild fans out concurrent project builds; small workspaces must build them serially")
	}
}
