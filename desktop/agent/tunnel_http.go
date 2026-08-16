package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// handleTunnels handles POST /tunnels (create) and GET /tunnels (list).
func (s *HTTPServer) handleTunnels(w http.ResponseWriter, r *http.Request) {
	if s.tunnelMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "tunnels not available"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		tunnels := s.tunnelMgr.ListTunnels()
		jsonReply(w, http.StatusOK, tunnels)

	case http.MethodPost:
		var req struct {
			Port     int    `json:"port"`
			Protocol string `json:"protocol"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if req.Port <= 0 {
			jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing port"})
			return
		}
		tunnel, err := s.tunnelMgr.CreateTunnel(req.Port, req.Protocol)
		if err != nil {
			jsonReply(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		jsonReply(w, http.StatusOK, tunnel)

	default:
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleTunnelByID handles GET/DELETE /tunnels/{id} and sub-routes.
func (s *HTTPServer) handleTunnelByID(w http.ResponseWriter, r *http.Request) {
	if s.tunnelMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "tunnels not available"})
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/tunnels/")
	parts := strings.SplitN(path, "/", 2)
	tunnelID := parts[0]

	if tunnelID == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing tunnel ID"})
		return
	}

	// Sub-routes
	if len(parts) > 1 {
		switch parts[1] {
		case "connect":
			s.tunnelMgr.HandleTunnelConnect(w, r, tunnelID)
			return
		case "input":
			if r.Method != http.MethodPost {
				jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			}
			var req struct {
				Input string `json:"input"`
			}
			json.NewDecoder(r.Body).Decode(&req)
			if err := s.tunnelMgr.SendInput(tunnelID, req.Input); err != nil {
				jsonReply(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			jsonReply(w, http.StatusOK, map[string]string{"ok": "true"})
			return
		}
	}

	tunnel, ok := s.tunnelMgr.GetTunnel(tunnelID)
	if !ok {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": "tunnel not found"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		jsonReply(w, http.StatusOK, tunnel)
	case http.MethodDelete:
		s.tunnelMgr.CloseTunnel(tunnelID)
		jsonReply(w, http.StatusOK, map[string]string{"ok": "true"})
	default:
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}
