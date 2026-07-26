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
