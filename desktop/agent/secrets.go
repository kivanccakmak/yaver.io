package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// SecretStore is deliberately separate from config.json and tasks.json. It
// stores provider credentials with owner-only permissions and never exposes
// values through the agent API, logs, task output, or device heartbeat.
type SecretStore struct {
	path string
	mu   sync.Mutex
	data map[string]string
}

func NewSecretStore() (*SecretStore, error) {
	dir, err := ConfigDir()
	if err != nil { return nil, err }
	s := &SecretStore{path: filepath.Join(dir, "secrets.json"), data: map[string]string{}}
	if raw, err := os.ReadFile(s.path); err == nil {
		if err := json.Unmarshal(raw, &s.data); err != nil { return nil, fmt.Errorf("parse secret store: %w", err) }
		if s.data == nil { s.data = map[string]string{} }
	} else if !os.IsNotExist(err) { return nil, fmt.Errorf("read secret store: %w", err) }
	return s, nil
}

func validSecretName(name string) bool {
	if name == "" || len(name) > 100 || strings.ContainsAny(name, "/\\\n\r") { return false }
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '-' { return false }
	}
	return true
}

func (s *SecretStore) saveLocked() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil { return err }
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0600); err != nil { return err }
	if err := os.Chmod(tmp, 0600); err != nil { _ = os.Remove(tmp); return err }
	return os.Rename(tmp, s.path)
}

func (s *SecretStore) Names() []string {
	s.mu.Lock(); defer s.mu.Unlock()
	result := make([]string, 0, len(s.data))
	for name := range s.data { result = append(result, name) }
	sort.Strings(result)
	return result
}

func (s *SecretStore) Get(name string) (string, bool) {
	s.mu.Lock(); defer s.mu.Unlock()
	value, ok := s.data[name]
	return value, ok
}

func (s *SecretStore) Set(name, value string) error {
	if !validSecretName(name) { return fmt.Errorf("invalid secret name") }
	if value == "" { return fmt.Errorf("secret value cannot be empty") }
	s.mu.Lock(); defer s.mu.Unlock()
	s.data[name] = value
	return s.saveLocked()
}

func (s *SecretStore) Delete(name string) error {
	if !validSecretName(name) { return fmt.Errorf("invalid secret name") }
	s.mu.Lock(); defer s.mu.Unlock()
	delete(s.data, name)
	return s.saveLocked()
}
