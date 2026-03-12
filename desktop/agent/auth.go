package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// convexBaseURL is the base URL for the Convex backend.
	// In production this would come from configuration.
	convexBaseURL = "https://api.yaver.io"

	httpTimeout = 10 * time.Second
)

var httpClient = &http.Client{Timeout: httpTimeout}

// ValidateToken checks the auth token against the Convex backend.
// Returns nil on success, an error otherwise.
func ValidateToken(token string) error {
	payload := map[string]string{"token": token}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal validate request: %w", err)
	}

	resp, err := httpClient.Post(
		convexBaseURL+"/auth/validate",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("validate token request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("validate token failed (status %d): %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// RegisterDeviceRequest contains the fields sent when registering a device.
type RegisterDeviceRequest struct {
	Token     string `json:"token"`
	DeviceID  string `json:"device_id"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	PublicKey string `json:"public_key"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
}

// RegisterDevice registers this desktop agent with the Convex backend.
func RegisterDevice(req RegisterDeviceRequest) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal register request: %w", err)
	}

	resp, err := httpClient.Post(
		convexBaseURL+"/devices/register",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("register device request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("register device failed (status %d): %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// SendHeartbeat sends a heartbeat to the Convex backend so the device stays
// marked as online.
func SendHeartbeat(token, deviceID string) error {
	payload := map[string]string{
		"token":     token,
		"device_id": deviceID,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}

	resp, err := httpClient.Post(
		convexBaseURL+"/devices/heartbeat",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("heartbeat request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("heartbeat failed (status %d): %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// MarkOffline tells the backend this device is going offline.
func MarkOffline(token, deviceID string) error {
	payload := map[string]string{
		"token":     token,
		"device_id": deviceID,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal offline: %w", err)
	}

	resp, err := httpClient.Post(
		convexBaseURL+"/devices/offline",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("offline request: %w", err)
	}
	defer resp.Body.Close()

	return nil
}
