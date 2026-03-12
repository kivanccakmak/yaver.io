package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// newBearerRequest creates an HTTP request with Authorization: Bearer header.
func newBearerRequest(method, url, token string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

const (
	httpTimeout = 10 * time.Second
)

var httpClient = &http.Client{Timeout: httpTimeout}

// ValidateToken checks the auth token against the Convex backend.
// Returns nil on success, an error otherwise.
func ValidateToken(baseURL, token string) error {
	req, err := newBearerRequest("GET", baseURL+"/auth/validate", token, nil)
	if err != nil {
		return fmt.Errorf("create validate request: %w", err)
	}

	resp, err := httpClient.Do(req)
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

// ValidateTokenUser checks the auth token against Convex and returns the userId.
func ValidateTokenUser(baseURL, token string) (string, error) {
	req, err := newBearerRequest("GET", baseURL+"/auth/validate", token, nil)
	if err != nil {
		return "", fmt.Errorf("create validate request: %w", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("validate token request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("validate token failed (status %d)", resp.StatusCode)
	}

	var result struct {
		User struct {
			UserID string `json:"userId"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode validate response: %w", err)
	}
	return result.User.UserID, nil
}

// RegisterDeviceRequest contains the fields sent when registering a device.
type RegisterDeviceRequest struct {
	Token     string `json:"-"`
	DeviceID  string `json:"deviceId"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	PublicKey string `json:"publicKey"`
	QuicHost  string `json:"quicHost"`
	QuicPort  int    `json:"quicPort"`
}

// RegisterDevice registers this desktop agent with the Convex backend.
func RegisterDevice(baseURL string, r RegisterDeviceRequest) error {
	body, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("marshal register request: %w", err)
	}

	req, err := newBearerRequest("POST", baseURL+"/devices/register", r.Token, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create register request: %w", err)
	}

	resp, err := httpClient.Do(req)
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
func SendHeartbeat(baseURL, token, deviceID string) error {
	payload := map[string]string{"deviceId": deviceID}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}

	req, err := newBearerRequest("POST", baseURL+"/devices/heartbeat", token, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create heartbeat request: %w", err)
	}

	resp, err := httpClient.Do(req)
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
func MarkOffline(baseURL, token, deviceID string) error {
	payload := map[string]string{"deviceId": deviceID}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal offline: %w", err)
	}

	req, err := newBearerRequest("POST", baseURL+"/devices/offline", token, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create offline request: %w", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("offline request: %w", err)
	}
	defer resp.Body.Close()

	return nil
}
