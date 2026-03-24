package main

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"sync"
)

// ---------------------------------------------------------------------------
// Voice provider interface — provider-agnostic real-time speech-to-speech
// ---------------------------------------------------------------------------

// VoiceProvider is the interface all speech-to-speech providers must implement.
// Providers handle model setup, health checks, and bidirectional audio sessions.
type VoiceProvider interface {
	// Name returns the provider identifier (e.g. "personaplex", "openai").
	Name() string
	// IsAvailable returns true if the provider is ready to start sessions.
	IsAvailable() bool
	// Setup downloads models or configures API keys.
	Setup(opts SetupOpts) error
	// Status returns detailed health information.
	Status() VoiceStatus
	// Transcribe converts audio bytes (WAV) to text. Used for non-streaming input.
	Transcribe(audioData []byte) (string, error)
	// StartSession opens a real-time bidirectional audio session.
	StartSession(ctx context.Context, opts VoiceSessionOpts) (*VoiceSession, error)
}

// SetupOpts configures provider setup (model download, API key, etc.).
type SetupOpts struct {
	ModelDir string // where to store model weights
	APIKey   string // for cloud providers
	Force    bool   // re-download even if present
}

// VoiceSessionOpts configures a voice session.
type VoiceSessionOpts struct {
	Language     string // ISO 639-1 (default "en")
	SystemPrompt string // persona/context for the S2S model
	SampleRate   int    // audio sample rate (default 24000 for S2S, 16000 for STT)
}

// VoiceSession represents an active bidirectional audio session.
type VoiceSession struct {
	// SendAudio sends a PCM audio chunk to the provider.
	SendAudio func(chunk []byte) error
	// RecvAudio returns a channel that receives PCM audio response chunks.
	RecvAudio <-chan []byte
	// RecvText returns a channel that receives transcribed/generated text.
	RecvText <-chan string
	// Close terminates the session.
	Close func() error
}

// VoiceStatus describes the current state of a voice provider.
type VoiceStatus struct {
	Provider     string `json:"provider"`
	Ready        bool   `json:"ready"`
	ModelPath    string `json:"modelPath,omitempty"`
	ModelSize    string `json:"modelSize,omitempty"`
	GPUAvailable bool   `json:"gpuAvailable"`
	GPUName      string `json:"gpuName,omitempty"`
	Endpoint     string `json:"endpoint,omitempty"`
	Error        string `json:"error,omitempty"`
}

// VoiceConfig holds configuration for the voice subsystem.
type VoiceConfig struct {
	S2SProvider         string `json:"s2s_provider,omitempty"`          // "personaplex", "openai"
	PersonaPlexModelDir string `json:"personaplex_model_dir,omitempty"` // default: ~/.yaver/models/personaplex
	OpenAIRealtimeKey   string `json:"openai_realtime_key,omitempty"`
	S2SPort             int    `json:"s2s_port,omitempty"`              // default: 19838
	AutoStart           bool   `json:"voice_auto_start,omitempty"`     // start voice server with agent
	Endpoint            string `json:"voice_endpoint,omitempty"`       // custom endpoint URL
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

var (
	voiceProviders   = map[string]VoiceProvider{}
	voiceProvidersMu sync.RWMutex
)

// RegisterVoiceProvider registers a voice provider by name.
func RegisterVoiceProvider(p VoiceProvider) {
	voiceProvidersMu.Lock()
	defer voiceProvidersMu.Unlock()
	voiceProviders[p.Name()] = p
}

// GetVoiceProvider returns a registered provider by name.
func GetVoiceProvider(name string) (VoiceProvider, bool) {
	voiceProvidersMu.RLock()
	defer voiceProvidersMu.RUnlock()
	p, ok := voiceProviders[name]
	return p, ok
}

// ListVoiceProviders returns all registered providers.
func ListVoiceProviders() []VoiceProvider {
	voiceProvidersMu.RLock()
	defer voiceProvidersMu.RUnlock()
	providers := make([]VoiceProvider, 0, len(voiceProviders))
	for _, p := range voiceProviders {
		providers = append(providers, p)
	}
	return providers
}

// ActiveVoiceProvider returns the configured provider, or nil if none.
func ActiveVoiceProvider(cfg *Config) VoiceProvider {
	if cfg == nil || cfg.Voice == nil || cfg.Voice.S2SProvider == "" {
		return nil
	}
	p, _ := GetVoiceProvider(cfg.Voice.S2SProvider)
	return p
}

// ---------------------------------------------------------------------------
// GPU detection helpers
// ---------------------------------------------------------------------------

// DetectGPU checks if a compatible GPU is available.
func DetectGPU() (available bool, name string) {
	// NVIDIA GPU via nvidia-smi
	if out, err := exec.Command("nvidia-smi", "--query-gpu=name", "--format=csv,noheader,nounits").Output(); err == nil {
		name := trimOutput(string(out))
		if name != "" {
			return true, "NVIDIA " + name
		}
	}

	// Apple Silicon MPS (macOS)
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		return true, "Apple Silicon (MPS)"
	}

	return false, ""
}

func trimOutput(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}

// VoiceModelDir returns the default directory for voice model storage.
func VoiceModelDir() string {
	dir, err := ConfigDir()
	if err != nil {
		return ""
	}
	return dir + "/models"
}

// ---------------------------------------------------------------------------
// Init — register built-in providers
// ---------------------------------------------------------------------------

func init() {
	RegisterVoiceProvider(&PersonaPlexProvider{})
	RegisterVoiceProvider(&OpenAIRealtimeProvider{})
}

// LogVoiceProviders logs all registered providers and their status.
func LogVoiceProviders() {
	providers := ListVoiceProviders()
	for _, p := range providers {
		status := p.Status()
		if status.Ready {
			log.Printf("[voice] %s: ready (gpu=%v)", p.Name(), status.GPUAvailable)
		} else if status.Error != "" {
			log.Printf("[voice] %s: not ready (%s)", p.Name(), status.Error)
		}
	}
}

// RecommendProvider returns a recommendation string for which provider to use.
func RecommendProvider() string {
	gpuAvail, gpuName := DetectGPU()
	if gpuAvail {
		return fmt.Sprintf("Recommended: personaplex (free, on-device, GPU detected: %s)\n"+
			"Alternative: openai (paid, cloud, OpenAI Realtime API)", gpuName)
	}
	return "Recommended: openai (cloud, no GPU needed)\n" +
		"Alternative: personaplex (free, but requires NVIDIA GPU or Apple Silicon)"
}
