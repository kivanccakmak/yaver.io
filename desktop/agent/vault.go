package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/nacl/secretbox"
)

// VaultEntry holds a single secret in the vault.
type VaultEntry struct {
	Name      string `json:"name"`
	Category  string `json:"category"` // "api-key", "signing-key", "ssh-key", "git-credential", "custom"
	Value     string `json:"value"`
	Notes     string `json:"notes,omitempty"`
	CreatedAt int64  `json:"created_at"` // unix millis
	UpdatedAt int64  `json:"updated_at"` // unix millis
}

// VaultEntrySummary is returned by List — never exposes Value.
type VaultEntrySummary struct {
	Name      string `json:"name"`
	Category  string `json:"category"`
	Notes     string `json:"notes,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// VaultStore manages the encrypted vault file at ~/.yaver/vault.enc.
type VaultStore struct {
	mu         sync.RWMutex
	path       string
	key        [32]byte // derived from passphrase or auth token
	entries    map[string]VaultEntry
	unlocked   bool
}

// Argon2id parameters for key derivation.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // 64 MB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
	nonceLen     = 24
)

// VaultPath returns the default vault file path.
func VaultPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "vault.enc"), nil
}

// deriveKey uses Argon2id to derive a 32-byte key from a passphrase and salt.
func deriveKey(passphrase []byte, salt []byte) [32]byte {
	raw := argon2.IDKey(passphrase, salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	var key [32]byte
	copy(key[:], raw)
	return key
}

// NewVaultStore opens or creates a vault. The passphrase is used to derive the
// encryption key. If the vault file doesn't exist, an empty vault is created.
func NewVaultStore(passphrase string) (*VaultStore, error) {
	vaultPath, err := VaultPath()
	if err != nil {
		return nil, err
	}

	vs := &VaultStore{
		path:    vaultPath,
		entries: make(map[string]VaultEntry),
	}

	data, err := os.ReadFile(vaultPath)
	if err != nil {
		if os.IsNotExist(err) {
			// New vault — derive key with a fresh salt, save empty vault
			salt := make([]byte, saltLen)
			if _, err := io.ReadFull(rand.Reader, salt); err != nil {
				return nil, fmt.Errorf("generate salt: %w", err)
			}
			vs.key = deriveKey([]byte(passphrase), salt)
			vs.unlocked = true
			// Save immediately to create the file with the salt
			if err := vs.save(salt); err != nil {
				return nil, fmt.Errorf("create vault: %w", err)
			}
			return vs, nil
		}
		return nil, fmt.Errorf("read vault: %w", err)
	}

	// Existing vault — extract salt, derive key, decrypt
	if len(data) < saltLen+nonceLen+secretbox.Overhead {
		return nil, fmt.Errorf("vault file too small — corrupted?")
	}

	salt := data[:saltLen]
	vs.key = deriveKey([]byte(passphrase), salt)

	var nonce [nonceLen]byte
	copy(nonce[:], data[saltLen:saltLen+nonceLen])

	plaintext, ok := secretbox.Open(nil, data[saltLen+nonceLen:], &nonce, &vs.key)
	if !ok {
		return nil, fmt.Errorf("wrong passphrase or corrupted vault")
	}

	if err := json.Unmarshal(plaintext, &vs.entries); err != nil {
		return nil, fmt.Errorf("parse vault: %w", err)
	}

	vs.unlocked = true
	return vs, nil
}

// List returns summaries of all vault entries (never includes values).
func (vs *VaultStore) List() []VaultEntrySummary {
	vs.mu.RLock()
	defer vs.mu.RUnlock()

	result := make([]VaultEntrySummary, 0, len(vs.entries))
	for _, e := range vs.entries {
		result = append(result, VaultEntrySummary{
			Name:      e.Name,
			Category:  e.Category,
			Notes:     e.Notes,
			CreatedAt: e.CreatedAt,
			UpdatedAt: e.UpdatedAt,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

// Get returns a single vault entry by name.
func (vs *VaultStore) Get(name string) (*VaultEntry, error) {
	vs.mu.RLock()
	defer vs.mu.RUnlock()

	e, ok := vs.entries[name]
	if !ok {
		return nil, fmt.Errorf("vault entry %q not found", name)
	}
	return &e, nil
}

// Set creates or updates a vault entry and persists to disk.
func (vs *VaultStore) Set(entry VaultEntry) error {
	vs.mu.Lock()
	defer vs.mu.Unlock()

	now := time.Now().UnixMilli()
	if existing, ok := vs.entries[entry.Name]; ok {
		entry.CreatedAt = existing.CreatedAt
	} else {
		entry.CreatedAt = now
	}
	entry.UpdatedAt = now

	vs.entries[entry.Name] = entry
	return vs.persist()
}

// Delete removes a vault entry by name and persists to disk.
func (vs *VaultStore) Delete(name string) error {
	vs.mu.Lock()
	defer vs.mu.Unlock()

	if _, ok := vs.entries[name]; !ok {
		return fmt.Errorf("vault entry %q not found", name)
	}
	delete(vs.entries, name)
	return vs.persist()
}

// persist encrypts and atomically writes the vault to disk.
// Caller must hold vs.mu write lock.
func (vs *VaultStore) persist() error {
	// Read existing salt from file (or generate new one)
	salt := make([]byte, saltLen)
	existing, err := os.ReadFile(vs.path)
	if err == nil && len(existing) >= saltLen {
		copy(salt, existing[:saltLen])
	} else {
		if _, err := io.ReadFull(rand.Reader, salt); err != nil {
			return fmt.Errorf("generate salt: %w", err)
		}
	}
	return vs.save(salt)
}

// save encrypts entries and writes atomically with the given salt.
func (vs *VaultStore) save(salt []byte) error {
	plaintext, err := json.Marshal(vs.entries)
	if err != nil {
		return fmt.Errorf("marshal vault: %w", err)
	}

	var nonce [nonceLen]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		return fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := secretbox.Seal(nil, plaintext, &nonce, &vs.key)

	// Build file: [salt][nonce][ciphertext]
	out := make([]byte, 0, saltLen+nonceLen+len(ciphertext))
	out = append(out, salt...)
	out = append(out, nonce[:]...)
	out = append(out, ciphertext...)

	// Atomic write: write to temp file, then rename
	tmpPath := vs.path + ".tmp"
	if err := os.WriteFile(tmpPath, out, 0600); err != nil {
		return fmt.Errorf("write vault tmp: %w", err)
	}
	if err := os.Rename(tmpPath, vs.path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename vault: %w", err)
	}
	return nil
}

// ExportPlaintext exports all vault entries as plaintext JSON. Use with caution.
func (vs *VaultStore) ExportPlaintext() ([]byte, error) {
	vs.mu.RLock()
	defer vs.mu.RUnlock()

	entries := make([]VaultEntry, 0, len(vs.entries))
	for _, e := range vs.entries {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name < entries[j].Name
	})
	return json.MarshalIndent(entries, "", "  ")
}

// ImportPlaintext imports vault entries from a plaintext JSON array.
// Existing entries with the same name are overwritten.
func (vs *VaultStore) ImportPlaintext(data []byte) (int, error) {
	var entries []VaultEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return 0, fmt.Errorf("parse import data: %w", err)
	}

	vs.mu.Lock()
	defer vs.mu.Unlock()

	now := time.Now().UnixMilli()
	for _, e := range entries {
		if e.Name == "" {
			continue
		}
		if e.CreatedAt == 0 {
			e.CreatedAt = now
		}
		e.UpdatedAt = now
		vs.entries[e.Name] = e
	}

	if err := vs.persist(); err != nil {
		return 0, err
	}
	return len(entries), nil
}

// DerivePassphraseFromToken derives a vault passphrase from a Yaver auth token.
// This provides seamless vault unlock without the user needing a separate passphrase.
func DerivePassphraseFromToken(token string) string {
	h := sha256.Sum256([]byte("yaver-vault:" + token))
	return fmt.Sprintf("%x", h[:])
}
