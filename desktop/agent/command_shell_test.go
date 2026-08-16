package main

import (
	"errors"
	"reflect"
	"testing"
)

func fakeShellLookup(paths map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if path := paths[name]; path != "" {
			return path, nil
		}
		return "", errors.New("not found")
	}
}

func TestWindowsDefaultShellPrefersPowerShell7(t *testing.T) {
	spec, err := commandShellSpecFor("windows", "", fakeShellLookup(map[string]string{
		"pwsh.exe": `C:\Program Files\PowerShell\7\pwsh.exe`,
		"cmd.exe":  `C:\Windows\System32\cmd.exe`,
	}), func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if spec.Executable != `C:\Program Files\PowerShell\7\pwsh.exe` {
		t.Fatalf("executable = %q", spec.Executable)
	}
	want := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command"}
	if !reflect.DeepEqual(spec.Prefix, want) {
		t.Fatalf("prefix = %#v, want %#v", spec.Prefix, want)
	}
}

func TestWindowsDefaultShellFallsBackToComSpec(t *testing.T) {
	const comspec = `C:\Windows\System32\cmd.exe`
	spec, err := commandShellSpecFor("windows", "", fakeShellLookup(nil), func(name string) string {
		if name == "ComSpec" {
			return comspec
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Executable != comspec || !reflect.DeepEqual(spec.Prefix, []string{"/D", "/S", "/C"}) {
		t.Fatalf("cmd fallback = %#v", spec)
	}
}

func TestWindowsExplicitWSLShell(t *testing.T) {
	spec, err := commandShellSpecFor("windows", "wsl.exe", fakeShellLookup(map[string]string{
		"wsl.exe": `C:\Windows\System32\wsl.exe`,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--exec", "bash", "-lc"}
	if !reflect.DeepEqual(spec.Prefix, want) {
		t.Fatalf("WSL prefix = %#v, want %#v", spec.Prefix, want)
	}
}

func TestWindowsExplicitMissingPowerShellNamesFix(t *testing.T) {
	_, err := commandShellSpecFor("windows", "pwsh", fakeShellLookup(nil), nil)
	if err == nil {
		t.Fatal("missing explicit PowerShell must fail")
	}
}

func TestWindowsNPMBatchShimUsesCommandProcessor(t *testing.T) {
	spec, err := executableCommandSpecFor(
		"windows",
		`C:\Users\friend\AppData\Roaming\npm\codex.cmd`,
		[]string{"--model", "deepseek"},
		fakeShellLookup(map[string]string{"cmd": `C:\Windows\System32\cmd.exe`}),
		func(string) string { return "" },
	)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Executable != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("batch executable = %q", spec.Executable)
	}
	if len(spec.Prefix) != 4 || spec.Prefix[0] != "/D" || spec.Prefix[2] != "/C" {
		t.Fatalf("batch command prefix = %#v", spec.Prefix)
	}
	if got := spec.Prefix[3]; got != `C:\Users\friend\AppData\Roaming\npm\codex.cmd --model deepseek` {
		t.Fatalf("batch line = %q", got)
	}
}

func TestWindowsNativeRunnerStaysDirect(t *testing.T) {
	spec, err := executableCommandSpecFor("windows", `C:\Tools\opencode.exe`, []string{"--version"}, fakeShellLookup(nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Executable != `C:\Tools\opencode.exe` || !reflect.DeepEqual(spec.Prefix, []string{"--version"}) {
		t.Fatalf("native command was wrapped: %#v", spec)
	}
}
