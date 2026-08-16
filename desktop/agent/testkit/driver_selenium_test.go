package testkit

import (
	"os"
	"strings"
	"testing"
)

func TestSeleniumSnapshotScriptReturnsExpression(t *testing.T) {
	script := seleniumSnapshotScript()
	if !strings.HasPrefix(script, "return (() =>") {
		t.Fatalf("WebDriver execute script must return its IIFE result, got %q", script[:min(len(script), 40)])
	}
}

func TestSeleniumDriverCommandOutlivesStartupContext(t *testing.T) {
	// The regression used exec.CommandContext in Launch, so cancelling the
	// bounded startup context killed ChromeDriver after a successful launch.
	// The process must instead be owned and stopped by seleniumBackend.Close.
	raw, err := os.ReadFile("driver_selenium.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if strings.Contains(source, `exec.CommandContext(ctx, bin, "--port="`) {
		t.Fatal("ChromeDriver is still tied to the bounded startup context")
	}
}
