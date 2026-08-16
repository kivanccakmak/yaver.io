package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

type agentUpdateStatus struct {
	CurrentVersion    string `json:"currentVersion"`
	LatestVersion     string `json:"latestVersion,omitempty"`
	UpdateAvailable   bool   `json:"updateAvailable"`
	AutoUpdateEnabled bool   `json:"autoUpdateEnabled"`
	Repo              string `json:"repo"`
	Updating          bool   `json:"updating"`

	// Why an available update has not installed itself.
	//
	// A producer with no consumer is not shipped (CLAUDE.md), and "an update
	// exists, auto-update is on, and nothing is happening" is exactly the kind
	// of silence a user reads as broken. These are that signal's consumer half:
	// a surface can render "v1.99.403 will install when your 2 running tasks
	// finish" instead of a version number with no explanation.
	//
	// Empty when nothing is being held back.
	Deferred       bool               `json:"deferred,omitempty"`
	DeferredReason string             `json:"deferredReason,omitempty"`
	DeferredCode   string             `json:"deferredCode,omitempty"`
	DeferredBusy   []updateBusyReason `json:"deferredBusy,omitempty"`
	// WillInstallBy is when the deferral ceiling expires and the update applies
	// regardless. Lets a surface promise an outer bound rather than "eventually".
	WillInstallBy string `json:"willInstallBy,omitempty"`
}

var runForcedAgentUpdate = func() {
	// An ATTENDED update: the owner asked for it now, by hand. It is not gated
	// on idle — see checkAutoUpdateGated. Clearing the tracker stops the
	// automatic path from continuing to report a hold that no longer exists.
	globalDeferredUpdates.Clear()
	cfg, _ := LoadConfig()
	checkAutoUpdate(forcedAutoUpdateConfig(cfg))
}

// latestAgentReleaseVersionFunc is a var so tests can stub it.
//
// Now npm-first with a GitHub fallback — see agent_version_source.go. This used
// to be one of THREE hand-rolled copies of the same GitHub call, which is how a
// fleet on a shared egress could 403 itself out of ever learning about a
// release.
var latestAgentReleaseVersionFunc = func() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	v, _, err := latestAgentVersion(ctx)
	return v, err
}

func buildAgentUpdateStatus(cfg *Config, updating bool) (*agentUpdateStatus, error) {
	latest, err := latestAgentReleaseVersionFunc()
	if err != nil {
		return nil, err
	}
	current := strings.TrimPrefix(version, "v")
	status := &agentUpdateStatus{
		CurrentVersion:    current,
		LatestVersion:     latest,
		AutoUpdateEnabled: shouldAutoUpdate(cfg),
		Repo:              updateRepo(),
		Updating:          updating,
	}
	currentSv := "v" + current
	latestSv := "v" + latest
	if semver.IsValid(currentSv) && semver.IsValid(latestSv) {
		status.UpdateAvailable = semver.Compare(latestSv, currentSv) > 0
	}

	// Report a hold ONLY while it is still true. The tracker keeps the last
	// decision so a surface polling between ticks still gets an answer, but a
	// stale "waiting for your tasks" on an idle box would be its own small lie.
	if d, ok := globalDeferredUpdates.Snapshot(); ok && !d.Apply && status.UpdateAvailable {
		if len(collectUpdateBusyReasons()) > 0 {
			status.Deferred = true
			status.DeferredReason = d.Reason
			status.DeferredCode = d.Code
			status.DeferredBusy = d.Busy
			if !d.ForceAt.IsZero() {
				status.WillInstallBy = d.ForceAt.UTC().Format(time.RFC3339)
			}
		}
	}
	return status, nil
}

func (s *HTTPServer) handleAgentUpdate(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := LoadConfig()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, err.Error())
			return
		}
		status, err := buildAgentUpdateStatus(cfg, s.agentUpdateRunning.Load())
		if err != nil {
			jsonError(w, http.StatusBadGateway, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, status)
	case http.MethodPost:
		if s.agentUpdateRunning.Load() {
			jsonError(w, http.StatusConflict, "update already in progress")
			return
		}
		cfg, err := LoadConfig()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, err.Error())
			return
		}
		status, err := buildAgentUpdateStatus(cfg, false)
		if err != nil {
			jsonError(w, http.StatusBadGateway, err.Error())
			return
		}
		if !status.UpdateAvailable {
			jsonReply(w, http.StatusOK, map[string]interface{}{
				"ok":              true,
				"started":         false,
				"message":         "already up to date",
				"currentVersion":  status.CurrentVersion,
				"latestVersion":   status.LatestVersion,
				"updateAvailable": false,
			})
			return
		}
		if !s.agentUpdateRunning.CompareAndSwap(false, true) {
			jsonError(w, http.StatusConflict, "update already in progress")
			return
		}
		go func() {
			defer s.agentUpdateRunning.Store(false)
			runForcedAgentUpdate()
		}()
		jsonReply(w, http.StatusAccepted, map[string]interface{}{
			"ok":              true,
			"started":         true,
			"message":         "update check started; the agent may disconnect briefly if it replaces itself and restarts",
			"currentVersion":  status.CurrentVersion,
			"latestVersion":   status.LatestVersion,
			"updateAvailable": true,
		})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "use GET or POST")
	}
}
