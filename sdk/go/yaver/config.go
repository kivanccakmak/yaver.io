package yaver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Config holds Yaver configuration. Compatible with ~/.yaver/config.json.
type Config struct {
	AuthToken         string               `json:"auth_token,omitempty"`
	DeviceID          string               `json:"device_id,omitempty"`
	ConvexSiteURL     string               `json:"convex_site_url,omitempty"`
	RelayPassword     string               `json:"relay_password,omitempty"`
	RelayServers      []RelayServerConfig  `json:"relay_servers,omitempty"`
	CloudflareTunnels []TunnelConfig       `json:"cloudflare_tunnels,omitempty"`
	Speech            *SpeechConfig        `json:"speech,omitempty"`
}

// RelayServerConfig describes a relay server.
type RelayServerConfig struct {
	ID       string `json:"id"`
	QuicAddr string `json:"quic_addr"`
	HttpURL  string `json:"http_url,omitempty"`
	Password string `json:"password,omitempty"`
	Region   string `json:"region,omitempty"`
	Priority int    `json:"priority,omitempty"`
	Label    string `json:"label,omitempty"`
}

// TunnelConfig describes a Cloudflare Tunnel.
type TunnelConfig struct {
	ID                   string `json:"id"`
	URL                  string `json:"url"`
	CFAccessClientId     string `json:"cf_access_client_id,omitempty"`
	CFAccessClientSecret string `json:"cf_access_client_secret,omitempty"`
	Label                string `json:"label,omitempty"`
	Priority             int    `json:"priority,omitempty"`
}

// SpeechConfig holds speech-to-text and TTS settings.
type SpeechConfig struct {
	Provider   string `json:"provider,omitempty"`    // "whisper", "openai", "deepgram", "assemblyai"
	APIKey     string `json:"api_key,omitempty"`
	TTSEnabled bool   `json:"tts_enabled,omitempty"`
}

// ConfigDir returns the path to ~/.yaver/.
func ConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".yaver")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// ConfigPath returns the full path to the config file.
func ConfigPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// LoadConfig reads the config file from disk.
func LoadConfig() (*Config, error) {
	p, err := ConfigPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &cfg, nil
}

// SaveConfig writes the config to disk.
func SaveConfig(cfg *Config) error {
	p, err := ConfigPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0600)
}

func jsonReader(data []byte) io.Reader {
	return bytes.NewReader(data)
}
