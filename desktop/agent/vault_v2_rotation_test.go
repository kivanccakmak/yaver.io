package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// newV2VaultForTest builds a real master-key vault on disk with one secret in
// it, in a HOME the test owns.
func newV2VaultForTest(t *testing.T) (*VaultStore, [32]byte) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".yaver"), 0o700); err != nil {
		t.Fatal(err)
	}

	var masterKey [32]byte
	for i := range masterKey {
		masterKey[i] = byte(i + 1)
	}

	vs, err := NewVaultStoreV2(masterKey, "device-under-test")
	if err != nil {
		t.Fatalf("create v2 vault: %v", err)
	}
	if err := vs.Set(VaultEntry{Project: "mobile", Name: "APP_STORE_KEY_ID", Value: "ABC123"}); err != nil {
		t.Fatalf("seed secret: %v", err)
	}
	return vs, masterKey
}

// THE WEDGE, as a test.
//
// RekeyTo set vs.key from a passphrase but never cleared vs.formatV2, so a
// master-key vault got written in v2 layout encrypted with a TOKEN-derived key.
// master.key could no longer open it. rekeyVaultBetweenTokens ran on every
// auth-token rotation, so each sign-in quietly re-keyed the vault away from its
// own master key and the next rotation made it unrecoverable — surfacing much
// later as "wrong passphrase or corrupted vault", with nothing near the
// sign-in that caused it.
//
// If this test fails, signing in can destroy a user's secrets again.
func TestRekeyTo_RefusesOnV2Vault(t *testing.T) {
	vs, masterKey := newV2VaultForTest(t)

	err := vs.RekeyTo(DerivePassphraseFromToken("a-brand-new-auth-token"))
	if err == nil {
		t.Fatal("RekeyTo re-keyed a v2 vault to a token-derived key — this is the wedge")
	}
	if !errors.Is(err, ErrVaultIsV2) {
		t.Fatalf("got %v, want ErrVaultIsV2", err)
	}

	// The decisive assertion: the master key must still open it afterwards.
	reopened, err := NewVaultStoreV2(masterKey, "device-under-test")
	if err != nil {
		t.Fatalf("master.key can no longer open the vault after a rotation attempt: %v", err)
	}
	entry, err := reopened.Get("mobile", "APP_STORE_KEY_ID")
	if err != nil || entry == nil || entry.Value != "ABC123" {
		t.Fatalf("secret lost across rotation: entry=%+v err=%v", entry, err)
	}
}

// Rotation must not merely be safe — it must do nothing at all. A v2 vault is
// independent of the auth token by design.
func TestRekeyVaultBetweenTokens_IsNoOpForV2(t *testing.T) {
	vs, masterKey := newV2VaultForTest(t)
	setRuntimeVaultStore(vs)
	t.Cleanup(func() { setRuntimeVaultStore(nil) })

	path, err := VaultPath()
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate several sign-ins in a row — the real-world pattern that made
	// the damage cumulative and unrecoverable.
	for i := 0; i < 3; i++ {
		rekeyVaultBetweenTokens("old-token", "new-token")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("vault file gone after rotation: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("token rotation rewrote a v2 vault — it must be a complete no-op")
	}
	if _, err := NewVaultStoreV2(masterKey, "device-under-test"); err != nil {
		t.Fatalf("master.key no longer opens the vault after 3 rotations: %v", err)
	}
}

// The v1 path must keep working, or migrating boxes lose their rotation
// self-heal. A guard that disables the feature it protects is not a fix.
func TestRekeyTo_StillWorksOnLegacyV1Vault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".yaver"), 0o700); err != nil {
		t.Fatal(err)
	}

	oldPass := DerivePassphraseFromToken("old-token")
	vs, err := NewVaultStore(oldPass)
	if err != nil {
		t.Fatalf("create v1 vault: %v", err)
	}
	if err := vs.Set(VaultEntry{Project: "mobile", Name: "K", Value: "V"}); err != nil {
		t.Fatal(err)
	}

	newPass := DerivePassphraseFromToken("new-token")
	if err := vs.RekeyTo(newPass); err != nil {
		t.Fatalf("v1 rekey must still succeed: %v", err)
	}

	reopened, err := NewVaultStore(newPass)
	if err != nil {
		t.Fatalf("v1 vault does not open under the new token: %v", err)
	}
	if e, err := reopened.Get("mobile", "K"); err != nil || e == nil || e.Value != "V" {
		t.Fatalf("v1 secret lost across rekey: %+v %v", e, err)
	}
}
