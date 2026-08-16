package main

import (
	"reflect"
	"testing"
	"unicode/utf16"
)

func TestBuildWindowsCommandLine(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"pwsh.exe", "-Command", "Write-Output ok"}, `pwsh.exe -Command "Write-Output ok"`},
		{[]string{"tool.exe", ""}, `tool.exe ""`},
		{[]string{`C:\Program Files\tool.exe`, `C:\work\`}, `"C:\Program Files\tool.exe" C:\work\`},
		{[]string{"tool.exe", `a"b`}, `tool.exe "a\"b"`},
	}
	for _, tc := range cases {
		if got := buildWindowsCommandLine(tc.args); got != tc.want {
			t.Errorf("buildWindowsCommandLine(%q) = %q, want %q", tc.args, got, tc.want)
		}
	}
}

func TestBuildWindowsEnvBlockUTF16SortedAndTerminated(t *testing.T) {
	block, err := buildWindowsEnvBlock([]string{
		"ZED=last",
		`Path=C:\Program Files\Ω`,
		"alpha=first",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatalf("environment block is not double-NUL terminated: %v", block)
	}

	var entries []string
	start := 0
	for i, unit := range block {
		if unit != 0 {
			continue
		}
		if i == start {
			break
		}
		entries = append(entries, string(utf16.Decode(block[start:i])))
		start = i + 1
	}
	want := []string{"alpha=first", `Path=C:\Program Files\Ω`, "ZED=last"}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("environment entries = %#v, want %#v", entries, want)
	}
}

func TestBuildWindowsEnvBlockRejectsNUL(t *testing.T) {
	if _, err := buildWindowsEnvBlock([]string{"A=before\x00after"}); err == nil {
		t.Fatal("embedded NUL must be rejected before CreateProcessW")
	}
}
