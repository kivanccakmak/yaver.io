package main

// project_start.go — one cross-surface entry point for starting something.
//
// Phone, web, desktop GUI, TV, car, watch, and spatial surfaces have wildly
// different input affordances, but they must not invent different project
// semantics. POST /project/start owns the common operation:
//
//   name + Git destination + palette -> initialized project -> hidden kickoff
//   -> first visible Developing turn is the agent asking what it should do.
//
// Rich surfaces may still drive /project/wizard/* when they need advanced
// choices. Constrained surfaces call this route and continue in the ordinary
// task conversation.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type projectStartRequest struct {
	Name        string `json:"name"`
	GitProvider string `json:"gitProvider"`
	Palette     string `json:"palette,omitempty"`
}

var projectStartPalettes = map[string][4]string{
	"ocean":    {"#075985", "#0EA5E9", "#67E8F9", "#F0F9FF"},
	"electric": {"#7557FF", "#34D6FF", "#FF4FD8", "#11111A"},
	"forest":   {"#14532D", "#22C55E", "#A3E635", "#F7FEE7"},
	"sunset":   {"#C2410C", "#FB7185", "#FBBF24", "#FFF7ED"},
	"mono":     {"#111827", "#4B5563", "#D1D5DB", "#FFFFFF"},
	"lavender": {"#6D28D9", "#A78BFA", "#F0ABFC", "#FAF5FF"},
}

func normalizeProjectStartGitProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "github":
		return "github"
	case "gitlab":
		return "gitlab"
	default:
		return "yaver-git"
	}
}

func projectStartPrompt(name, palette string, colors [4]string) string {
	paletteName := palette
	if palette != "" {
		paletteName = strings.ToUpper(palette[:1]) + palette[1:]
	}
	return strings.Join([]string{
		"I want to build a new app in this initialized Yaver project. Start by asking me what it should do, then work with me in this chat and render as you build.",
		fmt.Sprintf("Use the %s palette as the initial visual direction: %s.", paletteName, strings.Join(colors[:], ", ")),
		"Yaver Serverless is already initialized as the default backend. Infer the product structure, data model, auth, navigation, permissions, surfaces, and implementation details from my intent. Do not turn this into a questionnaire or ask whether the app needs a backend. Ask only when a consequential choice genuinely cannot be inferred.",
		"This project may be continued from phone, web, desktop, TV, car, watch, or AR/VR. Keep the Developing conversation and render intent consistent across them.",
	}, "\n\n")
}

func (s *HTTPServer) handleProjectStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body projectStartRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		jsonError(w, http.StatusBadRequest, "name is required before starting a project")
		return
	}
	provider := normalizeProjectStartGitProvider(body.GitProvider)
	palette := strings.ToLower(strings.TrimSpace(body.Palette))
	colors, ok := projectStartPalettes[palette]
	if !ok {
		palette = "ocean"
		colors = projectStartPalettes[palette]
	}

	// Refuse before writing files when the selected provider cannot perform the
	// same read-only query its create path depends on.
	if provider == "github" || provider == "gitlab" {
		probe := probeGitProviderOperation(provider)
		if !probe.Ready {
			jsonReply(w, http.StatusPreconditionFailed, map[string]interface{}{
				"ok": false, "code": "project_start.git_not_ready", "error": probe.Detail,
				"action": map[string]string{"method": http.MethodPost, "path": "/git/provider/oauth/start", "label": "Connect " + provider},
			})
			return
		}
	}

	sess, _ := StartWizard()
	answer := func(id, value string) { _, _ = AnswerWizard(sess.ID, id, value) }
	slug := projectSlugForStart(body.Name)
	answer("app_name", body.Name)
	answer("slug", slug)
	answer("description", body.Name+" app")
	answer("primary_color", colors[0])
	answer("secondary_color", colors[1])
	answer("accent_color", colors[2])
	answer("surface_color", colors[3])
	answer("tone", "system")
	answer("include_web", "false")
	answer("include_mobile", "true")
	answer("include_backend", "true")
	answer("include_landing", "false")
	answer("backend", "sqlite")
	answer("mobile_stack", "expo-rn")
	answer("git_provider", provider)
	answer("git_visibility", "private")
	answer("git_repo_name", slug)
	answer("confirm", "true")
	finishWizardWithDefaults(sess)

	generated, err := GenerateProject(sess.ID, "")
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	prompt := projectStartPrompt(body.Name, palette, colors)
	task, err := s.taskMgr.CreateTaskWithOptions(body.Name, prompt, "", "project-start", "", "", nil, TaskCreateOptions{
		SessionStartedFrom:      "new-application",
		StartedFromSurface:      sessionSurfaceFromRequest(r),
		WorkDir:                 generated.Directory,
		ProjectName:             body.Name,
		InitialUserPrompt:       prompt,
		InitialUserPromptHidden: true,
		IncludeYaverMcp:         true,
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "project was initialized but Developing could not start: "+err.Error())
		return
	}
	jsonReply(w, http.StatusCreated, map[string]interface{}{
		"ok": true, "directory": generated.Directory, "gitProvider": provider,
		"palette": palette, "task": s.taskInfoFromTask(task, r),
	})
}

func projectSlugForStart(name string) string {
	slug := Slugify(name)
	if slug == "" {
		return "new-project"
	}
	return slug
}
