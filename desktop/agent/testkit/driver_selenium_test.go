package testkit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
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

func TestWebDriverFillClearsBeforeTyping(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/session/s/element":
			fmt.Fprint(w, `{"value":{"element-6066-11e4-a52e-4f735466cecf":"field"}}`)
		default:
			fmt.Fprint(w, `{"value":null}`)
		}
	}))
	defer server.Close()
	driver := &FirefoxDriver{baseURL: server.URL, sessionID: "s", client: server.Client()}
	if err := driver.SendKeys(t.Context(), "#identifier", "io.yaver.mobile"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/session/s/element",
		"/session/s/element/field/clear",
		"/session/s/element/field/value",
	}
	if strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("Fill call order = %v, want %v", calls, want)
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
