package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Installable phone projects are ordinary standards-based web apps. They are
// deliberately served by the same runtime that already owns the sandbox and
// /data APIs: no TestFlight, Play upload, WebView or second backend is involved.
// Publishing snapshots the last-good portable app spec; it never renders live
// edits or reloads a user's installed app while a coding turn is in progress.

const phoneWebInstallVersion = 1

var phoneWebHexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

var phoneWebIcons = map[string]bool{
	"spark": true, "check": true, "note": true, "grid": true,
	"heart": true, "bolt": true, "leaf": true, "rocket": true,
}

type PhoneWebInstallState struct {
	Version         int           `yaml:"version" json:"version"`
	Brand           PhoneAppBrand `yaml:"brand" json:"brand"`
	ActiveRelease   string        `yaml:"activeRelease,omitempty" json:"activeRelease,omitempty"`
	PreviousRelease string        `yaml:"previousRelease,omitempty" json:"previousRelease,omitempty"`
	ContentHash     string        `yaml:"contentHash,omitempty" json:"contentHash,omitempty"`
	PublishedAt     string        `yaml:"publishedAt,omitempty" json:"publishedAt,omitempty"`
}

type PhoneWebRelease struct {
	Version    int           `json:"version"`
	ID         string        `json:"id"`
	ReleasedAt string        `json:"releasedAt"`
	Project    *PhoneProject `json:"project"`
	Brand      PhoneAppBrand `json:"brand"`
}

type PhoneWebPreflightResult struct {
	OK           bool            `json:"ok"`
	Code         string          `json:"code"`
	Message      string          `json:"message"`
	Remedy       *PhoneWebRemedy `json:"remedy,omitempty"`
	Fix          *GapFix         `json:"fix,omitempty"`
	PrimaryTable string          `json:"primaryTable,omitempty"`
	Brand        PhoneAppBrand   `json:"brand"`
}

type PhoneWebRemedy struct {
	Label  string `json:"label"`
	Method string `json:"method"`
	Path   string `json:"path"`
}

type PhoneWebInstallStatus struct {
	Published          bool          `json:"published"`
	AppPath            string        `json:"appPath,omitempty"`
	ActiveRelease      string        `json:"activeRelease,omitempty"`
	PreviousRelease    string        `json:"previousRelease,omitempty"`
	PublishedAt        string        `json:"publishedAt,omitempty"`
	CanRollback        bool          `json:"canRollback"`
	Brand              PhoneAppBrand `json:"brand"`
	PendingEnrollments int           `json:"pendingEnrollments"`
	Installations      int           `json:"installations"`
}

type phoneWebEnrollment struct {
	ID          string
	Slug        string
	Code        string
	SecretHash  string
	CreatedAt   time.Time
	ApprovedRaw string
	TokenID     string
}

var phoneWebEnrollments = struct {
	sync.Mutex
	items map[string]*phoneWebEnrollment
}{items: map[string]*phoneWebEnrollment{}}

func phoneWebInstallPath(dir string) string {
	return filepath.Join(dir, ".yaver", "web-install.yaml")
}

func phoneWebReleaseDir(dir string) string {
	return filepath.Join(dir, ".yaver", "web-releases")
}

func defaultPhoneAppBrand(p *PhoneProject) PhoneAppBrand {
	brand := PhoneAppBrand{
		DisplayName:    p.Name,
		Icon:           "spark",
		Palette:        "indigo",
		PrimaryColor:   "#6C5CE7",
		SecondaryColor: "#A29BFE",
	}
	if p.App != nil && p.App.Brand != nil {
		mergePhoneAppBrand(&brand, *p.App.Brand)
	}
	return normalizePhoneAppBrand(brand, p.Name)
}

func mergePhoneAppBrand(dst *PhoneAppBrand, src PhoneAppBrand) {
	if strings.TrimSpace(src.DisplayName) != "" {
		dst.DisplayName = strings.TrimSpace(src.DisplayName)
	}
	if strings.TrimSpace(src.Icon) != "" {
		dst.Icon = strings.TrimSpace(src.Icon)
	}
	if strings.TrimSpace(src.Palette) != "" {
		dst.Palette = strings.TrimSpace(src.Palette)
	}
	if strings.TrimSpace(src.PrimaryColor) != "" {
		dst.PrimaryColor = strings.TrimSpace(src.PrimaryColor)
	}
	if strings.TrimSpace(src.SecondaryColor) != "" {
		dst.SecondaryColor = strings.TrimSpace(src.SecondaryColor)
	}
}

func normalizePhoneAppBrand(b PhoneAppBrand, fallbackName string) PhoneAppBrand {
	b.DisplayName = strings.TrimSpace(b.DisplayName)
	if b.DisplayName == "" {
		b.DisplayName = strings.TrimSpace(fallbackName)
	}
	if len([]rune(b.DisplayName)) > 48 {
		b.DisplayName = string([]rune(b.DisplayName)[:48])
	}
	b.Icon = strings.ToLower(strings.TrimSpace(b.Icon))
	if !phoneWebIcons[b.Icon] {
		b.Icon = "spark"
	}
	b.Palette = strings.ToLower(strings.TrimSpace(b.Palette))
	if b.Palette == "" {
		b.Palette = "indigo"
	}
	if !phoneWebHexColor.MatchString(b.PrimaryColor) {
		b.PrimaryColor = "#6C5CE7"
	}
	if !phoneWebHexColor.MatchString(b.SecondaryColor) {
		b.SecondaryColor = "#A29BFE"
	}
	return b
}

func loadPhoneWebInstall(p *PhoneProject) (*PhoneWebInstallState, error) {
	b, err := os.ReadFile(phoneWebInstallPath(p.Dir))
	if err != nil {
		if os.IsNotExist(err) {
			return &PhoneWebInstallState{Version: phoneWebInstallVersion, Brand: defaultPhoneAppBrand(p)}, nil
		}
		return nil, err
	}
	var st PhoneWebInstallState
	if err := yaml.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("parse web install state: %w", err)
	}
	st.Version = phoneWebInstallVersion
	st.Brand = normalizePhoneAppBrand(st.Brand, p.Name)
	return &st, nil
}

func savePhoneWebInstall(p *PhoneProject, st *PhoneWebInstallState) error {
	st.Version = phoneWebInstallVersion
	b, err := yaml.Marshal(st)
	if err != nil {
		return err
	}
	return atomicPhoneWebWrite(phoneWebInstallPath(p.Dir), b, 0o600)
}

func atomicPhoneWebWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".web-install-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func phoneWebPrimaryTable(p *PhoneProject) string {
	// App metadata can legitimately lag behind schema edits. A stale
	// primaryEntity used to leave an otherwise renderable Home Screen app in a
	// permanent preflight failure (and the runtime repeated the same stale
	// choice). Resolve only names that exist in the current schema, then fall
	// back to the first real table. PublishPhoneWebApp persists this resolved
	// value so every renderer consumes the same answer.
	hasTable := func(name string) bool {
		if p.Schema == nil || strings.TrimSpace(name) == "" {
			return false
		}
		for _, table := range p.Schema.Tables {
			if table.Name == strings.TrimSpace(name) {
				return true
			}
		}
		return false
	}
	if p.App != nil {
		if hasTable(p.App.PrimaryEntity) {
			return strings.TrimSpace(p.App.PrimaryEntity)
		}
		for _, screen := range p.App.Screens {
			if hasTable(screen.Table) {
				return strings.TrimSpace(screen.Table)
			}
		}
	}
	if p.Schema != nil && len(p.Schema.Tables) > 0 {
		return p.Schema.Tables[0].Name
	}
	return ""
}

func PreflightPhoneWebApp(slug string, override *PhoneAppBrand) (*PhoneWebPreflightResult, error) {
	p, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	brand := defaultPhoneAppBrand(p)
	if st, e := loadPhoneWebInstall(p); e == nil {
		brand = st.Brand
	}
	if override != nil {
		mergePhoneAppBrand(&brand, *override)
	}
	brand = normalizePhoneAppBrand(brand, p.Name)
	remedy := func(code, msg, label, method, path string) *PhoneWebPreflightResult {
		body := map[string]interface{}{"slug": slug}
		if path == "/phone/projects/schema" {
			schema := p.Schema
			if schema == nil || len(schema.Tables) == 0 {
				schema = templateSchema("crud")
			}
			body["schema"] = schema
		} else if path == "/phone/projects/install/publish" {
			body["brand"] = brand
		}
		return &PhoneWebPreflightResult{
			OK: false, Code: code, Message: msg, Brand: brand,
			Remedy: &PhoneWebRemedy{Label: label, Method: method, Path: path},
			Fix:    &GapFix{Label: label, Method: method, Path: path, Body: body, Instant: true, Retry: true},
		}
	}
	if p.Schema == nil || len(p.Schema.Tables) == 0 {
		return remedy("web_install_schema_missing", "This app has no data table to render yet.", "Add a table", "POST", "/phone/projects/schema"), nil
	}
	primary := phoneWebPrimaryTable(p)
	found := false
	for _, table := range p.Schema.Tables {
		if table.Name == primary {
			found = true
			break
		}
	}
	if !found {
		return remedy("web_install_primary_table_missing", fmt.Sprintf("The app points at %q, but that table does not exist.", primary), "Choose a valid primary table", "POST", "/phone/projects/schema"), nil
	}
	// Build the real outputs here, not a proxy inventory check. A broken PNG
	// encoder or malformed snapshot must fail before the publish button lies.
	if _, err := buildPhoneWebIcon(brand, 180); err != nil {
		return remedy("web_install_icon_build_failed", "The Home Screen icon could not be built: "+err.Error(), "Choose another icon", "POST", "/phone/projects/install/publish"), nil
	}
	return &PhoneWebPreflightResult{OK: true, Code: "web_install_ready", Message: "Ready to publish as a Home Screen web app.", PrimaryTable: primary, Brand: brand}, nil
}

func PublishPhoneWebApp(slug string, override *PhoneAppBrand) (*PhoneWebInstallStatus, error) {
	pre, err := PreflightPhoneWebApp(slug, override)
	if err != nil {
		return nil, err
	}
	if !pre.OK {
		return nil, &phoneWebPreflightError{result: pre}
	}
	p, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	st, err := loadPhoneWebInstall(p)
	if err != nil {
		return nil, err
	}
	st.Brand = pre.Brand
	// Persist the same identity in app.yaml so browser-local → bundle → agent
	// and agent → bundle → another target never lose the onboarding choice.
	if p.App == nil {
		p.App = &PhoneAppSpec{}
	}
	p.App.PrimaryEntity = pre.PrimaryTable
	p.App.Brand = &st.Brand
	if err := savePhoneApp(p.Dir, p.App); err != nil {
		return nil, err
	}
	p, err = LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	p.Dir = "" // never expose a host path in the public release document
	content, err := json.Marshal(struct {
		Version int           `json:"version"`
		Project *PhoneProject `json:"project"`
		Brand   PhoneAppBrand `json:"brand"`
	}{phoneWebInstallVersion, p, st.Brand})
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(content)
	contentHash := hex.EncodeToString(sum[:])
	if st.ActiveRelease != "" && st.ContentHash == contentHash {
		return phoneWebStatusFor(p.Slug)
	}
	releaseID := contentHash[:12]
	rel := PhoneWebRelease{Version: phoneWebInstallVersion, ID: releaseID, ReleasedAt: time.Now().UTC().Format(time.RFC3339), Project: p, Brand: st.Brand}
	releaseJSON, err := json.MarshalIndent(rel, "", "  ")
	if err != nil {
		return nil, err
	}
	realDir, err := PhoneProjectDir(slug)
	if err != nil {
		return nil, err
	}
	releasePath := filepath.Join(phoneWebReleaseDir(realDir), releaseID+".json")
	if err := atomicPhoneWebWrite(releasePath, releaseJSON, 0o600); err != nil {
		return nil, err
	}
	if st.ActiveRelease != releaseID {
		st.PreviousRelease = st.ActiveRelease
	}
	st.ActiveRelease = releaseID
	st.ContentHash = contentHash
	st.PublishedAt = rel.ReleasedAt
	realProject, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	if err := savePhoneWebInstall(realProject, st); err != nil {
		return nil, err
	}
	return phoneWebStatusFor(slug)
}

type phoneWebPreflightError struct{ result *PhoneWebPreflightResult }

func (e *phoneWebPreflightError) Error() string { return e.result.Message }

func phoneWebStatusFor(slug string) (*PhoneWebInstallStatus, error) {
	p, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	st, err := loadPhoneWebInstall(p)
	if err != nil {
		return nil, err
	}
	tokens, _ := ListPhoneProjectTokens(slug)
	installations := 0
	for _, tok := range tokens {
		if strings.HasPrefix(tok.Label, "Home Screen · ") {
			installations++
		}
	}
	appPath := ""
	if st.ActiveRelease != "" {
		appPath = phoneWebAppPath(slug)
	}
	return &PhoneWebInstallStatus{
		Published: st.ActiveRelease != "", AppPath: appPath, ActiveRelease: st.ActiveRelease,
		PreviousRelease: st.PreviousRelease, PublishedAt: st.PublishedAt,
		CanRollback: st.PreviousRelease != "", Brand: st.Brand,
		PendingEnrollments: countPhoneWebEnrollments(slug), Installations: installations,
	}, nil
}

func RollbackPhoneWebApp(slug string) (*PhoneWebInstallStatus, error) {
	p, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, err
	}
	st, err := loadPhoneWebInstall(p)
	if err != nil {
		return nil, err
	}
	if st.PreviousRelease == "" {
		return nil, errors.New("no previous Home Screen release to restore")
	}
	prevPath := filepath.Join(phoneWebReleaseDir(p.Dir), st.PreviousRelease+".json")
	if _, err := os.Stat(prevPath); err != nil {
		return nil, fmt.Errorf("previous Home Screen release is unavailable: %w", err)
	}
	st.ActiveRelease, st.PreviousRelease = st.PreviousRelease, st.ActiveRelease
	b, err := os.ReadFile(prevPath)
	if err == nil {
		var rel PhoneWebRelease
		if json.Unmarshal(b, &rel) == nil {
			st.Brand = rel.Brand
			st.PublishedAt = time.Now().UTC().Format(time.RFC3339)
			content, _ := json.Marshal(struct {
				Version int           `json:"version"`
				Project *PhoneProject `json:"project"`
				Brand   PhoneAppBrand `json:"brand"`
			}{phoneWebInstallVersion, rel.Project, rel.Brand})
			sum := sha256.Sum256(content)
			st.ContentHash = hex.EncodeToString(sum[:])
		}
	}
	if err := savePhoneWebInstall(p, st); err != nil {
		return nil, err
	}
	return phoneWebStatusFor(slug)
}

func phoneWebAppPath(slug string) string { return "/apps/" + Slugify(slug) + "/" }

func loadActivePhoneWebRelease(slug string) (*PhoneWebRelease, *PhoneWebInstallState, error) {
	p, err := LoadPhoneProject(slug)
	if err != nil {
		return nil, nil, err
	}
	st, err := loadPhoneWebInstall(p)
	if err != nil {
		return nil, nil, err
	}
	if st.ActiveRelease == "" {
		return nil, st, errors.New("this app has not been published to the Home Screen yet")
	}
	b, err := os.ReadFile(filepath.Join(phoneWebReleaseDir(p.Dir), st.ActiveRelease+".json"))
	if err != nil {
		return nil, st, fmt.Errorf("active Home Screen release is unavailable: %w", err)
	}
	var rel PhoneWebRelease
	if err := json.Unmarshal(b, &rel); err != nil {
		return nil, st, fmt.Errorf("parse active Home Screen release: %w", err)
	}
	return &rel, st, nil
}

func (s *HTTPServer) registerPhoneInstallRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/phone/projects/install/preflight", s.auth(s.handlePhoneWebPreflight))
	mux.HandleFunc("/phone/projects/install/publish", s.auth(s.handlePhoneWebPublish))
	mux.HandleFunc("/phone/projects/install/status", s.auth(s.handlePhoneWebStatus))
	mux.HandleFunc("/phone/projects/install/rollback", s.auth(s.handlePhoneWebRollback))
	mux.HandleFunc("/phone/projects/install/enrollments", s.auth(s.handlePhoneWebEnrollments))
	mux.HandleFunc("/phone/projects/install/approve", s.auth(s.handlePhoneWebApprove))
	mux.HandleFunc("/apps/", s.rateLimit(s.phoneAppsRouter))
}

func (s *HTTPServer) handlePhoneWebPreflight(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("slug")
	if slug == "" {
		jsonError(w, http.StatusBadRequest, "slug required")
		return
	}
	pre, err := PreflightPhoneWebApp(slug, nil)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pre)
}

func decodePhoneWebBrand(r *http.Request) (string, *PhoneAppBrand, error) {
	var body struct {
		Slug  string         `json:"slug"`
		Brand *PhoneAppBrand `json:"brand"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return "", nil, err
	}
	return body.Slug, body.Brand, nil
}

func (s *HTTPServer) handlePhoneWebPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	slug, brand, err := decodePhoneWebBrand(r)
	if err != nil || slug == "" {
		jsonError(w, http.StatusBadRequest, "slug required")
		return
	}
	status, err := PublishPhoneWebApp(slug, brand)
	if err != nil {
		var preErr *phoneWebPreflightError
		if errors.As(err, &preErr) {
			writeJSON(w, http.StatusUnprocessableEntity, preErr.result)
			return
		}
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *HTTPServer) handlePhoneWebStatus(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("slug")
	if slug == "" {
		jsonError(w, http.StatusBadRequest, "slug required")
		return
	}
	st, err := phoneWebStatusFor(slug)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *HTTPServer) handlePhoneWebRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		Slug string `json:"slug"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	st, err := RollbackPhoneWebApp(body.Slug)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func cleanPhoneWebEnrollmentsLocked(now time.Time) {
	for id, e := range phoneWebEnrollments.items {
		if now.Sub(e.CreatedAt) > 10*time.Minute {
			delete(phoneWebEnrollments.items, id)
		}
	}
}

func countPhoneWebEnrollments(slug string) int {
	phoneWebEnrollments.Lock()
	defer phoneWebEnrollments.Unlock()
	cleanPhoneWebEnrollmentsLocked(time.Now())
	n := 0
	for _, e := range phoneWebEnrollments.items {
		if e.Slug == slug && e.ApprovedRaw == "" {
			n++
		}
	}
	return n
}

func listPhoneWebEnrollments(slug string) []map[string]interface{} {
	phoneWebEnrollments.Lock()
	defer phoneWebEnrollments.Unlock()
	cleanPhoneWebEnrollmentsLocked(time.Now())
	out := []map[string]interface{}{}
	for _, e := range phoneWebEnrollments.items {
		if e.Slug == slug && e.ApprovedRaw == "" {
			out = append(out, map[string]interface{}{"id": e.ID, "code": e.Code, "createdAt": e.CreatedAt.UTC().Format(time.RFC3339)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["createdAt"].(string) < out[j]["createdAt"].(string) })
	return out
}

func (s *HTTPServer) handlePhoneWebEnrollments(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("slug")
	if slug == "" {
		jsonError(w, http.StatusBadRequest, "slug required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"enrollments": listPhoneWebEnrollments(Slugify(slug))})
}

func approvePhoneWebEnrollment(slug, code string) error {
	slug, code = Slugify(slug), strings.ToUpper(strings.TrimSpace(code))
	phoneWebEnrollments.Lock()
	defer phoneWebEnrollments.Unlock()
	cleanPhoneWebEnrollmentsLocked(time.Now())
	for _, e := range phoneWebEnrollments.items {
		if e.Slug != slug || e.Code != code {
			continue
		}
		if e.ApprovedRaw != "" {
			return nil
		}
		mint, err := MintPhoneProjectToken(slug, "Home Screen · "+code)
		if err != nil {
			return err
		}
		e.ApprovedRaw, e.TokenID = mint.Raw, mint.Token.ID
		return nil
	}
	return errors.New("that connection code is invalid or expired; reopen the shortcut to request a new one")
}

func (s *HTTPServer) handlePhoneWebApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		Slug string `json:"slug"`
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := approvePhoneWebEnrollment(body.Slug, body.Code); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (s *HTTPServer) phoneAppsRouter(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/apps/"), "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) == 0 || parts[0] == "" || Slugify(parts[0]) != parts[0] {
		http.NotFound(w, r)
		return
	}
	slug := parts[0]
	asset := ""
	if len(parts) > 1 {
		asset = strings.Join(parts[1:], "/")
	}
	rel, st, err := loadActivePhoneWebRelease(slug)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch asset {
	case "", "index.html":
		servePhoneWebHTML(w, rel)
	case "style.css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write([]byte(phoneWebCSS))
	case "runtime.js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write([]byte(phoneWebRuntimeJS))
	case "manifest.webmanifest":
		servePhoneWebManifest(w, rel)
	case "release.json":
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(rel)
	case "sw.js":
		servePhoneWebWorker(w, slug, st.ActiveRelease)
	case "icon-180.png":
		servePhoneWebIcon(w, rel.Brand, 180)
	case "icon-192.png":
		servePhoneWebIcon(w, rel.Brand, 192)
	case "icon-512.png":
		servePhoneWebIcon(w, rel.Brand, 512)
	case "enroll/start":
		startPhoneWebEnrollment(w, r, slug)
	case "enroll/poll":
		pollPhoneWebEnrollment(w, r, slug)
	default:
		http.NotFound(w, r)
	}
}

func servePhoneWebHTML(w http.ResponseWriter, rel *PhoneWebRelease) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
	name := html.EscapeString(rel.Brand.DisplayName)
	doc := `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="` + rel.Brand.PrimaryColor + `"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="` + name + `"><title>` + name + `</title><link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png?v=` + rel.ID + `"><link rel="stylesheet" href="style.css?v=1"></head><body><main id="app" aria-live="polite"><section class="boot"><img src="icon-192.png?v=` + rel.ID + `" alt=""><h1>` + name + `</h1><p>Opening your app…</p></section></main><script src="runtime.js?v=1" defer></script></body></html>`
	_, _ = w.Write([]byte(doc))
}

func servePhoneWebManifest(w http.ResponseWriter, rel *PhoneWebRelease) {
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	description := "Built with Yaver"
	if rel.Project != nil && rel.Project.App != nil && strings.TrimSpace(rel.Project.App.Summary) != "" {
		description = rel.Project.App.Summary
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id": "./", "name": rel.Brand.DisplayName, "short_name": rel.Brand.DisplayName,
		"description": description, "start_url": "./?source=home-screen", "scope": "./",
		"display": "standalone", "orientation": "portrait-primary",
		"background_color": "#ffffff", "theme_color": rel.Brand.PrimaryColor,
		"icons": []map[string]string{
			{"src": "icon-192.png?v=" + rel.ID, "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
			{"src": "icon-512.png?v=" + rel.ID, "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
		},
	})
}

func servePhoneWebWorker(w http.ResponseWriter, slug, release string) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	assets, _ := json.Marshal([]string{"./", "style.css?v=1", "runtime.js?v=1", "manifest.webmanifest", "icon-192.png?v=" + release, "icon-512.png?v=" + release})
	js := `const C="yaver-` + slug + `-` + release + `",A=` + string(assets) + `;self.addEventListener("install",e=>e.waitUntil(caches.open(C).then(c=>c.addAll(A))));self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(xs=>Promise.all(xs.filter(x=>x.startsWith("yaver-` + slug + `-")&&x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;const u=new URL(e.request.url);if(u.pathname.includes("/data/")||u.pathname.endsWith("/release.json")||u.pathname.includes("/enroll/"))return;if(e.request.mode==="navigate"){e.respondWith(fetch(e.request).then(r=>{const q=r.clone();caches.open(C).then(c=>c.put("./",q));return r}).catch(()=>caches.match("./")));return}e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))})`
	_, _ = w.Write([]byte(js))
}

func startPhoneWebEnrollment(w http.ResponseWriter, r *http.Request, slug string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	id, secret := randomHex(12), randomHex(24)
	if id == "" || secret == "" {
		jsonError(w, http.StatusInternalServerError, "secure random source unavailable")
		return
	}
	phoneWebEnrollments.Lock()
	defer phoneWebEnrollments.Unlock()
	cleanPhoneWebEnrollmentsLocked(time.Now())
	code := ""
	for i := 0; i < 8; i++ {
		// randomHex's argument is the number of hexadecimal characters returned,
		// not the number of random bytes. Passing 3 made len(raw) < 6 true on
		// every attempt, so enrollment could only report a 500. Keep the
		// user-facing code at six characters, split for readability below.
		raw := strings.ToUpper(randomHex(6))
		if len(raw) < 6 {
			continue
		}
		candidate := raw[:3] + "-" + raw[3:6]
		used := false
		for _, e := range phoneWebEnrollments.items {
			if e.Slug == slug && e.Code == candidate {
				used = true
				break
			}
		}
		if !used {
			code = candidate
			break
		}
	}
	if code == "" {
		jsonError(w, http.StatusInternalServerError, "could not allocate a connection code")
		return
	}
	phoneWebEnrollments.items[id] = &phoneWebEnrollment{ID: id, Slug: slug, Code: code, SecretHash: hashRawToken(secret), CreatedAt: time.Now()}
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": id, "secret": secret, "code": code, "expiresIn": 600})
}

func pollPhoneWebEnrollment(w http.ResponseWriter, r *http.Request, slug string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	phoneWebEnrollments.Lock()
	defer phoneWebEnrollments.Unlock()
	cleanPhoneWebEnrollmentsLocked(time.Now())
	e := phoneWebEnrollments.items[body.ID]
	if e == nil || e.Slug != slug || e.SecretHash != hashRawToken(body.Secret) {
		jsonError(w, http.StatusUnauthorized, "invalid or expired connection request")
		return
	}
	if e.ApprovedRaw == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "pending"})
		return
	}
	raw := e.ApprovedRaw
	delete(phoneWebEnrollments.items, body.ID) // one-shot delivery
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "approved", "token": raw})
}

func servePhoneWebIcon(w http.ResponseWriter, brand PhoneAppBrand, size int) {
	b, err := buildPhoneWebIcon(brand, size)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(b)
}

func parsePhoneWebColor(s string) color.RGBA {
	b, err := hex.DecodeString(strings.TrimPrefix(s, "#"))
	if err != nil || len(b) != 3 {
		return color.RGBA{108, 92, 231, 255}
	}
	return color.RGBA{b[0], b[1], b[2], 255}
}

func buildPhoneWebIcon(brand PhoneAppBrand, size int) ([]byte, error) {
	if size < 32 || size > 1024 {
		return nil, errors.New("unsupported icon size")
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	primary, secondary := parsePhoneWebColor(brand.PrimaryColor), parsePhoneWebColor(brand.SecondaryColor)
	for y := 0; y < size; y++ {
		mix := float64(y) / float64(size-1)
		c := color.RGBA{uint8(float64(primary.R)*(1-mix) + float64(secondary.R)*mix), uint8(float64(primary.G)*(1-mix) + float64(secondary.G)*mix), uint8(float64(primary.B)*(1-mix) + float64(secondary.B)*mix), 255}
		for x := 0; x < size; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	white := color.RGBA{255, 255, 255, 245}
	line := func(x1, y1, x2, y2, width int) { drawPhoneWebLine(img, x1, y1, x2, y2, width, white) }
	s := size
	switch brand.Icon {
	case "check":
		line(s*24/100, s*52/100, s*43/100, s*70/100, s/12)
		line(s*43/100, s*70/100, s*78/100, s*31/100, s/12)
	case "note":
		fillPhoneWebRect(img, s*27/100, s*21/100, s*73/100, s*79/100, white)
		for _, y := range []int{38, 51, 64} {
			line(s*38/100, s*y/100, s*64/100, s*y/100, s/30)
		}
	case "grid":
		for _, x := range []int{28, 55} {
			for _, y := range []int{28, 55} {
				fillPhoneWebRect(img, s*x/100, s*y/100, s*(x+18)/100, s*(y+18)/100, white)
			}
		}
	case "heart":
		fillPhoneWebCircle(img, s*39/100, s*43/100, s/6, white)
		fillPhoneWebCircle(img, s*61/100, s*43/100, s/6, white)
		for y := s * 43 / 100; y < s*76/100; y++ {
			half := (s*76/100 - y) * 58 / 100
			fillPhoneWebRect(img, s/2-half, y, s/2+half, y+1, white)
		}
	case "bolt":
		for i := 0; i < s/10; i++ {
			line(s*60/100-i, s*20/100, s*36/100-i, s*55/100, s/18)
			line(s*36/100-i, s*55/100, s*52/100-i, s*55/100, s/18)
			line(s*52/100-i, s*55/100, s*40/100-i, s*82/100, s/18)
		}
	case "leaf":
		fillPhoneWebCircle(img, s/2, s/2, s/4, white)
		line(s*34/100, s*67/100, s*69/100, s*33/100, s/22)
	case "rocket":
		fillPhoneWebCircle(img, s/2, s*44/100, s/5, white)
		line(s/2, s*20/100, s*34/100, s*65/100, s/10)
		line(s/2, s*20/100, s*66/100, s*65/100, s/10)
		line(s*38/100, s*68/100, s*30/100, s*80/100, s/14)
		line(s*62/100, s*68/100, s*70/100, s*80/100, s/14)
	default:
		line(s*25/100, s*27/100, s/2, s*54/100, s/10)
		line(s*75/100, s*27/100, s/2, s*54/100, s/10)
		line(s/2, s*54/100, s/2, s*78/100, s/10)
		fillPhoneWebCircle(img, s*76/100, s*22/100, s/18, white)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func fillPhoneWebRect(img *image.RGBA, x1, y1, x2, y2 int, c color.RGBA) {
	for y := max(0, y1); y < min(img.Bounds().Dy(), y2); y++ {
		for x := max(0, x1); x < min(img.Bounds().Dx(), x2); x++ {
			img.SetRGBA(x, y, c)
		}
	}
}
func fillPhoneWebCircle(img *image.RGBA, cx, cy, r int, c color.RGBA) {
	for y := cy - r; y <= cy+r; y++ {
		for x := cx - r; x <= cx+r; x++ {
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= r*r && image.Pt(x, y).In(img.Bounds()) {
				img.SetRGBA(x, y, c)
			}
		}
	}
}
func drawPhoneWebLine(img *image.RGBA, x1, y1, x2, y2, width int, c color.RGBA) {
	steps := max(absPhoneWeb(x2-x1), absPhoneWeb(y2-y1))
	if steps == 0 {
		fillPhoneWebCircle(img, x1, y1, max(1, width/2), c)
		return
	}
	for i := 0; i <= steps; i++ {
		x := x1 + (x2-x1)*i/steps
		y := y1 + (y2-y1)*i/steps
		fillPhoneWebCircle(img, x, y, max(1, width/2), c)
	}
}
func absPhoneWeb(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

const phoneWebCSS = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17202a;background:#f7f8fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,color-mix(in srgb,var(--primary,#6c5ce7) 9%,#fff),#f7f8fb 38%);padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}button,input{font:inherit}button{cursor:pointer}.boot,.connect,.empty{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center}.boot img,.connect img{width:88px;height:88px;border-radius:22px;box-shadow:0 12px 34px #18202c25}.shell{max-width:720px;margin:auto;padding:22px 18px 90px}.nav{display:flex;align-items:center;gap:12px;margin-bottom:24px}.nav img{width:48px;height:48px;border-radius:13px}.nav h1{font-size:23px;margin:0}.sub{color:#687080;font-size:13px;margin:3px 0 0}.pill{margin-left:auto;border:0;border-radius:999px;background:#fff;padding:8px 11px;box-shadow:0 2px 12px #17202a12}.composer{display:flex;gap:8px;background:#fff;padding:9px;border-radius:16px;box-shadow:0 5px 24px #17202a10}.composer input{border:0;outline:0;min-width:0;flex:1;padding:9px;background:transparent}.primary{border:0;border-radius:11px;background:var(--primary);color:#fff;padding:10px 15px;font-weight:700}.list{display:grid;gap:10px;margin-top:18px}.card{background:#fff;border:1px solid #17202a0c;border-radius:16px;padding:15px;box-shadow:0 4px 16px #17202a0b}.row{display:flex;align-items:center;gap:10px}.grow{flex:1;min-width:0}.title{font-weight:700;word-break:break-word}.meta{font-size:12px;color:#7b8290;margin-top:4px}.ghost{border:0;background:transparent;color:#707786;padding:8px}.bool{width:24px;height:24px;border:2px solid var(--primary);border-radius:8px;background:#fff}.bool.on{background:var(--primary)}.connect h1{margin:20px 0 6px}.code{font:800 30px ui-monospace,SFMono-Regular,monospace;letter-spacing:3px;background:#fff;border-radius:14px;padding:13px 18px;margin:18px 0;box-shadow:0 4px 20px #17202a12}.hint{max-width:390px;color:#687080;line-height:1.45}.error{color:#b42318;background:#fee4e2;padding:12px;border-radius:12px}.footer{position:fixed;bottom:calc(10px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;gap:8px;background:#17202ae8;color:#fff;border-radius:999px;padding:7px 10px;backdrop-filter:blur(12px)}.footer button{border:0;color:#fff;background:transparent;padding:6px 9px}.update{background:#fff3cd;color:#694f00;padding:10px 13px;border-radius:12px;margin-bottom:14px;display:none}@media(display-mode:standalone){.install-help{display:none}}`

const phoneWebRuntimeJS = `(()=>{const root=document.getElementById("app"),parts=location.pathname.split("/apps/"),prefix=parts[0],slug=(parts[1]||"").split("/")[0],tokenKey="yaver.webapp.token."+slug;let rel,token=localStorage.getItem(tokenKey)||"";const esc=s=>String(s??"");async function j(url,opt={}){const r=await fetch(url,opt),body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||("Request failed ("+r.status+")"));return body}function el(t,c,txt){const n=document.createElement(t);if(c)n.className=c;if(txt!=null)n.textContent=txt;return n}async function connect(){root.textContent="";const box=el("section","connect"),img=el("img");img.src="icon-192.png?v="+rel.id;box.append(img,el("h1","",rel.brand.displayName),el("p","hint","Connect this Home Screen app to its Yaver project. Only this project is authorized; your Yaver account token never enters the shortcut."));root.append(box);try{const e=await j("enroll/start",{method:"POST"});box.append(el("div","code",e.code),el("p","hint","In Yaver, open this project → Home Screen app → approve "+e.code+"."));for(let i=0;i<300;i++){await new Promise(r=>setTimeout(r,2000));const p=await j("enroll/poll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:e.id,secret:e.secret})});if(p.status==="approved"){token=p.token;localStorage.setItem(tokenKey,token);return render()}}throw new Error("Connection code expired. Reopen the app to try again.")}catch(e){box.append(el("p","error",e.message))}}function primaryTable(){const a=rel.project.app||{},schema=rel.project.schema||{tables:[]};return a.primaryEntity||(a.screens||[]).find(x=>x.table)?.table||schema.tables[0]?.name}function labelColumn(table){return(table.columns||[]).find(c=>c.required&&c.type==="text"&&c.name!=="id")||(table.columns||[]).find(c=>c.type==="text"&&c.name!=="id")}async function api(path,opt={}){opt.headers=Object.assign({},opt.headers||{},token?{Authorization:"Bearer "+token}:{});const r=await fetch(prefix+"/data/"+encodeURIComponent(slug)+"/"+path,opt);if(r.status===401){localStorage.removeItem(tokenKey);token="";throw new Error("authorization expired")}const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||"Request failed");return b}async function render(){root.textContent="";document.documentElement.style.setProperty("--primary",rel.brand.primaryColor);const shell=el("section","shell"),nav=el("header","nav"),img=el("img");img.src="icon-192.png?v="+rel.id;const heading=el("div","grow");heading.append(el("h1","",rel.brand.displayName),el("p","sub",rel.project.app?.summary||"Built with Yaver"));const help=el("button","pill install-help","Add to Home");help.onclick=()=>alert(/iphone|ipad|ipod/i.test(navigator.userAgent)?"In Safari, tap Share, then Add to Home Screen. You can edit the name before adding.":"Open your browser menu and choose Install app or Add to Home screen.");nav.append(img,heading,help);shell.append(nav);const update=el("div","update","A newer version is ready. Tap here to refresh.");update.onclick=()=>location.reload();shell.append(update);const tableName=primaryTable(),table=(rel.project.schema?.tables||[]).find(t=>t.name===tableName);if(!table){shell.append(el("div","error","This release has no primary table."));root.append(shell);return}const col=labelColumn(table);if(col){const form=el("form","composer"),input=el("input");input.placeholder="Add "+tableName.replace(/_/g," ");input.required=true;const add=el("button","primary","Add");form.append(input,add);form.onsubmit=async e=>{e.preventDefault();add.disabled=true;try{await api(encodeURIComponent(tableName),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({[col.name]:input.value})});input.value="";await rows()}catch(x){alert(x.message)}finally{add.disabled=false}};shell.append(form)}const list=el("div","list");shell.append(list);root.append(shell);const footer=el("div","footer"),brand=el("span","","Yaver · "+rel.id),reconnect=el("button","","Disconnect");reconnect.onclick=()=>{localStorage.removeItem(tokenKey);location.reload()};footer.append(brand,reconnect);document.body.append(footer);async function rows(){list.textContent="";try{const data=await api(encodeURIComponent(tableName)+"?limit=100");for(const row of data.rows||[]){const card=el("article","card"),line=el("div","row"),boolCol=(table.columns||[]).find(c=>c.type==="bool"&&c.name!=="id");if(boolCol){const b=el("button","bool"+(row[boolCol.name]?" on":""));b.setAttribute("aria-label","Toggle "+boolCol.name);b.onclick=async()=>{await api(encodeURIComponent(tableName)+"/"+encodeURIComponent(row.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({[boolCol.name]:!row[boolCol.name]})});rows()};line.append(b)}const content=el("div","grow"),title=el("div","title",col?row[col.name]:(row.title||row.name||row.id));const rest=Object.entries(row).filter(([k])=>k!=="id"&&(!col||k!==col.name)&&(!boolCol||k!==boolCol.name)).slice(0,3).map(([k,v])=>k+": "+esc(v)).join(" · ");content.append(title);if(rest)content.append(el("div","meta",rest));const del=el("button","ghost","Delete");del.onclick=async()=>{if(confirm("Delete this item?")){await api(encodeURIComponent(tableName)+"/"+encodeURIComponent(row.id),{method:"DELETE"});rows()}};line.append(content,del);card.append(line);list.append(card)}if(!(data.rows||[]).length)list.append(el("div","empty","Nothing here yet."))}catch(e){if(!token)return connect();list.append(el("div","error",e.message))}}await rows();addEventListener("visibilitychange",async()=>{if(document.visibilityState!=="visible")return;try{const next=await j("release.json?check="+Date.now(),{cache:"no-store"});if(next.id!==rel.id)update.style.display="block"}catch{}})}async function boot(){try{rel=await j("release.json",{cache:"no-store"});if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});token?render():connect()}catch(e){root.textContent="";root.append(el("section","connect",e.message))}}boot()})();`
