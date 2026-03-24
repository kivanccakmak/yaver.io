package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"time"
)

const (
	openaiTranscribeURL = "https://api.openai.com/v1/audio/transcriptions"
	openaiRealtimeModel = "gpt-4o-realtime-preview"
)

// OpenAIRealtimeProvider implements VoiceProvider for OpenAI's Realtime API.
// Paid, cloud-hosted. No GPU required — audio is processed on OpenAI's servers.
type OpenAIRealtimeProvider struct {
	apiKey string
}

func (p *OpenAIRealtimeProvider) Name() string { return "openai" }

func (p *OpenAIRealtimeProvider) IsAvailable() bool {
	return p.loadAPIKey() != ""
}

func (p *OpenAIRealtimeProvider) Status() VoiceStatus {
	key := p.loadAPIKey()
	status := VoiceStatus{
		Provider:     "openai",
		GPUAvailable: false,
		GPUName:      "cloud (OpenAI servers)",
	}

	if key == "" {
		status.Error = "API key not configured. Run: yaver voice setup --provider openai"
		return status
	}

	status.Ready = true
	status.Endpoint = "api.openai.com/v1/realtime"
	return status
}

func (p *OpenAIRealtimeProvider) Setup(opts SetupOpts) error {
	key := opts.APIKey
	if key == "" {
		key = p.loadAPIKey()
	}
	if key == "" {
		return fmt.Errorf("OpenAI API key required.\n" +
			"Set it with: yaver config set voice.openai_realtime_key <your-key>\n" +
			"Get one at: https://platform.openai.com/api-keys")
	}

	// Validate key
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", "https://api.openai.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach OpenAI API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("invalid API key")
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("OpenAI API error (%d): %s", resp.StatusCode, string(body))
	}

	// Save key to config
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	if cfg.Voice == nil {
		cfg.Voice = &VoiceConfig{}
	}
	cfg.Voice.OpenAIRealtimeKey = key
	cfg.Voice.S2SProvider = "openai"
	if err := SaveConfig(cfg); err != nil {
		return err
	}

	fmt.Println("OpenAI Realtime API configured successfully.")
	fmt.Printf("Model: %s\n", openaiRealtimeModel)
	fmt.Println("Note: OpenAI Realtime API is billed per token. See https://openai.com/pricing")
	return nil
}

func (p *OpenAIRealtimeProvider) Transcribe(audioData []byte) (string, error) {
	key := p.loadAPIKey()
	if key == "" {
		return "", fmt.Errorf("OpenAI API key not configured")
	}

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return "", err
	}
	part.Write(audioData)
	writer.WriteField("model", "gpt-4o-mini-transcribe")
	writer.WriteField("language", "en")
	writer.Close()

	req, err := http.NewRequest("POST", openaiTranscribeURL, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("OpenAI transcription failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("OpenAI API error (%d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.Text, nil
}

func (p *OpenAIRealtimeProvider) StartSession(ctx context.Context, opts VoiceSessionOpts) (*VoiceSession, error) {
	key := p.loadAPIKey()
	if key == "" {
		return nil, fmt.Errorf("OpenAI API key not configured")
	}

	audioIn := make(chan []byte, 64)
	audioOut := make(chan []byte, 64)
	textOut := make(chan string, 64)

	sessionCtx, cancel := context.WithCancel(ctx)

	go p.streamLoop(sessionCtx, audioIn, audioOut, textOut)

	return &VoiceSession{
		SendAudio: func(chunk []byte) error {
			select {
			case audioIn <- chunk:
				return nil
			case <-sessionCtx.Done():
				return sessionCtx.Err()
			}
		},
		RecvAudio: audioOut,
		RecvText:  textOut,
		Close: func() error {
			cancel()
			close(audioIn)
			return nil
		},
	}, nil
}

func (p *OpenAIRealtimeProvider) streamLoop(ctx context.Context, audioIn <-chan []byte, audioOut chan<- []byte, textOut chan<- string) {
	defer close(audioOut)
	defer close(textOut)

	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-audioIn:
			if !ok {
				return
			}
			text, err := p.Transcribe(chunk)
			if err != nil {
				log.Printf("[voice/openai] Transcription error: %v", err)
				continue
			}
			if text != "" {
				textOut <- text
			}
		}
	}
}

func (p *OpenAIRealtimeProvider) loadAPIKey() string {
	if p.apiKey != "" {
		return p.apiKey
	}
	cfg, err := LoadConfig()
	if err != nil {
		return ""
	}
	if cfg.Voice != nil && cfg.Voice.OpenAIRealtimeKey != "" {
		return cfg.Voice.OpenAIRealtimeKey
	}
	if cfg.Speech != nil && cfg.Speech.Provider == "openai" && cfg.Speech.APIKey != "" {
		return cfg.Speech.APIKey
	}
	return ""
}
