package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalSecretsEnvParsesOwnerOnlyFallbackFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".yaver")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir local secrets dir: %v", err)
	}
	body := []byte(`
# comment
export YAVER_LOGIN_PASSWORD="pa\"ss\\word"
YAVER_LOGIN_KEYCHAIN_PATH='~/Library/Keychains/login.keychain-db'
bad line
BAD KEY=value
`)
	if err := os.WriteFile(filepath.Join(dir, "local-secrets.env"), body, 0o600); err != nil {
		t.Fatalf("write local secrets: %v", err)
	}

	got := localSecretsEnv()
	if got["YAVER_LOGIN_PASSWORD"] != `pa"ss\word` {
		t.Fatalf("password value parsed as %q", got["YAVER_LOGIN_PASSWORD"])
	}
	if got["YAVER_LOGIN_KEYCHAIN_PATH"] != "~/Library/Keychains/login.keychain-db" {
		t.Fatalf("keychain path parsed as %q", got["YAVER_LOGIN_KEYCHAIN_PATH"])
	}
	if _, ok := got["BAD KEY"]; ok {
		t.Fatal("localSecretsEnv accepted a key containing whitespace")
	}
}

func TestExpandHomePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if got := expandHomePath("~/Library/Keychains/login.keychain-db"); got != filepath.Join(home, "Library/Keychains/login.keychain-db") {
		t.Fatalf("expandHomePath returned %q", got)
	}
	if got := expandHomePath("/tmp/keychain"); got != "/tmp/keychain" {
		t.Fatalf("absolute path changed to %q", got)
	}
}

// The desktop GUI spawns the embedded agent with YAVER_VAULT_SKIP_KEYCHAIN=1
// so `yaver serve` never triggers a macOS "security wants to use your
// confidential information" prompt. claudeMacKeychainHasCreds must not shell
// out to `security` at all under that gate — the probe was the prompt source
// (each fresh `security find-generic-password` asks the OS on first read).
func TestClaudeMacKeychainProbeDisabledWhenKeychainAccessDisabled(t *testing.T) {
	t.Setenv("YAVER_VAULT_SKIP_KEYCHAIN", "1")
	t.Setenv("YAVER_NONINTERACTIVE", "")
	t.Setenv("CI", "")
	if !keychainAccessDisabled() {
		t.Fatal("keychainAccessDisabled() should be true with YAVER_VAULT_SKIP_KEYCHAIN=1")
	}
	// The probe must return false (no keychain creds) WITHOUT running
	// `security`. We can't observe the exec directly here, but the gate
	// short-circuits before the cache/exec path, so a hit on a non-darwin
	// runner (or with no security tool) is only possible if the gate held.
	if claudeMacKeychainHasCreds() {
		t.Fatal("claudeMacKeychainHasCreds() must report false when keychain access is disabled")
	}
}

func TestClaudeMacKeychainProbeEnabledByDefault(t *testing.T) {
	t.Setenv("YAVER_VAULT_SKIP_KEYCHAIN", "")
	t.Setenv("YAVER_NONINTERACTIVE", "")
	t.Setenv("CI", "")
	if keychainAccessDisabled() {
		t.Fatal("keychainAccessDisabled() should be false without the gate env vars")
	}
}
