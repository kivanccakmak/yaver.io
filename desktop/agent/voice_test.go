package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ═══════════════════════════════════════════════════════════════════════
// Voice provider registry tests
// ═══════════════════════════════════════════════════════════════════════

func TestVoiceProviderRegistry(t *testing.T) {
	p, ok := GetVoiceProvider("personaplex")
	if !ok {
		t.Fatal("personaplex provider not registered")
	}
	if p.Name() != "personaplex" {
		t.Errorf("expected name 'personaplex', got %q", p.Name())
	}

	p, ok = GetVoiceProvider("openai")
	if !ok {
		t.Fatal("openai provider not registered")
	}
	if p.Name() != "openai" {
		t.Errorf("expected name 'openai', got %q", p.Name())
	}

	_, ok = GetVoiceProvider("nonexistent")
	if ok {
		t.Error("expected nonexistent provider to not be found")
	}
}

func TestListVoiceProviders(t *testing.T) {
	providers := ListVoiceProviders()
	if len(providers) < 2 {
		t.Errorf("expected at least 2 providers, got %d", len(providers))
	}

	names := map[string]bool{}
	for _, p := range providers {
		names[p.Name()] = true
	}
	if !names["personaplex"] {
		t.Error("personaplex not in provider list")
	}
	if !names["openai"] {
		t.Error("openai not in provider list")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Voice config tests
// ═══════════════════════════════════════════════════════════════════════

func TestVoiceConfigJSON(t *testing.T) {
	cfg := VoiceConfig{
		S2SProvider:         "personaplex",
		PersonaPlexModelDir: "/home/user/.yaver/models/personaplex",
		S2SPort:             19838,
		AutoStart:           true,
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VoiceConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.S2SProvider != "personaplex" {
		t.Errorf("s2s_provider: got %q, want %q", decoded.S2SProvider, "personaplex")
	}
	if decoded.S2SPort != 19838 {
		t.Errorf("s2s_port: got %d, want %d", decoded.S2SPort, 19838)
	}
	if !decoded.AutoStart {
		t.Error("auto_start: expected true")
	}
}

func TestVoiceConfigInMainConfig(t *testing.T) {
	cfg := Config{
		Voice: &VoiceConfig{
			S2SProvider: "openai",
			S2SPort:     19838,
		},
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Config
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Voice == nil {
		t.Fatal("voice config should not be nil")
	}
	if decoded.Voice.S2SProvider != "openai" {
		t.Errorf("s2s_provider: got %q, want %q", decoded.Voice.S2SProvider, "openai")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Provider status tests
// ═══════════════════════════════════════════════════════════════════════

func TestPersonaPlexStatusNoModel(t *testing.T) {
	p := &PersonaPlexProvider{}
	status := p.Status()

	if status.Provider != "personaplex" {
		t.Errorf("provider: got %q, want %q", status.Provider, "personaplex")
	}
	if status.Ready {
		t.Error("expected not ready without model")
	}
}

func TestOpenAIStatusNoKey(t *testing.T) {
	p := &OpenAIRealtimeProvider{}
	status := p.Status()

	if status.Provider != "openai" {
		t.Errorf("provider: got %q, want %q", status.Provider, "openai")
	}
	if status.Ready {
		t.Error("expected not ready without API key")
	}
	if status.Error == "" {
		t.Error("expected error message when key not configured")
	}
}

func TestOpenAIStatusWithKey(t *testing.T) {
	p := &OpenAIRealtimeProvider{apiKey: "sk-test-key"}
	status := p.Status()

	if !status.Ready {
		t.Error("expected ready with API key set")
	}
	if status.Endpoint == "" {
		t.Error("expected endpoint to be set")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// GPU detection tests
// ═══════════════════════════════════════════════════════════════════════

func TestDetectGPU(t *testing.T) {
	avail, name := DetectGPU()
	t.Logf("GPU available: %v, name: %s", avail, name)
}

// ═══════════════════════════════════════════════════════════════════════
// Mock voice provider
// ═══════════════════════════════════════════════════════════════════════

type mockVoiceProvider struct {
	name          string
	available     bool
	transcription string
}

func (m *mockVoiceProvider) Name() string           { return m.name }
func (m *mockVoiceProvider) IsAvailable() bool       { return m.available }
func (m *mockVoiceProvider) Setup(_ SetupOpts) error { return nil }
func (m *mockVoiceProvider) Status() VoiceStatus {
	return VoiceStatus{Provider: m.name, Ready: m.available}
}
func (m *mockVoiceProvider) Transcribe(_ []byte) (string, error) {
	return m.transcription, nil
}
func (m *mockVoiceProvider) StartSession(_ context.Context, _ VoiceSessionOpts) (*VoiceSession, error) {
	return nil, nil
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP endpoint tests (using existing startTestServer pattern)
// ═══════════════════════════════════════════════════════════════════════

func TestVoiceStatusEndpoint(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	status, body := doRequest(t, "GET", baseURL+"/voice/status", "voice-test-token", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	if body["ok"] != true {
		t.Error("expected ok=true")
	}
	if body["voiceInputEnabled"] != true {
		t.Error("expected voiceInputEnabled=true (always enabled)")
	}
}

func TestVoiceProvidersEndpoint(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	status, body := doRequest(t, "GET", baseURL+"/voice/providers", "voice-test-token", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}

	providers, ok := body["providers"].([]interface{})
	if !ok {
		t.Fatal("expected providers array")
	}
	if len(providers) < 2 {
		t.Errorf("expected at least 2 providers, got %d", len(providers))
	}
}

func TestVoiceTranscribeEndpoint(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	wavData := generateTestWAVBytes(t)

	req, _ := http.NewRequest("POST", baseURL+"/voice/transcribe", wavData)
	req.Header.Set("Authorization", "Bearer voice-test-token")
	req.Header.Set("Content-Type", "audio/wav")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result["ok"] != true {
		t.Error("expected ok=true")
	}
}

func TestVoiceConfigEndpoint(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	// GET config
	status, body := doRequest(t, "GET", baseURL+"/voice/config", "voice-test-token", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	if body["ok"] != true {
		t.Error("expected ok=true")
	}
}

func TestVoiceStatusAuthRequired(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	status, _ := doRequest(t, "GET", baseURL+"/voice/status", "", "")
	if status != 401 {
		t.Fatalf("expected 401 without auth, got %d", status)
	}
}

func TestVoiceInfoEndpointIncludesVoice(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "voice-test-token", tm)
	defer cancel()

	status, body := doRequest(t, "GET", baseURL+"/info", "voice-test-token", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	if body["voiceInputEnabled"] != true {
		t.Error("/info should include voiceInputEnabled=true")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Mock PersonaPlex inference server
// ═══════════════════════════════════════════════════════════════════════

func TestMockPersonaPlexServer(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":       true,
				"provider": "personaplex",
				"device":   "mock",
			})
		case "/transcribe":
			body, _ := io.ReadAll(r.Body)
			if len(body) == 0 {
				http.Error(w, "empty audio", 400)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{
				"text": "this is a mock transcription from personaplex",
			})
		case "/stream":
			body, _ := io.ReadAll(r.Body)
			limit := len(body)
			if limit > 100 {
				limit = 100
			}
			json.NewEncoder(w).Encode(map[string]interface{}{
				"text":  "mock stream response",
				"audio": body[:limit],
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()

	// Test health
	resp, err := http.Get(mock.URL + "/health")
	if err != nil {
		t.Fatalf("health check failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// Test transcription
	wavData := generateTestWAVBytes(t)
	resp2, err := http.Post(mock.URL+"/transcribe", "audio/wav", wavData)
	if err != nil {
		t.Fatalf("transcribe failed: %v", err)
	}
	defer resp2.Body.Close()

	var result struct{ Text string }
	json.NewDecoder(resp2.Body).Decode(&result)
	if result.Text == "" {
		t.Error("expected non-empty transcription")
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

func generateTestWAVBytes(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	samples := make([]byte, 200)
	dataSize := len(samples)
	fileSize := 36 + dataSize

	buf.Write([]byte{'R', 'I', 'F', 'F'})
	buf.Write([]byte{byte(fileSize), byte(fileSize >> 8), byte(fileSize >> 16), byte(fileSize >> 24)})
	buf.Write([]byte{'W', 'A', 'V', 'E'})
	buf.Write([]byte{'f', 'm', 't', ' '})
	buf.Write([]byte{16, 0, 0, 0})
	buf.Write([]byte{1, 0})
	buf.Write([]byte{1, 0})
	sr := 16000
	buf.Write([]byte{byte(sr), byte(sr >> 8), byte(sr >> 16), byte(sr >> 24)})
	buf.Write([]byte{byte(sr * 2), byte((sr * 2) >> 8), byte((sr * 2) >> 16), byte((sr * 2) >> 24)})
	buf.Write([]byte{2, 0})
	buf.Write([]byte{16, 0})
	buf.Write([]byte{'d', 'a', 't', 'a'})
	buf.Write([]byte{byte(dataSize), byte(dataSize >> 8), byte(dataSize >> 16), byte(dataSize >> 24)})
	buf.Write(samples)

	return buf
}
