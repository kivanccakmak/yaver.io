package main

// browser_shortcut.go publishes an already-built Expo web bundle as an
// installable, immutable browser shortcut. The compiler remains the existing
// POST /dev/build-native target=web-js-bundle pipeline; this layer owns the
// release snapshot, manifest, service worker, stable origin, and verification
// contract shared by Yaver itself and third-party Feedback SDK apps.
//
// SECURITY: browser storage is isolated by ORIGIN, not URL path. Arbitrary app
// bundles must never share public.yaver.io (or another shared host) with
// Yaver's account token. Every published app therefore claims one dedicated
// HTTPS origin, and the host router serves that app only when Host matches the
// claim. A missing/shared origin is a named preflight failure, never a
// best-effort publish.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const browserShortcutReleaseVersion = 1

// Enrollment is intentionally public on the app's dedicated origin so a new
// Home Screen install can ask the owner for approval. Keep that unauthenticated
// memory surface bounded per published app; replacing the oldest request lets
// the real phone retry without allowing request floods to grow the agent.
const browserShortcutMaxPendingEnrollmentsPerApp = 8

const (
	browserShortcutModeStaticWeb     = "static-web"
	browserShortcutModeRemoteRuntime = "remote-runtime"
)

type BrowserShortcutBrand struct {
	DisplayName     string `json:"displayName"`
	ShortName       string `json:"shortName,omitempty"`
	ThemeColor      string `json:"themeColor,omitempty"`
	BackgroundColor string `json:"backgroundColor,omitempty"`
}

type BrowserShortcutRequest struct {
	AppID          string               `json:"appId"`
	ProjectPath    string               `json:"projectPath"`
	PublicOrigin   string               `json:"publicOrigin,omitempty"`
	RelaySubdomain string               `json:"relaySubdomain,omitempty"`
	Mode           string               `json:"mode,omitempty"`
	RuntimeTarget  string               `json:"runtimeTargetId,omitempty"`
	Brand          BrowserShortcutBrand `json:"brand"`
}

type BrowserShortcutPreflight struct {
	OK             bool                  `json:"ok"`
	Code           string                `json:"code"`
	Message        string                `json:"message"`
	Remedy         string                `json:"remedy,omitempty"`
	Framework      string                `json:"framework,omitempty"`
	BuildTarget    string                `json:"buildTarget,omitempty"`
	AppID          string                `json:"appId,omitempty"`
	Slug           string                `json:"slug,omitempty"`
	ProjectPath    string                `json:"projectPath,omitempty"`
	PublicOrigin   string                `json:"publicOrigin,omitempty"`
	RelaySubdomain string                `json:"relaySubdomain,omitempty"`
	Mode           string                `json:"mode,omitempty"`
	RuntimeTarget  string                `json:"runtimeTargetId,omitempty"`
	Brand          *BrowserShortcutBrand `json:"brand,omitempty"`
}

type BrowserShortcutRelease struct {
	Version        int                  `json:"version"`
	AppID          string               `json:"appId"`
	Slug           string               `json:"slug"`
	ReleaseID      string               `json:"releaseId"`
	PublicOrigin   string               `json:"publicOrigin"`
	RelaySubdomain string               `json:"relaySubdomain,omitempty"`
	Mode           string               `json:"mode"`
	Framework      string               `json:"framework"`
	RuntimeTarget  string               `json:"runtimeTargetId,omitempty"`
	InstallURL     string               `json:"installUrl"`
	ProjectPath    string               `json:"projectPath,omitempty"`
	SourceHead     string               `json:"sourceHead,omitempty"`
	BuiltAt        string               `json:"builtAt,omitempty"`
	PublishedAt    string               `json:"publishedAt"`
	Size           int64                `json:"size"`
	FileCount      int                  `json:"fileCount"`
	Brand          BrowserShortcutBrand `json:"brand"`
}

type browserShortcutRegistryState struct {
	Version int                                `json:"version"`
	Apps    map[string]*BrowserShortcutRelease `json:"apps"`
	Tokens  map[string][]browserShortcutToken  `json:"tokens,omitempty"`
}

type browserShortcutToken struct {
	ID        string `json:"id"`
	Hash      string `json:"hash"`
	CreatedAt string `json:"createdAt"`
	LastUsed  string `json:"lastUsed,omitempty"`
}

var browserShortcutRegistry = struct {
	sync.Mutex
	root  string
	state browserShortcutRegistryState
}{}

type browserShortcutEnrollment struct {
	ID          string
	AppID       string
	Code        string
	SecretHash  string
	CreatedAt   time.Time
	ApprovedRaw string
}

var browserShortcutEnrollments = struct {
	sync.Mutex
	items map[string]*browserShortcutEnrollment
}{items: map[string]*browserShortcutEnrollment{}}

func browserShortcutRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".yaver", "browser-shortcuts")
}

func browserShortcutStatePath(root string) string { return filepath.Join(root, "state.json") }

func loadBrowserShortcutRegistryLocked() browserShortcutRegistryState {
	root := browserShortcutRoot()
	if browserShortcutRegistry.root == root && browserShortcutRegistry.state.Apps != nil {
		return browserShortcutRegistry.state
	}
	state := browserShortcutRegistryState{Version: browserShortcutReleaseVersion, Apps: map[string]*BrowserShortcutRelease{}, Tokens: map[string][]browserShortcutToken{}}
	if root != "" {
		if data, err := os.ReadFile(browserShortcutStatePath(root)); err == nil {
			_ = json.Unmarshal(data, &state)
		}
	}
	if state.Apps == nil {
		state.Apps = map[string]*BrowserShortcutRelease{}
	}
	if state.Tokens == nil {
		state.Tokens = map[string][]browserShortcutToken{}
	}
	state.Version = browserShortcutReleaseVersion
	browserShortcutRegistry.root = root
	browserShortcutRegistry.state = state
	return state
}

func saveBrowserShortcutRegistryLocked(state browserShortcutRegistryState) error {
	root := browserShortcutRoot()
	if root == "" {
		return fmt.Errorf("browser shortcut storage is unavailable: user home directory could not be resolved")
	}
	state.Version = browserShortcutReleaseVersion
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := atomicPhoneWebWrite(browserShortcutStatePath(root), data, 0o600); err != nil {
		return err
	}
	browserShortcutRegistry.root = root
	browserShortcutRegistry.state = state
	return nil
}

func normalizeBrowserShortcutBrand(brand BrowserShortcutBrand, fallback string) BrowserShortcutBrand {
	brand.DisplayName = strings.TrimSpace(brand.DisplayName)
	if brand.DisplayName == "" {
		brand.DisplayName = strings.TrimSpace(fallback)
	}
	if brand.DisplayName == "" {
		brand.DisplayName = "Yaver app"
	}
	if len([]rune(brand.DisplayName)) > 48 {
		brand.DisplayName = string([]rune(brand.DisplayName)[:48])
	}
	brand.ShortName = strings.TrimSpace(brand.ShortName)
	if brand.ShortName == "" {
		brand.ShortName = brand.DisplayName
	}
	if len([]rune(brand.ShortName)) > 24 {
		brand.ShortName = string([]rune(brand.ShortName)[:24])
	}
	if !phoneWebHexColor.MatchString(brand.ThemeColor) {
		brand.ThemeColor = "#6C5CE7"
	}
	if !phoneWebHexColor.MatchString(brand.BackgroundColor) {
		brand.BackgroundColor = "#FFFFFF"
	}
	return brand
}

func browserShortcutSlug(appID string) string {
	return Slugify(strings.ReplaceAll(strings.TrimSpace(appID), ".", "-"))
}

func browserShortcutProjectAllowed(r *http.Request, projectPath string) bool {
	if r == nil {
		return true
	}
	raw := strings.TrimSpace(r.Header.Get("X-Yaver-SdkAllowedProjects"))
	if raw == "" {
		return true // owner/session path; untrusted copies are stripped by authSDK
	}
	var allowed []string
	if json.Unmarshal([]byte(raw), &allowed) != nil || len(allowed) == 0 {
		return false
	}
	projectSlug := browserShortcutSlug(filepath.Base(filepath.Clean(projectPath)))
	for _, candidate := range allowed {
		if browserShortcutSlug(candidate) == projectSlug {
			return true
		}
	}
	return false
}

func browserShortcutRuntimeTarget(projectPath, framework, requested string) (string, string) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		switch framework {
		case "swift":
			requested = "ios-simulator"
		case "kotlin":
			requested = "android-emulator"
		}
	}
	caps := remoteRuntimeCapabilitiesForProjectCached(projectPath, framework, true)
	if !caps.RemoteRuntimeEligible {
		return "", fmt.Sprintf("%s is not eligible for Yaver remote runtime on this checkout", framework)
	}
	for _, target := range caps.Targets {
		if target.ID != requested {
			continue
		}
		if target.Enabled {
			return requested, ""
		}
		// A Linux Yaver box may deliberately hand Swift/iOS signaling to a
		// paired Mac. Probe the real mapped checkout and simulator target; a
		// registry entry or successful /info ping is only inventory.
		if builder, reason := pickBuilderForFramework(framework, requested); builder != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if _, err := probeBuilderRuntime(ctx, nil, *builder, projectPath, framework, requested); err != nil {
				return "", err.Error()
			}
			return requested, ""
		} else if reason != "" {
			return "", reason
		}
		return "", target.Reason
	}
	return "", fmt.Sprintf("remote runtime target %q is not available for this project", requested)
}

func defaultBrowserShortcutSubdomain(appID, deviceID string) string {
	prefix := browserShortcutSlug(appID)
	if len(prefix) > 20 {
		prefix = strings.Trim(prefix[:20], "-")
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(appID) + ":" + strings.TrimSpace(deviceID)))
	return strings.Trim(prefix+"-"+hex.EncodeToString(sum[:4]), "-")
}

func normalizeBrowserShortcutOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("a dedicated HTTPS origin is required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("public origin must be an HTTPS origin such as https://app.example.com")
	}
	if u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("public origin must not contain a path, query, credentials, or fragment")
	}
	host := strings.ToLower(u.Hostname())
	if net.ParseIP(host) != nil {
		return "", fmt.Errorf("a browser shortcut needs a stable HTTPS hostname, not an IP address")
	}
	switch host {
	case "public.yaver.io", "public.dev.yaver.io", "yaver.io", "www.yaver.io", "app.yaver.io":
		return "", fmt.Errorf("%s is a shared Yaver origin and cannot isolate an exported app", host)
	}
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return "", fmt.Errorf("a browser shortcut needs a phone-reachable HTTPS origin, not localhost")
	}
	u.Path, u.RawPath = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

func browserShortcutPreflight(req BrowserShortcutRequest) BrowserShortcutPreflight {
	fail := func(code, message, remedy string) BrowserShortcutPreflight {
		return BrowserShortcutPreflight{OK: false, Code: code, Message: message, Remedy: remedy}
	}
	appID := strings.TrimSpace(req.AppID)
	if appID == "" {
		return fail("BROWSER_SHORTCUT_APP_ID_REQUIRED", "This project has no stable app identity.", "Configure a bundle/application id, then retry the export.")
	}
	slug := browserShortcutSlug(appID)
	if slug == "" {
		return fail("BROWSER_SHORTCUT_APP_ID_INVALID", "The app identity cannot form a safe shortcut id.", "Use a reverse-DNS app id such as com.example.myapp.")
	}
	projectPath, err := filepath.Abs(strings.TrimSpace(req.ProjectPath))
	if err != nil || strings.TrimSpace(req.ProjectPath) == "" {
		return fail("BROWSER_SHORTCUT_PROJECT_REQUIRED", "Choose the exact project checkout before exporting.", "Select a connected box and verified project checkout.")
	}
	framework := detectFramework(projectPath)
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" || mode == "auto" {
		if framework == "swift" || framework == "kotlin" {
			mode = browserShortcutModeRemoteRuntime
		} else {
			mode = browserShortcutModeStaticWeb
		}
	}
	if mode != browserShortcutModeStaticWeb && mode != browserShortcutModeRemoteRuntime {
		return fail("BROWSER_SHORTCUT_MODE_INVALID", "The requested shortcut mode is not supported.", "Use static-web or remote-runtime.")
	}
	runtimeTarget := ""
	switch framework {
	case "expo":
		if mode != browserShortcutModeStaticWeb {
			return fail("BROWSER_SHORTCUT_MODE_UNSUPPORTED", "Expo shortcut export currently uses its static browser build.", "Use static-web for Expo projects.")
		}
		if _, err = readProjectPackageManifest(projectPath); err != nil {
			return fail("BROWSER_SHORTCUT_PROJECT_INVALID", "The selected directory is not a buildable Expo project.", "Choose the directory containing the app's package.json.")
		}
	case "flutter":
		if mode != browserShortcutModeStaticWeb {
			return fail("BROWSER_SHORTCUT_MODE_UNSUPPORTED", "Flutter shortcut export currently uses its static web build.", "Use static-web for Flutter projects.")
		}
		if _, err = os.Stat(filepath.Join(projectPath, "pubspec.yaml")); err != nil {
			return fail("BROWSER_SHORTCUT_PROJECT_INVALID", "The selected directory is not a buildable Flutter project.", "Choose the directory containing the app's pubspec.yaml.")
		}
	case "swift", "kotlin":
		if mode != browserShortcutModeRemoteRuntime {
			return fail("BROWSER_SHORTCUT_NATIVE_NEEDS_RUNTIME", "Native Swift and Kotlin UI cannot be compiled into a static browser app.", "Use remote-runtime to stream the simulator or emulator over WebRTC.")
		}
		var runtimeReason string
		runtimeTarget, runtimeReason = browserShortcutRuntimeTarget(projectPath, framework, req.RuntimeTarget)
		if runtimeReason != "" {
			return fail("BROWSER_SHORTCUT_RUNTIME_UNAVAILABLE", "The native app runtime is not ready: "+runtimeReason, "Install or reconnect the named simulator/emulator host, then retry. No shortcut build was started.")
		}
	default:
		return fail("BROWSER_SHORTCUT_FRAMEWORK_UNSUPPORTED", fmt.Sprintf("Browser shortcut export supports Expo/Flutter web builds and Swift/Kotlin remote runtimes; this checkout is %q.", framework), "Choose a supported runnable app project.")
	}
	origin, err := normalizeBrowserShortcutOrigin(req.PublicOrigin)
	if err != nil {
		return fail("BROWSER_SHORTCUT_ORIGIN_REQUIRED", err.Error(), "Configure one dedicated HTTPS hostname for this app. Shared relay paths remain preview-only.")
	}
	parsedOrigin, _ := url.Parse(origin)
	originHost := strings.ToLower(parsedOrigin.Hostname())
	relaySubdomain := strings.ToLower(strings.TrimSpace(req.RelaySubdomain))
	if (originHost == "yaver.io" || strings.HasSuffix(originHost, ".yaver.io")) &&
		(relaySubdomain == "" || !strings.HasPrefix(originHost, relaySubdomain+".")) {
		return fail("BROWSER_SHORTCUT_SHARED_ORIGIN_REFUSED", "A general Yaver machine/relay origin cannot isolate this exported app.", "Leave the origin blank so Yaver reserves a per-app hostname, or enter your own dedicated HTTPS origin.")
	}

	browserShortcutRegistry.Lock()
	state := loadBrowserShortcutRegistryLocked()
	for otherID, release := range state.Apps {
		if otherID != appID && release != nil && strings.EqualFold(release.PublicOrigin, origin) {
			browserShortcutRegistry.Unlock()
			return fail("BROWSER_SHORTCUT_ORIGIN_IN_USE", "That HTTPS origin already belongs to another exported app.", "Choose a different hostname so browser storage stays isolated per app.")
		}
	}
	browserShortcutRegistry.Unlock()

	brand := normalizeBrowserShortcutBrand(req.Brand, appID)
	message := "Ready to build an installable browser shortcut."
	if mode == browserShortcutModeRemoteRuntime {
		message = "Ready to publish a full-screen WebRTC launcher for the native app runtime."
	}
	return BrowserShortcutPreflight{
		OK: true, Code: "BROWSER_SHORTCUT_READY", Message: message,
		Framework: framework, BuildTarget: "browser-shortcut-bundle", AppID: appID, Slug: slug,
		ProjectPath: projectPath, PublicOrigin: origin, Brand: &brand,
		RelaySubdomain: relaySubdomain, Mode: mode, RuntimeTarget: runtimeTarget,
	}
}

// prepareBrowserShortcutRequest resolves the normal no-DNS path before the
// expensive build: reserve a per-app relay subdomain that forwards to this
// agent's own HTTP port. If the relay is unavailable, export stops here.
func (s *HTTPServer) prepareBrowserShortcutRequest(req BrowserShortcutRequest) (BrowserShortcutRequest, BrowserShortcutPreflight) {
	if strings.TrimSpace(req.PublicOrigin) == "" {
		subdomain := strings.ToLower(strings.TrimSpace(req.RelaySubdomain))
		if subdomain == "" {
			subdomain = defaultBrowserShortcutSubdomain(req.AppID, s.deviceID)
		}
		if err := validateRelaySubdomain(subdomain); err != nil {
			return req, BrowserShortcutPreflight{
				OK: false, Code: "BROWSER_SHORTCUT_SUBDOMAIN_INVALID", Message: err.Error(),
				Remedy: "Use a 3–32 character lowercase name made from letters, numbers, and hyphens.",
			}
		}
		if s.relayExposeMgr == nil {
			return req, BrowserShortcutPreflight{
				OK: false, Code: "BROWSER_SHORTCUT_RELAY_REQUIRED",
				Message: "This machine has no live relay capable of creating the shortcut's HTTPS origin.",
				Remedy:  "Reconnect the machine to a QUIC Yaver relay, or enter a dedicated custom HTTPS origin.",
			}
		}
		entry, err := s.relayExposeMgr.Register(subdomain, s.port)
		if err != nil {
			return req, BrowserShortcutPreflight{
				OK: false, Code: "BROWSER_SHORTCUT_RELAY_ORIGIN_FAILED", Message: err.Error(),
				Remedy: "Restore the machine's QUIC relay connection, choose another shortcut name, or use a custom HTTPS origin.",
			}
		}
		req.RelaySubdomain = subdomain
		req.PublicOrigin = entry.PublicURL
	} else if parsed, err := url.Parse(strings.TrimSpace(req.PublicOrigin)); err == nil {
		host := strings.ToLower(parsed.Hostname())
		if host == "yaver.io" || strings.HasSuffix(host, ".yaver.io") {
			registered := false
			if s.relayExposeMgr != nil {
				for _, entry := range s.relayExposeMgr.List() {
					if entry != nil && entry.Subdomain == req.RelaySubdomain && strings.EqualFold(strings.TrimRight(entry.PublicURL, "/"), strings.TrimRight(req.PublicOrigin, "/")) && entry.Port == s.port {
						registered = true
						break
					}
				}
			}
			if !registered {
				return req, BrowserShortcutPreflight{
					OK: false, Code: "BROWSER_SHORTCUT_SHARED_ORIGIN_REFUSED",
					Message: "A general Yaver machine/relay origin cannot isolate this exported app.",
					Remedy:  "Leave the origin blank so Yaver reserves a per-app hostname, or enter your own dedicated HTTPS origin.",
				}
			}
		}
	}
	return req, browserShortcutPreflight(req)
}

func (s *HTTPServer) restoreBrowserShortcutExposeRoutes() {
	if s == nil || s.relayExposeMgr == nil {
		return
	}
	browserShortcutRegistry.Lock()
	state := loadBrowserShortcutRegistryLocked()
	releases := make([]BrowserShortcutRelease, 0, len(state.Apps))
	for _, release := range state.Apps {
		if release != nil {
			releases = append(releases, *release)
		}
	}
	browserShortcutRegistry.Unlock()
	for _, release := range releases {
		if release.RelaySubdomain != "" {
			s.relayExposeMgr.Remember(release.RelaySubdomain, s.port, release.PublicOrigin)
		}
	}
}

func browserShortcutReleaseDir(slug, releaseID string) string {
	return filepath.Join(browserShortcutRoot(), "apps", slug, "releases", releaseID)
}

func hashBrowserShortcutTree(root string, brand BrowserShortcutBrand, appID, mode, framework, runtimeTarget string) (string, int64, int, error) {
	paths := make([]string, 0)
	var total int64
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("browser shortcut output contains a symlink: %s", filepath.Base(path))
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("browser shortcut output contains a non-regular file: %s", filepath.Base(path))
		}
		total += info.Size()
		if total > 512<<20 {
			return fmt.Errorf("browser shortcut output exceeds the 512 MiB release limit")
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(rel))
		if len(paths) > 20000 {
			return fmt.Errorf("browser shortcut output exceeds the 20,000-file release limit")
		}
		return nil
	})
	if err != nil {
		return "", 0, 0, err
	}
	sort.Strings(paths)
	h := sha256.New()
	meta, _ := json.Marshal(struct {
		AppID         string               `json:"appId"`
		Mode          string               `json:"mode"`
		Framework     string               `json:"framework"`
		RuntimeTarget string               `json:"runtimeTargetId"`
		Brand         BrowserShortcutBrand `json:"brand"`
	}{appID, mode, framework, runtimeTarget, brand})
	_, _ = h.Write(meta)
	for _, rel := range paths {
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(rel))
		f, err := os.Open(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", 0, 0, err
		}
		_, copyErr := io.Copy(h, f)
		closeErr := f.Close()
		if copyErr != nil {
			return "", 0, 0, copyErr
		}
		if closeErr != nil {
			return "", 0, 0, closeErr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), total, len(paths), nil
}

func copyBrowserShortcutTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			_ = in.Close()
			return err
		}
		_, copyErr := io.Copy(out, in)
		inCloseErr := in.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if inCloseErr != nil {
			return inCloseErr
		}
		return closeErr
	})
}

// Public responses deliberately omit the checkout path. An exported origin is
// unauthenticated by design, and absolute host paths are operational metadata,
// not part of an installable app release.
func publicBrowserShortcutRelease(release *BrowserShortcutRelease) *BrowserShortcutRelease {
	if release == nil {
		return nil
	}
	public := *release
	public.ProjectPath = ""
	return &public
}

var browserShortcutPrivateRuntimeFields = map[string]bool{
	"workDir":         true,
	"deviceId":        true,
	"remoteBuilderId": true,
	"startedBy":       true,
	"runner":          true,
}

func sanitizeBrowserShortcutRuntimeJSON(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if browserShortcutPrivateRuntimeFields[key] {
				delete(typed, key)
				continue
			}
			typed[key] = sanitizeBrowserShortcutRuntimeJSON(child)
		}
	case []interface{}:
		for i := range typed {
			typed[i] = sanitizeBrowserShortcutRuntimeJSON(typed[i])
		}
	}
	return value
}

// browserShortcutResponseBuffer lets the shortcut reuse the mature runtime
// handlers without exposing owner-only machine metadata those handlers return.
// Frame bytes bypass this buffer; session/control/offer JSON is bounded and
// sanitized recursively before it reaches the dedicated public app origin.
type browserShortcutResponseBuffer struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newBrowserShortcutResponseBuffer() *browserShortcutResponseBuffer {
	return &browserShortcutResponseBuffer{header: make(http.Header)}
}

func (b *browserShortcutResponseBuffer) Header() http.Header { return b.header }

func (b *browserShortcutResponseBuffer) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *browserShortcutResponseBuffer) Write(data []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(data)
}

func (b *browserShortcutResponseBuffer) flushSanitized(w http.ResponseWriter) {
	for key, values := range b.header {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.Header().Del("Content-Length")
	status := b.status
	if status == 0 {
		status = http.StatusOK
	}
	var payload interface{}
	if json.Unmarshal(b.body.Bytes(), &payload) == nil {
		payload = sanitizeBrowserShortcutRuntimeJSON(payload)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(payload)
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(b.body.Bytes())
}

func writeBrowserShortcutRuntimeJSON(w http.ResponseWriter, status int, value interface{}) {
	raw, err := json.Marshal(value)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "encode shortcut runtime response")
		return
	}
	var payload interface{}
	if json.Unmarshal(raw, &payload) != nil {
		jsonError(w, http.StatusInternalServerError, "encode shortcut runtime response")
		return
	}
	writeJSON(w, status, sanitizeBrowserShortcutRuntimeJSON(payload))
}

func (s *HTTPServer) publishBrowserShortcut(req BrowserShortcutRequest) (*BrowserShortcutRelease, error) {
	resolved, pre := s.prepareBrowserShortcutRequest(req)
	if !pre.OK {
		return nil, &browserShortcutPreflightError{result: pre}
	}
	if s.devServerMgr == nil {
		return nil, fmt.Errorf("web build manager is unavailable")
	}
	info := s.devServerMgr.GetWebBundleInfo()
	if info.BuildDir == "" || !sameDevWorkDir(resolveWebBundleWorkDir(info), pre.ProjectPath) {
		return nil, fmt.Errorf("BROWSER_SHORTCUT_BUILD_REQUIRED: build this exact project with target=browser-shortcut-bundle before publishing")
	}
	index := info.IndexFile
	if index == "" {
		index = "index.html"
	}
	if _, err := os.Stat(filepath.Join(info.BuildDir, index)); err != nil {
		return nil, fmt.Errorf("BROWSER_SHORTCUT_BUILD_INCOMPLETE: web build has no %s", index)
	}
	hash, size, files, err := hashBrowserShortcutTree(info.BuildDir, *pre.Brand, pre.AppID, pre.Mode, pre.Framework, pre.RuntimeTarget)
	if err != nil {
		return nil, err
	}
	releaseID := hash[:16]
	dest := browserShortcutReleaseDir(pre.Slug, releaseID)
	if _, err := os.Stat(dest); os.IsNotExist(err) {
		parent := filepath.Dir(dest)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return nil, err
		}
		tmp, err := os.MkdirTemp(parent, ".release-*")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		if err := copyBrowserShortcutTree(info.BuildDir, tmp); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, dest); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	release := &BrowserShortcutRelease{
		Version: browserShortcutReleaseVersion, AppID: pre.AppID, Slug: pre.Slug,
		ReleaseID: releaseID, PublicOrigin: pre.PublicOrigin, InstallURL: pre.PublicOrigin + "/",
		RelaySubdomain: resolved.RelaySubdomain,
		Mode:           pre.Mode, Framework: pre.Framework, RuntimeTarget: pre.RuntimeTarget,
		ProjectPath: pre.ProjectPath, SourceHead: info.HeadCommit, BuiltAt: info.BuiltAt,
		PublishedAt: now, Size: size, FileCount: files, Brand: *pre.Brand,
	}
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	state := loadBrowserShortcutRegistryLocked()
	// Preflight is advisory; repeat the origin claim under the write lock so two
	// simultaneous publishers cannot race into the same browser security origin.
	for otherID, other := range state.Apps {
		if otherID != pre.AppID && other != nil && strings.EqualFold(other.PublicOrigin, pre.PublicOrigin) {
			return nil, &browserShortcutPreflightError{result: BrowserShortcutPreflight{
				OK: false, Code: "BROWSER_SHORTCUT_ORIGIN_IN_USE",
				Message: "That HTTPS origin already belongs to another exported app.",
				Remedy:  "Choose a different hostname so browser storage stays isolated per app.",
			}}
		}
	}
	state.Apps[pre.AppID] = release
	if err := saveBrowserShortcutRegistryLocked(state); err != nil {
		return nil, err
	}
	return release, nil
}

type browserShortcutPreflightError struct{ result BrowserShortcutPreflight }

func (e *browserShortcutPreflightError) Error() string { return e.result.Message }

func mintBrowserShortcutToken(appID string) (string, error) {
	secret, id := randomHex(64), randomHex(12)
	if secret == "" || id == "" {
		return "", fmt.Errorf("secure random source unavailable")
	}
	raw := "bs_" + id + "_" + secret
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	state := loadBrowserShortcutRegistryLocked()
	if state.Apps[appID] == nil {
		return "", fmt.Errorf("browser shortcut app is not published")
	}
	state.Tokens[appID] = append(state.Tokens[appID], browserShortcutToken{
		ID: id, Hash: hashRawToken(raw), CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err := saveBrowserShortcutRegistryLocked(state); err != nil {
		return "", err
	}
	return raw, nil
}

func browserShortcutBearer(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

func validateBrowserShortcutToken(appID, raw string) bool {
	if appID == "" || !strings.HasPrefix(raw, "bs_") {
		return false
	}
	want := hashRawToken(raw)
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	state := loadBrowserShortcutRegistryLocked()
	tokens := state.Tokens[appID]
	for i := range tokens {
		if subtle.ConstantTimeCompare([]byte(tokens[i].Hash), []byte(want)) != 1 {
			continue
		}
		// Runtime frame and control requests can arrive many times per second.
		// Persisting LastUsed for every request turns ordinary viewing into a
		// disk-write loop on small Linux boxes. Audit at most once per hour; the
		// token check itself remains exact on every request.
		now := time.Now().UTC()
		lastUsed, _ := time.Parse(time.RFC3339, tokens[i].LastUsed)
		if tokens[i].LastUsed == "" || now.Sub(lastUsed) >= time.Hour {
			tokens[i].LastUsed = now.Format(time.RFC3339)
			state.Tokens[appID] = tokens
			_ = saveBrowserShortcutRegistryLocked(state)
		}
		return true
	}
	return false
}

func cleanBrowserShortcutEnrollmentsLocked(now time.Time) {
	for id, enrollment := range browserShortcutEnrollments.items {
		if now.Sub(enrollment.CreatedAt) > 10*time.Minute {
			delete(browserShortcutEnrollments.items, id)
		}
	}
}

func trimBrowserShortcutEnrollmentsLocked(appID string, keep int) {
	for {
		count := 0
		oldestID := ""
		var oldest time.Time
		for id, enrollment := range browserShortcutEnrollments.items {
			if enrollment.AppID != appID {
				continue
			}
			count++
			if oldestID == "" || enrollment.CreatedAt.Before(oldest) {
				oldestID, oldest = id, enrollment.CreatedAt
			}
		}
		if count <= keep || oldestID == "" {
			return
		}
		delete(browserShortcutEnrollments.items, oldestID)
	}
}

func listBrowserShortcutEnrollments(appID string) []map[string]string {
	browserShortcutEnrollments.Lock()
	defer browserShortcutEnrollments.Unlock()
	cleanBrowserShortcutEnrollmentsLocked(time.Now())
	out := []map[string]string{}
	for _, enrollment := range browserShortcutEnrollments.items {
		if enrollment.AppID == appID && enrollment.ApprovedRaw == "" {
			out = append(out, map[string]string{
				"id": enrollment.ID, "code": enrollment.Code,
				"createdAt": enrollment.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["createdAt"] < out[j]["createdAt"] })
	return out
}

func startBrowserShortcutEnrollment(w http.ResponseWriter, r *http.Request, release *BrowserShortcutRelease) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	id, secret := randomHex(24), randomHex(48)
	if id == "" || secret == "" {
		jsonError(w, http.StatusInternalServerError, "secure random source unavailable")
		return
	}
	browserShortcutEnrollments.Lock()
	defer browserShortcutEnrollments.Unlock()
	cleanBrowserShortcutEnrollmentsLocked(time.Now())
	code := ""
	for attempt := 0; attempt < 8 && code == ""; attempt++ {
		raw := strings.ToUpper(randomHex(6))
		if len(raw) < 6 {
			continue
		}
		candidate := raw[:3] + "-" + raw[3:6]
		used := false
		for _, other := range browserShortcutEnrollments.items {
			if other.AppID == release.AppID && other.Code == candidate {
				used = true
				break
			}
		}
		if !used {
			code = candidate
		}
	}
	if code == "" {
		jsonError(w, http.StatusInternalServerError, "could not allocate a connection code")
		return
	}
	browserShortcutEnrollments.items[id] = &browserShortcutEnrollment{
		ID: id, AppID: release.AppID, Code: code, SecretHash: hashRawToken(secret), CreatedAt: time.Now(),
	}
	trimBrowserShortcutEnrollmentsLocked(release.AppID, browserShortcutMaxPendingEnrollmentsPerApp)
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": id, "secret": secret, "code": code, "expiresIn": 600})
}

func pollBrowserShortcutEnrollment(w http.ResponseWriter, r *http.Request, release *BrowserShortcutRelease) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body) != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	browserShortcutEnrollments.Lock()
	defer browserShortcutEnrollments.Unlock()
	cleanBrowserShortcutEnrollmentsLocked(time.Now())
	enrollment := browserShortcutEnrollments.items[body.ID]
	if enrollment == nil || enrollment.AppID != release.AppID || subtle.ConstantTimeCompare([]byte(enrollment.SecretHash), []byte(hashRawToken(body.Secret))) != 1 {
		jsonError(w, http.StatusUnauthorized, "invalid or expired connection request")
		return
	}
	if enrollment.ApprovedRaw == "" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
		return
	}
	raw := enrollment.ApprovedRaw
	delete(browserShortcutEnrollments.items, body.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "approved", "token": raw})
}

func (s *HTTPServer) registerBrowserShortcutRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/browser-shortcuts/preflight", s.authSDK(s.handleBrowserShortcutPreflight))
	mux.HandleFunc("/browser-shortcuts/publish", s.authSDK(s.handleBrowserShortcutPublish))
	mux.HandleFunc("/browser-shortcuts/status", s.authSDK(s.handleBrowserShortcutStatus))
	mux.HandleFunc("/browser-shortcuts/enrollments", s.authSDK(s.handleBrowserShortcutEnrollments))
	mux.HandleFunc("/browser-shortcuts/approve", s.authSDK(s.handleBrowserShortcutApprove))
}

func decodeBrowserShortcutRequest(r *http.Request) (BrowserShortcutRequest, error) {
	var req BrowserShortcutRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		return req, err
	}
	return req, nil
}

func (s *HTTPServer) handleBrowserShortcutPreflight(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	req, err := decodeBrowserShortcutRequest(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !browserShortcutProjectAllowed(r, req.ProjectPath) {
		jsonReply(w, http.StatusForbidden, map[string]interface{}{
			"ok": false, "code": "BROWSER_SHORTCUT_PROJECT_SCOPE_DENIED",
			"message": "This SDK token is not allowed to export the selected project.",
			"remedy":  "Ask the owner for a browser-shortcut token pinned to this project slug.",
		})
		return
	}
	_, pre := s.prepareBrowserShortcutRequest(req)
	status := http.StatusOK
	if !pre.OK {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, pre)
}

func (s *HTTPServer) handleBrowserShortcutPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	req, err := decodeBrowserShortcutRequest(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !browserShortcutProjectAllowed(r, req.ProjectPath) {
		jsonReply(w, http.StatusForbidden, map[string]interface{}{
			"ok": false, "code": "BROWSER_SHORTCUT_PROJECT_SCOPE_DENIED",
			"error": "This SDK token is not allowed to publish the selected project.",
		})
		return
	}
	release, err := s.publishBrowserShortcut(req)
	if err != nil {
		var preErr *browserShortcutPreflightError
		if errors.As(err, &preErr) {
			writeJSON(w, http.StatusUnprocessableEntity, preErr.result)
			return
		}
		jsonReply(w, http.StatusConflict, map[string]interface{}{"ok": false, "code": "BROWSER_SHORTCUT_PUBLISH_FAILED", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "release": release})
}

func (s *HTTPServer) handleBrowserShortcutStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	appID := strings.TrimSpace(r.URL.Query().Get("appId"))
	if appID == "" {
		jsonError(w, http.StatusBadRequest, "appId required")
		return
	}
	browserShortcutRegistry.Lock()
	state := loadBrowserShortcutRegistryLocked()
	release := state.Apps[appID]
	browserShortcutRegistry.Unlock()
	if release != nil && !browserShortcutProjectAllowed(r, release.ProjectPath) {
		jsonReply(w, http.StatusForbidden, map[string]interface{}{"ok": false, "code": "BROWSER_SHORTCUT_PROJECT_SCOPE_DENIED", "error": "This SDK token is not allowed to inspect that shortcut."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "published": release != nil, "release": release})
}

func (s *HTTPServer) handleBrowserShortcutEnrollments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	appID := strings.TrimSpace(r.URL.Query().Get("appId"))
	if appID == "" {
		jsonError(w, http.StatusBadRequest, "appId required")
		return
	}
	if release := browserShortcutReleaseForApp(appID); release == nil || !browserShortcutProjectAllowed(r, release.ProjectPath) {
		jsonReply(w, http.StatusForbidden, map[string]interface{}{"ok": false, "code": "BROWSER_SHORTCUT_PROJECT_SCOPE_DENIED", "error": "This SDK token is not allowed to approve that shortcut."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"enrollments": listBrowserShortcutEnrollments(appID)})
}

func (s *HTTPServer) handleBrowserShortcutApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	var body struct {
		AppID string `json:"appId"`
		Code  string `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body) != nil {
		jsonError(w, http.StatusBadRequest, "invalid json")
		return
	}
	body.AppID = strings.TrimSpace(body.AppID)
	body.Code = strings.ToUpper(strings.TrimSpace(body.Code))
	if release := browserShortcutReleaseForApp(body.AppID); release == nil || !browserShortcutProjectAllowed(r, release.ProjectPath) {
		jsonReply(w, http.StatusForbidden, map[string]interface{}{"ok": false, "code": "BROWSER_SHORTCUT_PROJECT_SCOPE_DENIED", "error": "This SDK token is not allowed to approve that shortcut."})
		return
	}
	browserShortcutEnrollments.Lock()
	defer browserShortcutEnrollments.Unlock()
	cleanBrowserShortcutEnrollmentsLocked(time.Now())
	for _, enrollment := range browserShortcutEnrollments.items {
		if enrollment.AppID != body.AppID || enrollment.Code != body.Code {
			continue
		}
		if enrollment.ApprovedRaw == "" {
			raw, err := mintBrowserShortcutToken(body.AppID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, err.Error())
				return
			}
			enrollment.ApprovedRaw = raw
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	jsonError(w, http.StatusBadRequest, "that connection code is invalid or expired; reopen the shortcut to request a new one")
}

func browserShortcutForHost(host string) *BrowserShortcutRelease {
	host = strings.ToLower(strings.TrimSpace(host))
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	state := loadBrowserShortcutRegistryLocked()
	for _, release := range state.Apps {
		if release == nil {
			continue
		}
		u, err := url.Parse(release.PublicOrigin)
		if err == nil && strings.EqualFold(u.Host, host) {
			copy := *release
			return &copy
		}
	}
	return nil
}

func browserShortcutReleaseForApp(appID string) *BrowserShortcutRelease {
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	release := loadBrowserShortcutRegistryLocked().Apps[strings.TrimSpace(appID)]
	if release == nil {
		return nil
	}
	copy := *release
	return &copy
}

// browserShortcutOriginRouter gives a dedicated app hostname root-path static
// hosting while leaving API calls and every ordinary agent origin untouched.
func (s *HTTPServer) browserShortcutOriginRouter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Enrollment, WebRTC offers, input and session commands are POSTs on
		// the shortcut's dedicated host. Host ownership is the routing key;
		// serveBrowserShortcutOrigin applies the per-route method and token
		// checks after that. Restricting this outer router to GET made the UI
		// installable but left every native shortcut unable to connect.
		if browserShortcutForHost(r.Host) != nil {
			if s.serveBrowserShortcutOrigin(w, r) {
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *HTTPServer) serveBrowserShortcutOrigin(w http.ResponseWriter, r *http.Request) bool {
	release := browserShortcutForHost(r.Host)
	if release == nil {
		return false
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	path := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
	if release.Mode == browserShortcutModeRemoteRuntime && strings.HasPrefix(path, "runtime/") {
		s.serveBrowserShortcutRuntime(w, r, release, path)
		return true
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	switch path {
	case "manifest.webmanifest":
		serveBrowserShortcutManifest(w, release)
		return true
	case "sw.js":
		serveBrowserShortcutWorker(w, release)
		return true
	case "icon-180.png", "icon-192.png", "icon-512.png":
		size := 192
		if path == "icon-180.png" {
			size = 180
		}
		if path == "icon-512.png" {
			size = 512
		}
		servePhoneWebIcon(w, PhoneAppBrand{DisplayName: release.Brand.DisplayName, PrimaryColor: release.Brand.ThemeColor, SecondaryColor: release.Brand.ThemeColor, Icon: "spark", Palette: "indigo"}, size)
		return true
	case "release.json":
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, publicBrowserShortcutRelease(release))
		return true
	}
	root := browserShortcutReleaseDir(release.Slug, release.ReleaseID)
	if path == "" || path == "." {
		path = "index.html"
	}
	clean := filepath.Clean("/" + path)
	full := filepath.Join(root, strings.TrimPrefix(clean, "/"))
	rootAbs, _ := filepath.Abs(root)
	fullAbs, err := filepath.Abs(full)
	if err != nil || (!strings.HasPrefix(fullAbs, rootAbs+string(os.PathSeparator)) && fullAbs != rootAbs) {
		http.Error(w, "bad path", http.StatusBadRequest)
		return true
	}
	info, statErr := os.Stat(fullAbs)
	if statErr != nil || info.IsDir() {
		if !strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html") {
			return false // likely an authenticated agent API GET, not SPA navigation
		}
		fullAbs = filepath.Join(rootAbs, "index.html")
		info, statErr = os.Stat(fullAbs)
	}
	if statErr != nil || info.IsDir() {
		http.NotFound(w, r)
		return true
	}
	if strings.HasSuffix(strings.ToLower(fullAbs), ".html") {
		data, err := os.ReadFile(fullAbs)
		if err != nil {
			http.Error(w, "read app", http.StatusInternalServerError)
			return true
		}
		data = relativizeAbsoluteAssetPaths(data)
		data = injectBaseHref(data, "/")
		data = injectBrowserShortcutHead(data, release)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if release.Mode == browserShortcutModeRemoteRuntime {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		}
		if r.Method != http.MethodHead {
			_, _ = w.Write(data)
		}
		return true
	}
	if contentType := mime.TypeByExtension(filepath.Ext(fullAbs)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		return true
	}
	http.ServeFile(w, r, fullAbs)
	return true
}

func (s *HTTPServer) serveBrowserShortcutRuntime(w http.ResponseWriter, r *http.Request, release *BrowserShortcutRelease, path string) {
	switch path {
	case "runtime/enroll/start":
		startBrowserShortcutEnrollment(w, r, release)
		return
	case "runtime/enroll/poll":
		pollBrowserShortcutEnrollment(w, r, release)
		return
	}
	if !validateBrowserShortcutToken(release.AppID, browserShortcutBearer(r)) {
		jsonError(w, http.StatusUnauthorized, "this shortcut is not connected to its Yaver project")
		return
	}
	switch path {
	case "runtime/capabilities":
		if r.Method != http.MethodGet {
			jsonError(w, http.StatusMethodNotAllowed, "GET only")
			return
		}
		target, reason := browserShortcutRuntimeTarget(release.ProjectPath, release.Framework, release.RuntimeTarget)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok": reason == "", "mode": release.Mode, "framework": release.Framework,
			"runtimeTargetId": target, "reason": reason,
		})
		return
	case "runtime/turn-credentials":
		s.handleRemoteRuntimeTURNCredentials(w, r)
		return
	case "runtime/sessions":
		s.handleBrowserShortcutRuntimeSessionCreate(w, r, release)
		return
	}
	if strings.HasPrefix(path, "runtime/sessions/") {
		s.handleBrowserShortcutRuntimeSessionRoute(w, r, release, strings.TrimPrefix(path, "runtime/sessions/"))
		return
	}
	jsonError(w, http.StatusNotFound, "unknown browser shortcut runtime route")
}

func (s *HTTPServer) handleBrowserShortcutRuntimeSessionCreate(w http.ResponseWriter, r *http.Request, release *BrowserShortcutRelease) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	target, reason := browserShortcutRuntimeTarget(release.ProjectPath, release.Framework, release.RuntimeTarget)
	if reason != "" {
		jsonReply(w, http.StatusPreconditionFailed, map[string]interface{}{
			"ok": false, "code": "BROWSER_SHORTCUT_RUNTIME_UNAVAILABLE", "error": reason,
			"remedy": "Reconnect or repair the simulator/emulator host, then reopen the shortcut.",
		})
		return
	}
	mgr := s.ensureRemoteRuntimeManager()
	session, err := mgr.CreateWith(release.ProjectPath, release.Framework, target, "direct-webrtc", remoteRuntimeCreator{Surface: "browser-shortcut"})
	if err != nil {
		remoteRuntimeCreateError(w, err)
		return
	}
	if mgr.proxiedFor(session.ID) == nil {
		session, err = mgr.Attach(session.ID)
		if err != nil {
			remoteRuntimeCreateError(w, err)
			return
		}
	}
	writeBrowserShortcutRuntimeJSON(w, http.StatusOK, session)
}

func (s *HTTPServer) handleBrowserShortcutRuntimeSessionRoute(w http.ResponseWriter, r *http.Request, release *BrowserShortcutRelease, suffix string) {
	sessionID, tail := splitSessionRoutePath(suffix)
	if sessionID == "" {
		jsonError(w, http.StatusBadRequest, "missing session id")
		return
	}
	mgr := s.ensureRemoteRuntimeManager()
	session, ok := mgr.Get(sessionID)
	if !ok || !sameDevWorkDir(session.WorkDir, release.ProjectPath) || !strings.EqualFold(session.Framework, release.Framework) || session.TargetID != release.RuntimeTarget {
		jsonError(w, http.StatusForbidden, "this runtime session does not belong to the installed shortcut")
		return
	}
	allowed := (r.Method == http.MethodGet && (tail == "" || tail == "/frame")) ||
		(r.Method == http.MethodPost && (tail == "/webrtc/offer" || tail == "/control" || tail == "/command")) ||
		(r.Method == http.MethodDelete && tail == "")
	if !allowed {
		jsonError(w, http.StatusMethodNotAllowed, "that operation is outside the browser shortcut runtime scope")
		return
	}
	if tail == "/command" {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		if err != nil {
			jsonError(w, http.StatusBadRequest, "invalid command body")
			return
		}
		var command struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(body, &command) != nil || command.Command != "run-project" {
			jsonError(w, http.StatusForbidden, "the shortcut may only launch its pinned project")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	r.URL.Path = "/remote-runtime/sessions/" + suffix
	if tail == "/frame" {
		s.handleRemoteRuntimeSessionRoute(w, r)
		return
	}
	buffer := newBrowserShortcutResponseBuffer()
	s.handleRemoteRuntimeSessionRoute(buffer, r)
	buffer.flushSanitized(w)
}

func injectBrowserShortcutHead(data []byte, release *BrowserShortcutRelease) []byte {
	name := strings.NewReplacer("&", "&amp;", `"`, "&quot;", "<", "&lt;", ">", "&gt;").Replace(release.Brand.DisplayName)
	tag := `<meta name="theme-color" content="` + release.Brand.ThemeColor + `">` +
		`<meta name="apple-mobile-web-app-capable" content="yes">` +
		`<meta name="apple-mobile-web-app-status-bar-style" content="default">` +
		`<meta name="apple-mobile-web-app-title" content="` + name + `">` +
		`<link rel="manifest" href="/manifest.webmanifest?v=` + release.ReleaseID + `">` +
		`<link rel="apple-touch-icon" href="/icon-180.png?v=` + release.ReleaseID + `">`
	s := string(data)
	if idx := strings.Index(strings.ToLower(s), "</head>"); idx >= 0 {
		s = s[:idx] + tag + s[idx:]
	}
	register := `<script>if('serviceWorker'in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})})}</script>`
	// The native viewer already registers from runtime.js. Its strict
	// script-src 'self' intentionally refuses inline script, so injecting the
	// generic registration snippet would create a CSP error on every launch.
	if release.Mode == browserShortcutModeRemoteRuntime {
		register = ""
	}
	if idx := strings.Index(strings.ToLower(s), "</body>"); idx >= 0 {
		s = s[:idx] + register + s[idx:]
	} else {
		s += register
	}
	return []byte(s)
}

func serveBrowserShortcutManifest(w http.ResponseWriter, release *BrowserShortcutRelease) {
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id": "/", "name": release.Brand.DisplayName, "short_name": release.Brand.ShortName,
		"start_url": "/?source=browser-shortcut", "scope": "/", "display": "standalone",
		"display_override": []string{"fullscreen", "standalone"},
		"background_color": release.Brand.BackgroundColor, "theme_color": release.Brand.ThemeColor,
		"icons": []map[string]string{
			{"src": "/icon-192.png?v=" + release.ReleaseID, "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
			{"src": "/icon-512.png?v=" + release.ReleaseID, "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
		},
	})
}

func serveBrowserShortcutWorker(w http.ResponseWriter, release *BrowserShortcutRelease) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Service-Worker-Allowed", "/")
	manifest := scanBundleManifest(browserShortcutReleaseDir(release.Slug, release.ReleaseID))
	assets := []string{"/", "/manifest.webmanifest", "/icon-192.png?v=" + release.ReleaseID, "/icon-512.png?v=" + release.ReleaseID}
	for path := range manifest {
		assets = append(assets, "/"+path)
	}
	sort.Strings(assets)
	assetJSON, _ := json.Marshal(assets)
	js := `const C=` + fmt.Sprintf("%q", "yaver-shortcut-"+release.Slug+"-"+release.ReleaseID) + `,A=` + string(assetJSON) + `,S=new Set(A.map(x=>new URL(x,self.location.origin).pathname));` +
		`self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting())));` +
		`self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(xs=>Promise.all(xs.filter(x=>x.startsWith('yaver-shortcut-` + release.Slug + `-')&&x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));` +
		`self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.origin!==self.location.origin)return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/')));return}if(S.has(u.pathname)){e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request)));}});`
	_, _ = w.Write([]byte(js))
}

const browserShortcutNativeRuntimeCSS = `:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#000;color:#fff}*{box-sizing:border-box}html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#000}button{font:inherit}.boot,.connect,.failure{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;text-align:center;background:radial-gradient(circle at 50% 20%,#6c5ce733,transparent 50%)}.mark{width:72px;height:72px;border-radius:21px;display:grid;place-items:center;background:#6c5ce7;font-size:32px;font-weight:900}.boot h1,.connect h1,.failure h1{font-size:24px;margin:8px 0 0}.boot p,.connect p,.failure p{max-width:380px;color:#a7abb7;line-height:1.45;margin:0}.code{font:800 30px ui-monospace,SFMono-Regular,monospace;letter-spacing:3px;background:#17171b;border:1px solid #34343c;border-radius:14px;padding:13px 18px;margin:10px}.runtime{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;touch-action:none;background:#000}.runtime video,.runtime img{width:100%;height:100%;object-fit:contain;background:#000}.hidden{display:none}.status{position:absolute;z-index:3;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));border:1px solid #ffffff1c;background:#08080bd9;backdrop-filter:blur(16px);border-radius:12px;padding:10px 12px;font-size:12px;color:#e8e8ee}.status.quiet{opacity:.35}.retry{border:0;border-radius:11px;background:#6c5ce7;color:#fff;font-weight:800;padding:11px 16px;margin-top:8px}@media(display-mode:standalone){.status.quiet{opacity:.16}}`

// Product-owned, framework-neutral native viewer. It receives only a
// project-scoped browser-shortcut token after the user approves the six-digit
// code in Yaver; the owner's account/agent bearer never enters this origin.
const browserShortcutNativeRuntimeJS = `(()=>{const root=document.getElementById("app");let rel=null,token="",session=null,pc=null,pump=false,objectUrl="";const esc=s=>String(s==null?"":s);function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}async function json(path,opt={}){opt.headers=Object.assign({},opt.headers||{},token?{Authorization:"Bearer "+token}:{});const r=await fetch(path,opt),b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||b.message||("Request failed ("+r.status+")"));return b}function fail(message){root.textContent="";const box=el("section","failure"),mark=el("div","mark","Y"),title=el("h1","","Could not open the native app"),detail=el("p","",message),retry=el("button","retry","Retry");retry.onclick=()=>location.reload();box.append(mark,title,detail,retry);root.append(box)}async function connect(){root.textContent="";const box=el("section","connect"),mark=el("div","mark","Y"),title=el("h1","",rel.brand.displayName),detail=el("p","","Connect this Home Screen shortcut once. It receives access only to this app's simulator/emulator; your Yaver account token never enters it.");box.append(mark,title,detail);root.append(box);const e=await json("/runtime/enroll/start",{method:"POST"});box.append(el("div","code",e.code),el("p","","In Yaver, open this project shortcut and approve "+e.code+"."));for(let i=0;i<300;i++){await new Promise(r=>setTimeout(r,2000));const p=await json("/runtime/enroll/poll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:e.id,secret:e.secret})});if(p.status==="approved"){token=p.token;localStorage.setItem("yaver.native-shortcut."+rel.slug,token);return launch()}}throw new Error("Connection code expired. Reopen the shortcut to request another one.")}function status(message,quiet=false){const n=document.getElementById("status");if(n){n.textContent=message;n.className="status"+(quiet?" quiet":"")}}function activeSurface(){const v=document.getElementById("video"),i=document.getElementById("frame");if(v&&v.srcObject&&v.videoWidth)return{el:v,w:v.videoWidth,h:v.videoHeight};if(i&&i.naturalWidth)return{el:i,w:i.naturalWidth,h:i.naturalHeight};return null}function point(x,y){const s=activeSurface();if(!s)return null;const r=s.el.getBoundingClientRect(),scale=Math.min(r.width/s.w,r.height/s.h),w=s.w*scale,h=s.h*scale,left=r.left+(r.width-w)/2,top=r.top+(r.height-h)/2,nx=(x-left)/w,ny=(y-top)/h;if(nx<0||ny<0||nx>1||ny>1)return null;const d=session&&session.deviceDims||{};return{x:Math.round(nx*(d.width||s.w)),y:Math.round(ny*(d.height||s.h))}}async function control(body){return json("/runtime/sessions/"+encodeURIComponent(session.id)+"/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})}function display(blob){const img=document.getElementById("frame"),video=document.getElementById("video"),next=URL.createObjectURL(blob),old=objectUrl;img.onload=()=>{objectUrl=next;if(old)URL.revokeObjectURL(old);img.classList.remove("hidden");if(!video.srcObject)video.classList.add("hidden");status("Connected",true)};img.src=next}function waitIce(peer){return new Promise(resolve=>{if(peer.iceGatheringState==="complete")return resolve();const done=()=>{if(peer.iceGatheringState==="complete"){peer.removeEventListener("icegatheringstatechange",done);resolve()}};peer.addEventListener("icegatheringstatechange",done);setTimeout(resolve,2500)})}async function framePump(){if(pump)return;pump=true;while(pump){try{const r=await fetch("/runtime/sessions/"+encodeURIComponent(session.id)+"/frame?t="+Date.now(),{headers:{Authorization:"Bearer "+token},cache:"no-store"});if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.error||"Frame fetch failed")}display(await r.blob())}catch(e){status(esc(e.message||e))}await new Promise(r=>setTimeout(r,900))}}async function stream(){let iceServers=[{urls:"stun:stun.l.google.com:19302"}];try{const c=await json("/runtime/turn-credentials",{cache:"no-store"});if(c.iceServers&&c.iceServers.length)iceServers=c.iceServers}catch{}pc=new RTCPeerConnection({iceServers});const chunks=new Map();pc.createDataChannel("primer");pc.addTransceiver("video",{direction:"recvonly"});pc.ontrack=e=>{const v=document.getElementById("video"),i=document.getElementById("frame"),media=e.streams[0];if(!media)return;v.srcObject=media;v.muted=true;v.classList.remove("hidden");i.classList.add("hidden");v.play().catch(()=>{});v.onplaying=()=>status("Connected",true)};pc.ondatachannel=e=>{const ch=e.channel;if(ch.label!=="frames")return;ch.binaryType="arraybuffer";ch.onmessage=m=>{if(typeof m.data!=="string")return display(new Blob([m.data],{type:"image/jpeg"}));let p;try{p=JSON.parse(m.data)}catch{return}if(!p||p.type!=="jpeg-chunk")return;const c=chunks.get(p.id)||{total:p.total,parts:[]};c.parts[p.index]=p.data;chunks.set(p.id,c);if(c.parts.filter(Boolean).length<c.total)return;chunks.delete(p.id);const raw=atob(c.parts.join("")),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);display(new Blob([bytes],{type:"image/jpeg"}))}};pc.onconnectionstatechange=()=>{if(pc.connectionState==="failed"||pc.connectionState==="disconnected")framePump();else if(pc.connectionState==="connected")status("Connected — waiting for app pixels…")};const offer=await pc.createOffer();await pc.setLocalDescription(offer);await waitIce(pc);const local=pc.localDescription||offer,data=await json("/runtime/sessions/"+encodeURIComponent(session.id)+"/webrtc/offer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:local.type,sdp:local.sdp})});await pc.setRemoteDescription({type:data.answer.type||"answer",sdp:data.answer.sdp||""});setTimeout(()=>{if(pc&&pc.connectionState!=="connected")framePump()},8000)}function wireInput(){const surface=document.getElementById("surface");let start=null,moved=false,suppress=0;surface.addEventListener("click",e=>{if(Date.now()<suppress)return;const p=point(e.clientX,e.clientY);if(p)control({action:"tap",x:p.x,y:p.y}).catch(x=>status(esc(x.message||x)))});surface.addEventListener("touchstart",e=>{if(e.touches.length!==1)return;start=point(e.touches[0].clientX,e.touches[0].clientY);moved=false;e.preventDefault()},{passive:false});surface.addEventListener("touchmove",e=>{moved=true;e.preventDefault()},{passive:false});surface.addEventListener("touchend",e=>{const end=point(e.changedTouches[0].clientX,e.changedTouches[0].clientY),begin=start;start=null;if(moved&&begin&&end){suppress=Date.now()+600;control({action:"swipe",x:begin.x,y:begin.y,x2:end.x,y2:end.y,durationMs:250}).catch(x=>status(esc(x.message||x)))}e.preventDefault()},{passive:false})}async function launch(){root.textContent="";const shell=el("section","runtime");shell.id="surface";const video=el("video","hidden"),frame=el("img","hidden"),note=el("div","status","Starting the native runtime…");video.id="video";video.autoplay=true;video.playsInline=true;video.muted=true;frame.id="frame";note.id="status";shell.append(video,frame,note);root.append(shell);const caps=await json("/runtime/capabilities",{cache:"no-store"});if(!caps.ok)throw new Error(caps.reason||"The native runtime is unavailable");session=await json("/runtime/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});wireInput();await json("/runtime/sessions/"+encodeURIComponent(session.id)+"/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:"run-project",source:"browser-shortcut"})});status("Building and launching "+rel.brand.displayName+"…");stream().catch(e=>{status(esc(e.message||e));framePump()});const poll=async()=>{try{const next=await json("/runtime/sessions/"+encodeURIComponent(session.id),{cache:"no-store"});session=next;if(next.status==="build-failed")return fail(next.note||"Native build failed");if(next.status==="running")status("Connected",true)}catch(e){status(esc(e.message||e))}setTimeout(poll,2000)};poll()}async function boot(){try{rel=await json("/release.json",{cache:"no-store"});token=localStorage.getItem("yaver.native-shortcut."+rel.slug)||"";if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});if(token){try{return await launch()}catch(e){if(/not connected|401|authorization/i.test(esc(e.message||e))){localStorage.removeItem("yaver.native-shortcut."+rel.slug);token=""}else throw e}}return connect()}catch(e){fail(esc(e.message||e))}}boot()})();`
