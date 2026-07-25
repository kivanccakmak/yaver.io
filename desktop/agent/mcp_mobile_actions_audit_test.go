package main

import (
	"path/filepath"
	"testing"
)

func TestMCPMobileProjectActionsAuditCatchesXcodegenSwiftActions(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	swift := filepath.Join(tmp, "Workspace", "todo-swift")
	mustMkdirAllMobileScan(t, filepath.Join(swift, ".git"))
	writeManifestFile(t, filepath.Join(swift, "project.yml"), `
name: TodoSwift
targets:
  TodoSwift:
    platform: iOS
    settings:
      base:
        INFOPLIST_KEY_CFBundleDisplayName: "Todo Swift"
`)

	report := mcpMobileProjectActionsAudit(swift)
	if ok, _ := report["ok"].(bool); !ok {
		t.Fatalf("xcodegen Swift project should have supported actions after audit fix: %+v", report)
	}
	if checked, _ := report["checked"].(int); checked != 1 {
		t.Fatalf("checked = %d, want 1: %+v", checked, report)
	}

	rows, ok := report["projects"].([]mobileProjectActionsAuditRow)
	if !ok || len(rows) != 1 {
		t.Fatalf("projects rows malformed: %#v", report["projects"])
	}
	if len(rows[0].SupportedActions) == 0 {
		t.Fatalf("supported actions missing: %+v", rows[0])
	}
}
