package main

// vibing_webrtc_protocol.go defines the reliable control half of a Vibing
// WebRTC session. Video and DOM selection are one negotiated session, while
// HTTPS remains an explicit fallback for surfaces that cannot host an RTC data
// channel. The server-created "events" DataChannel is ordered/reliable by
// default and now works in both directions.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	vibingWebRTCProtocolVersion = 1
	vibingWebRTCMaxMessageBytes = 16 << 10
	vibingWebRTCAckCacheMax     = 128
	vibingWebRTCControlTimeout  = 10 * time.Second
	vibingWebRTCCoordinateMax   = 65535
)

const (
	vibingControlDOMMode   = "vibing.dom.mode"
	vibingControlDOMCursor = "vibing.dom.cursor"
	vibingControlDOMSelect = "vibing.dom.select"
)

type vibingWebRTCControlRequest struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Type    string `json:"type"`
	Project string `json:"project,omitempty"`
	WorkDir string `json:"workDir,omitempty"`
	Enabled bool   `json:"enabled,omitempty"`
	X       int    `json:"x,omitempty"`
	Y       int    `json:"y,omitempty"`
}

type vibingWebRTCControlError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type vibingWebRTCControlAck struct {
	Version int                       `json:"v"`
	ID      string                    `json:"id,omitempty"`
	Type    string                    `json:"type"`
	OK      bool                      `json:"ok"`
	Result  any                       `json:"result,omitempty"`
	Error   *vibingWebRTCControlError `json:"error,omitempty"`
}

type vibingWebRTCControlHandler func(context.Context, vibingWebRTCControlRequest) (any, *vibingWebRTCControlError)

type vibingWebRTCControlAckCacheEntry struct {
	Hash    [32]byte
	Payload string
}

func sendVibingWebRTCHello(dc *webrtc.DataChannel, sessionID string) {
	if dc == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"v":         vibingWebRTCProtocolVersion,
		"type":      "vibing.protocol",
		"sessionId": sessionID,
		"channel":   "events",
		"reliable":  true,
		"ordered":   true,
		"capabilities": []string{
			vibingControlDOMMode,
			vibingControlDOMCursor,
			vibingControlDOMSelect,
		},
		"fallback": map[string]string{
			vibingControlDOMMode:   "POST /vibing/preview/dom-mode",
			vibingControlDOMCursor: "POST /vibing/preview/cursor",
			vibingControlDOMSelect: "POST /vibing/preview/select",
		},
	})
	_ = dc.SendText(string(payload))
}

func (m *RemoteRuntimeManager) handleVibingWebRTCControlMessage(sessionID string, live *remoteRuntimeLiveState, dc *webrtc.DataChannel, raw []byte) {
	ack, cacheable := m.applyVibingWebRTCControl(sessionID, live, raw)
	payload, err := json.Marshal(ack)
	if err != nil {
		return
	}
	if cacheable && live != nil && ack.ID != "" {
		live.cacheVibingControlAck(ack.ID, sha256.Sum256(raw), string(payload))
	}
	if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		_ = dc.SendText(string(payload))
	}
}

func (m *RemoteRuntimeManager) applyVibingWebRTCControl(sessionID string, live *remoteRuntimeLiveState, raw []byte) (vibingWebRTCControlAck, bool) {
	fail := func(id, code, message string, retryable bool) (vibingWebRTCControlAck, bool) {
		return vibingWebRTCControlAck{
			Version: vibingWebRTCProtocolVersion,
			ID:      id,
			Type:    "vibing.ack",
			OK:      false,
			Error:   &vibingWebRTCControlError{Code: code, Message: message, Retryable: retryable},
		}, id != ""
	}
	if len(raw) == 0 || len(raw) > vibingWebRTCMaxMessageBytes {
		return fail("", "vibing.control.message_too_large", "control message must be 1-16384 bytes", false)
	}
	var req vibingWebRTCControlRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return fail("", "vibing.control.invalid_json", "invalid control JSON", false)
	}
	req.ID = strings.TrimSpace(req.ID)
	req.Type = strings.TrimSpace(req.Type)
	req.Project = strings.TrimSpace(req.Project)
	req.WorkDir = strings.TrimSpace(req.WorkDir)
	if req.ID == "" || len(req.ID) > 128 {
		return fail("", "vibing.control.invalid_id", "id is required and must be at most 128 bytes", false)
	}
	hash := sha256.Sum256(raw)
	if cached, ok := live.cachedVibingControlAck(req.ID); ok {
		if cached.Hash != hash {
			ack, _ := fail(req.ID, "vibing.control.id_conflict", "id was already used for a different control message", false)
			return ack, false
		}
		var ack vibingWebRTCControlAck
		if json.Unmarshal([]byte(cached.Payload), &ack) == nil {
			return ack, false
		}
	}
	if req.Version != vibingWebRTCProtocolVersion {
		return fail(req.ID, "vibing.control.unsupported_version", fmt.Sprintf("protocol version %d is unsupported; use %d", req.Version, vibingWebRTCProtocolVersion), false)
	}
	switch req.Type {
	case vibingControlDOMMode, vibingControlDOMCursor, vibingControlDOMSelect:
	default:
		return fail(req.ID, "vibing.control.unsupported_type", "unsupported Vibing control type", false)
	}
	if req.Project == "" || len(req.Project) > 256 || len(req.WorkDir) > 4096 ||
		req.X < 0 || req.Y < 0 || req.X > vibingWebRTCCoordinateMax || req.Y > vibingWebRTCCoordinateMax {
		return fail(req.ID, "vibing.control.invalid_argument", "project and non-negative bounded coordinates are required", false)
	}

	m.mu.RLock()
	handler := m.vibingControl
	m.mu.RUnlock()
	if handler == nil {
		return fail(req.ID, "vibing.control.unavailable", "this agent has no Vibing control handler", true)
	}
	if live != nil {
		if !live.controlMu.TryLock() {
			ack, _ := fail(req.ID, "vibing.control.busy", "another Vibing control is still running", true)
			return ack, false
		}
		defer live.controlMu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), vibingWebRTCControlTimeout)
	defer cancel()
	type controlResult struct {
		value any
		err   *vibingWebRTCControlError
	}
	resultCh := make(chan controlResult, 1)
	go func() {
		value, controlErr := handler(ctx, req)
		resultCh <- controlResult{value: value, err: controlErr}
	}()
	select {
	case result := <-resultCh:
		if result.err != nil {
			return vibingWebRTCControlAck{Version: vibingWebRTCProtocolVersion, ID: req.ID, Type: "vibing.ack", OK: false, Error: result.err}, true
		}
		return vibingWebRTCControlAck{Version: vibingWebRTCProtocolVersion, ID: req.ID, Type: "vibing.ack", OK: true, Result: result.value}, true
	case <-ctx.Done():
		// Cache the timeout acknowledgement under this request ID. The browser
		// operation may be unwinding asynchronously; replaying the same ID must
		// never execute a second click while its outcome is unknown.
		return fail(req.ID, "vibing.control.timeout", "Vibing control exceeded its 10-second deadline", true)
	}
}

func (live *remoteRuntimeLiveState) cachedVibingControlAck(id string) (vibingWebRTCControlAckCacheEntry, bool) {
	if live == nil {
		return vibingWebRTCControlAckCacheEntry{}, false
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	entry, ok := live.controlAcks[id]
	return entry, ok
}

func (live *remoteRuntimeLiveState) cacheVibingControlAck(id string, hash [32]byte, payload string) {
	if live == nil || id == "" {
		return
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	if live.controlAcks == nil {
		live.controlAcks = make(map[string]vibingWebRTCControlAckCacheEntry)
	}
	if _, exists := live.controlAcks[id]; !exists {
		live.controlOrder = append(live.controlOrder, id)
	}
	live.controlAcks[id] = vibingWebRTCControlAckCacheEntry{Hash: hash, Payload: payload}
	for len(live.controlOrder) > vibingWebRTCAckCacheMax {
		oldest := live.controlOrder[0]
		live.controlOrder = live.controlOrder[1:]
		delete(live.controlAcks, oldest)
	}
}

func (s *HTTPServer) handleVibingWebRTCControl(_ context.Context, req vibingWebRTCControlRequest) (any, *vibingWebRTCControlError) {
	if s == nil || s.vibePreviewMgr == nil {
		return nil, &vibingWebRTCControlError{Code: "vibing.preview.unavailable", Message: "Vibing preview is not initialised", Retryable: true}
	}
	switch req.Type {
	case vibingControlDOMMode:
		workDir, err := s.vibePreviewMgr.SetDomMode(req.Project, req.Enabled, req.WorkDir)
		if err != nil {
			return nil, classifyVibingWebRTCControlError(err)
		}
		return map[string]any{"enabled": req.Enabled, "workDir": workDir}, nil
	case vibingControlDOMCursor:
		if err := s.vibePreviewMgr.MoveCursor(req.Project, req.X, req.Y); err != nil {
			return nil, classifyVibingWebRTCControlError(err)
		}
		return map[string]any{"x": req.X, "y": req.Y}, nil
	case vibingControlDOMSelect:
		el, err := s.vibePreviewMgr.SelectElement(req.Project, req.X, req.Y, req.WorkDir, time.Now())
		if err != nil {
			return nil, classifyVibingWebRTCControlError(err)
		}
		return map[string]any{
			"element": el, "summary": el.Summary(), "capturedAt": el.CapturedAt,
			"meta": s.vibePreviewMgr.SelectMeta(req.Project),
		}, nil
	default:
		return nil, &vibingWebRTCControlError{Code: "vibing.control.unsupported_type", Message: "unsupported Vibing control type", Retryable: false}
	}
}

func classifyVibingWebRTCControlError(err error) *vibingWebRTCControlError {
	message := err.Error()
	switch {
	case strings.Contains(message, "no preview session"):
		return &vibingWebRTCControlError{Code: "vibing.preview.session_missing", Message: message, Retryable: true}
	case strings.Contains(message, "cannot dispatch input"):
		return &vibingWebRTCControlError{Code: "vibing.preview.input_unavailable", Message: message, Retryable: false}
	case strings.Contains(message, "workDir"), strings.Contains(message, "coordinates"):
		return &vibingWebRTCControlError{Code: "vibing.control.invalid_argument", Message: message, Retryable: false}
	default:
		return &vibingWebRTCControlError{Code: "vibing.preview.control_failed", Message: message, Retryable: true}
	}
}
