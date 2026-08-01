package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// v1 ships with the vault off. This pins the default, because the whole point
// is that a machine which never opted in never meets the vault at all.
func TestVaultEnabled_OffByDefault(t *testing.T) {
	t.Setenv(envEnableVault, "")
	if VaultEnabled() {
		t.Fatal("vault is enabled by default — v1 ships with it off")
	}
}

// The override can only ever turn a feature ON (feature_flags.go), so a box
// that needs the cells can opt in without a rebuild.
func TestVaultEnabled_EnvOverrideTurnsItOn(t *testing.T) {
	t.Setenv(envEnableVault, "1")
	if !VaultEnabled() {
		t.Fatalf("%s=1 did not enable the vault", envEnableVault)
	}
}

// Consumers must get a NAMED, actionable error — never a cryptographic one.
// "wrong passphrase or corrupted vault" is what taught users the product was
// broken; "disabled, here is the switch" is the truth.
func TestOpenVaultOptional_DisabledIsNamedNotCryptographic(t *testing.T) {
	t.Setenv(envEnableVault, "")
	t.Setenv("HOME", t.TempDir())

	_, err := openVaultOptional()
	if err == nil {
		t.Fatal("expected an error when the vault is disabled")
	}
	if !errors.Is(err, ErrVaultDisabled) {
		t.Fatalf("got %v, want ErrVaultDisabled", err)
	}
}

// The boot path must not even attempt an open — that attempt is what printed a
// vault warning on every start of every machine, most of which never used it.
func TestTryOpenAgentVault_DisabledDoesNotTouchDisk(t *testing.T) {
	t.Setenv(envEnableVault, "")
	home := t.TempDir()
	t.Setenv("HOME", home)

	_, err := tryOpenAgentVault(&Config{DeviceID: "d", AuthToken: "t"}, "")
	if !errors.Is(err, ErrVaultDisabled) {
		t.Fatalf("got %v, want ErrVaultDisabled", err)
	}
	// A disabled vault must not create master.key or vault.enc as a side effect.
	for _, name := range []string{"master.key", "master.key.meta", "vault.enc"} {
		if _, err := os.Stat(filepath.Join(home, ".yaver", name)); err == nil {
			t.Fatalf("%s was created while the vault is disabled", name)
		}
	}
}

// Rotation is the path that used to destroy vaults. With the feature off it
// must not run at all, regardless of what is on disk.
func TestRekeyVaultBetweenTokens_DisabledIsInert(t *testing.T) {
	t.Setenv(envEnableVault, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".yaver"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A file that looks like a vault. If rotation runs, it gets touched.
	vaultFile := filepath.Join(home, ".yaver", "vault.enc")
	if err := os.WriteFile(vaultFile, []byte("not-a-real-vault"), 0o600); err != nil {
		t.Fatal(err)
	}

	rekeyVaultBetweenTokens("old", "new")

	body, err := os.ReadFile(vaultFile)
	if err != nil || string(body) != "not-a-real-vault" {
		t.Fatalf("rotation touched the vault while disabled: %q err=%v", string(body), err)
	}
}
