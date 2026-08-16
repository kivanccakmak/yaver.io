package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterManagedRunnerUsesWorkloadBearer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cloud/runners/register" || r.Header.Get("Authorization") != "Bearer workload-secret" {
			http.Error(w, "unexpected request", http.StatusUnauthorized)
			return
		}
		var body ManagedRunnerRegistrationRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DeviceID != "runner-1" || body.ProtocolVersion != managedRunnerProtocolVersion {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(ManagedRunnerRegistrationResponse{DeviceID: "document-id", OwnerUserID: "owner-1"})
	}))
	defer server.Close()

	result, err := RegisterManagedRunner(server.URL, "workload-secret", ManagedRunnerRegistrationRequest{
		DeviceID: "runner-1", ProtocolVersion: managedRunnerProtocolVersion,
	})
	if err != nil || result.OwnerUserID != "owner-1" {
		t.Fatalf("registration = %#v, err = %v", result, err)
	}
}

func TestManagedRunnerRejectsGlobalTaskCreation(t *testing.T) {
	server := &HTTPServer{managed: true}
	recorder := httptest.NewRecorder()
	server.handleTasks(recorder, httptest.NewRequest(http.MethodPost, "/tasks", nil))
	if recorder.Code != http.StatusGone {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}
