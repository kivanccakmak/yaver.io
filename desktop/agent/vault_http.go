package main

import (
	"encoding/json"
	"net/http"
)

// handleVaultList returns vault entry summaries (never values).
func (s *HTTPServer) handleVaultList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if s.vaultStore == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "vault not available"})
		return
	}

	entries := s.vaultStore.List()
	jsonReply(w, http.StatusOK, entries)
}

// handleVaultGet returns a single vault entry including its value.
func (s *HTTPServer) handleVaultGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if s.vaultStore == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "vault not available"})
		return
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing 'name' parameter"})
		return
	}

	entry, err := s.vaultStore.Get(name)
	if err != nil {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	jsonReply(w, http.StatusOK, entry)
}

// handleVaultSet creates or updates a vault entry.
func (s *HTTPServer) handleVaultSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if s.vaultStore == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "vault not available"})
		return
	}

	var entry VaultEntry
	if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if entry.Name == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing 'name' field"})
		return
	}
	if entry.Value == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing 'value' field"})
		return
	}
	if entry.Category == "" {
		entry.Category = "custom"
	}

	if err := s.vaultStore.Set(entry); err != nil {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonReply(w, http.StatusOK, map[string]string{"ok": "true", "name": entry.Name})
}

// handleVaultDelete removes a vault entry.
func (s *HTTPServer) handleVaultDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if s.vaultStore == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "vault not available"})
		return
	}

	name := r.URL.Query().Get("name")
	if name == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing 'name' parameter"})
		return
	}

	if err := s.vaultStore.Delete(name); err != nil {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	jsonReply(w, http.StatusOK, map[string]string{"ok": "true"})
}
