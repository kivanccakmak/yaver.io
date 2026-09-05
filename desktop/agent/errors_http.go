package main

// errors_http.go — HTTP surface for the cross-device errors
// ledger. Backed by errors_store.go's GlobalErrorStore so the
// mobile "Errors" tab and the MCP tools see the same data.
//
// Routes (registered in httpserver.go):
//
//   GET  /errors                 — list open errors (or all with
//                                  ?include_resolved=1)
//   GET  /errors/stats           — dashboard header counters
//   GET  /errors/detail?fp=<fp>  — single record with recent
//                                  samples
//   POST /errors/resolve         — {"fingerprint": "x",
//                                  "note": "optional"}
//   POST /errors/reopen          — {"fingerprint": "x"}
//   POST /errors/fix             — create a coding task from the captured cause

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func (s *HTTPServer) handleErrors(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	store := s.yaverErrorStore()
	if store == nil {
		jsonError(w, http.StatusInternalServerError, "error store unavailable")
		return
	}
	includeResolved := r.URL.Query().Get("include_resolved") == "1"
	records := store.List(includeResolved)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"errors": records,
		"stats":  store.Stats(),
	})
}

func (s *HTTPServer) handleErrorsStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	store := s.yaverErrorStore()
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"stats": store.Stats(),
	})
}

func (s *HTTPServer) handleErrorsDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	fp := r.URL.Query().Get("fp")
	if fp == "" {
		jsonError(w, http.StatusBadRequest, "fp required")
		return
	}
	rec := s.yaverErrorStore().Get(fp)
	if rec == nil {
		jsonError(w, http.StatusNotFound, "fingerprint not found")
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"error": rec,
	})
}

func (s *HTTPServer) handleErrorsResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
		Note        string `json:"note,omitempty"`
		Resolved    *bool  `json:"resolved,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(body.Fingerprint) == "" {
		jsonError(w, http.StatusBadRequest, "fingerprint required")
		return
	}
	var changed bool
	if body.Resolved != nil && !*body.Resolved {
		changed = s.yaverErrorStore().Reopen(body.Fingerprint)
	} else {
		changed = s.yaverErrorStore().MarkResolved(body.Fingerprint, body.Note)
	}
	if !changed {
		jsonError(w, http.StatusNotFound, "fingerprint not found")
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (s *HTTPServer) handleErrorsFix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	if s.taskMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]interface{}{
			"ok": false, "code": "error.fix.runner_unavailable",
			"error": "The coding task manager is unavailable on this agent. Restart the Yaver agent, then retry Fix with AI.",
		})
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
		WorkDir     string `json:"workDir,omitempty"`
		ProjectName string `json:"projectName,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	body.Fingerprint = strings.TrimSpace(body.Fingerprint)
	if body.Fingerprint == "" {
		jsonError(w, http.StatusBadRequest, "fingerprint required")
		return
	}
	rec := s.yaverErrorStore().Get(body.Fingerprint)
	if rec == nil {
		jsonError(w, http.StatusNotFound, "fingerprint not found")
		return
	}
	workDir := firstNonEmpty(strings.TrimSpace(body.WorkDir), strings.TrimSpace(rec.ProjectPath))
	projectName := firstNonEmpty(strings.TrimSpace(body.ProjectName), strings.TrimSpace(rec.ProjectName))
	if workDir == "" && projectName == "" {
		jsonReply(w, http.StatusUnprocessableEntity, map[string]interface{}{
			"ok": false, "code": "error.fix.project_required",
			"error": "This capture has no project identity. Reproduce it from Dogfood after selecting a project, then retry Fix with AI.",
		})
		return
	}

	prompt := buildCapturedErrorFixPrompt(rec)
	task, err := s.taskMgr.CreateTaskWithOptions(
		"Fix "+rec.Code,
		"",
		"", // empty model/runner deliberately inherit the Yaver global selection
		"error-fix",
		"",
		"",
		nil,
		TaskCreateOptions{
			WorkDir:            workDir,
			ProjectName:        projectName,
			InitialUserPrompt:  "Fix this captured error",
			PromptText:         prompt,
			SessionStartedFrom: "tasks",
			StartedFromSurface: "mobile-monitor",
			IncludeYaverMcp:    true,
		},
	)
	if err != nil {
		jsonReply(w, http.StatusUnprocessableEntity, map[string]interface{}{
			"ok": false, "code": "error.fix.task_start_failed",
			"error": fmt.Sprintf("Fix with AI could not start: %v", err),
		})
		return
	}
	jsonReply(w, http.StatusCreated, map[string]interface{}{
		"ok": true, "taskId": task.ID, "status": task.Status,
		"runnerId": task.RunnerID, "model": task.Model,
	})
}

func buildCapturedErrorFixPrompt(rec *ErrorRecord) string {
	var b strings.Builder
	b.WriteString("Fix this Yaver-captured application error. Diagnose the root cause, implement the smallest durable fix, and add a regression test that fails without it. Respect the repository AGENTS.md and run the relevant checks.\n\n")
	b.WriteString("Structured cause: ")
	b.WriteString(rec.Code)
	b.WriteString("\nMessage: ")
	b.WriteString(rec.Message)
	if rec.ProjectName != "" {
		b.WriteString("\nProject: ")
		b.WriteString(rec.ProjectName)
	}
	if len(rec.Stack) > 0 {
		b.WriteString("\nStack:\n")
		for i, line := range rec.Stack {
			if i == 12 {
				break
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func (s *HTTPServer) handleErrorsReopen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !s.yaverErrorStore().Reopen(body.Fingerprint) {
		jsonError(w, http.StatusNotFound, "fingerprint not found")
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (s *HTTPServer) yaverErrorStore() *ErrorStore {
	if s != nil && s.errorStore != nil {
		return s.errorStore
	}
	return GlobalErrorStore()
}
