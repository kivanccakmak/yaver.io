package main

// mcp_vision.go — runner-aware vision for the Yaver MCP server.
//
// PROBLEM: a text-only client (e.g. opencode driving deepseek-v4-flash) cannot
// consume MCP image blocks — the pixels are useless to it, and some clients
// strip/error on image content for non-vision models. Claude Code / Codex
// (vision-capable) should keep the native image blocks.
//
// SOLUTION, in one seam:
//   1. The `initialize` handshake captures clientInfo{name,version} on both the
//      HTTP and stdio transports (httpserver.go / main.go).
//   2. mcpClientVisionMode() resolves the client's vision capability:
//      env override (YAVER_MCP_VISION_MODE=text-only|vision|auto) → known client
//      table (claude*/codex ⇒ vision) → opencode model sniff from
//      ~/.config/opencode/opencode.json (deepseek*/qwen3-coder* ⇒ text-only) →
//      safe default text-only.
//   3. finalizeMCPResult() rewrites image content blocks into structured TEXT
//      analysis for text-only clients, free-first:
//        dims → Mac-native OCR (Vision framework, $0) → optional vision-LLM
//        verdict (Mistral/OpenAI/Anthropic) ONLY when a provider is configured.
//      Vision-capable clients are untouched.
//   4. Explicit vision tools (vision_analyze_image / ui_inspect /
//      testkit_visual_check / vision_pdf_extract / vision_diff) give any runner
//      an image→text path with per-call provider/model/tier control.
//
// COST MODEL: no-cost is better. The free layer (OCR + accessibility/DOM trees +
// pixel diff) answers most questions (crash logs, UI text, diffs). The vision
// LLM is only invoked for semantic pixel judgment, and never silently — if no
// provider key is configured, the tools say so instead of degrading to Ollama.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/yaver-io/agent/testkit"
)

// ---------------------------------------------------------------------------
// Client identity + vision capability resolution
// ---------------------------------------------------------------------------

// setMCPClient records the calling client from the MCP initialize handshake.
func (s *HTTPServer) setMCPClient(name, version string) {
	s.mcpClientMu.Lock()
	s.mcpClientName = name
	s.mcpClientVersion = version
	s.mcpVisionMode = "" // invalidate cache — mode depends on client
	s.mcpClientMu.Unlock()
}

// mcpClientVisionMode resolves whether the current MCP client can see images.
// Returns "vision" or "text-only".
func (s *HTTPServer) mcpClientVisionMode() string {
	// Explicit env override always wins — set in opencode.json:
	//   "mcp": {"yaver": {"environment": {"YAVER_MCP_VISION_MODE": "text-only"}}}
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("YAVER_MCP_VISION_MODE"))); v == "text-only" || v == "vision" {
		return v
	}

	s.mcpClientMu.RLock()
	mode := s.mcpVisionMode
	name := s.mcpClientName
	s.mcpClientMu.RUnlock()
	if mode != "" {
		return mode
	}

	if name == "" {
		mode = "text-only" // unknown client → safe default: adapt images to text
	} else {
		mode = resolveClientVisionMode(name)
	}
	s.mcpClientMu.Lock()
	s.mcpVisionMode = mode
	s.mcpClientMu.Unlock()
	return mode
}

// resolveClientVisionMode maps a client name to a vision mode.
func resolveClientVisionMode(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "claude"), strings.Contains(n, "codex"), strings.Contains(n, "claude-code"):
		// Claude Code / Codex run vision-capable models.
		return "vision"
	case strings.Contains(n, "opencode"):
		return opencodeModelVisionMode()
	default:
		return "text-only"
	}
}

// opencodeModelVisionMode sniffs the live model from opencode's config so a
// text-only model (deepseek-v4-flash) gets text adaptation while a vision model
// keeps native image blocks. Unknown models default to text-only (safe).
func opencodeModelVisionMode() string {
	for _, p := range []string{
		filepath.Join(os.Getenv("HOME"), ".config", "opencode", "opencode.json"),
		filepath.Join(os.Getenv("HOME"), ".config", "opencode", "opencode.jsonc"),
	} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var cfg struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			continue
		}
		model := strings.ToLower(strings.TrimSpace(cfg.Model))
		if model == "" {
			return "text-only"
		}
		for _, visionPrefix := range []string{
			"claude", "gpt-5", "gpt-4", "gemini", "glm-4v", "qwen2.5-vl",
			"qwen3-vl", "llava", "pixtral", "grok-vision",
		} {
			if strings.HasPrefix(model, visionPrefix) {
				return "vision"
			}
		}
		return "text-only"
	}
	return "text-only"
}

// ---------------------------------------------------------------------------
// Result adaptation — image blocks → text for text-only clients
// ---------------------------------------------------------------------------

// finalizeMCPResult is called on every tools/call response. For text-only
// clients it replaces image content blocks with structured text analysis
// (free-first: OCR + optional vision-LLM verdict).
func (s *HTTPServer) finalizeMCPResult(result interface{}, toolName string) interface{} {
	if s.mcpClientVisionMode() != "text-only" {
		return result
	}
	m, ok := result.(map[string]interface{})
	if !ok {
		return result
	}
	content, ok := m["content"]
	if !ok {
		return result
	}
	newContent, changed := rewriteImageContent(content, toolName)
	if !changed {
		return result
	}
	m["content"] = newContent
	return m
}

// rewriteImageContent walks an MCP result's content array and replaces every
// {"type":"image",...} block with a text analysis block.
func rewriteImageContent(content interface{}, toolName string) (interface{}, bool) {
	var items []map[string]interface{}
	switch c := content.(type) {
	case []map[string]interface{}:
		items = c
	case []interface{}:
		for _, it := range c {
			if mm, ok := it.(map[string]interface{}); ok {
				items = append(items, mm)
			}
		}
	default:
		return content, false
	}

	changed := false
	out := make([]map[string]interface{}, 0, len(items))
	for _, it := range items {
		if it["type"] == "image" {
			b64, _ := it["data"].(string)
			mime, _ := it["mimeType"].(string)
			if b64 == "" {
				out = append(out, map[string]interface{}{
					"type": "text",
					"text": "[image captured but no pixel data was attached]",
				})
				changed = true
				continue
			}
			analysis := describeImageB64(b64, mime, visionQuestionForTool(toolName))
			out = append(out, map[string]interface{}{"type": "text", "text": analysis})
			changed = true
			continue
		}
		out = append(out, it)
	}
	if !changed {
		return content, false
	}
	return out, true
}

// visionQuestionForTool picks a surface-appropriate vision question so the
// analysis focuses on what the caller actually cares about.
func visionQuestionForTool(tool string) string {
	switch tool {
	case "browser_screenshot", "selenium_screenshot", "ui_inspect":
		return "This is a screenshot of a web app/website. List the visible text, describe the layout, and flag any visual bugs: overlapping elements, clipped content, missing assets, broken styling, error dialogs, or anything that looks wrong."
	case "droid_frame", "runtime_frame", "adb_screenshot":
		return "This is a screenshot of a mobile app screen. List the visible text (error messages, crash dialogs, labels), describe the layout, and flag anything visually broken."
	case "simulator_screenshot":
		return "This is a screenshot from an iOS simulator. List the visible text and describe the UI, flagging any visual bugs or error screens."
	case "screenshot", "robot_camera":
		return "This is a screenshot of a computer screen. List the visible text and describe what is on screen, flagging error dialogs or anything unusual."
	case "screenlog_frames", "screenlog_live":
		return "This is a frame from a screen recording. Describe what is visible and flag anything broken or unexpected."
	default:
		return "Describe what is visible in this image. Include visible text (especially error messages, crash logs, and UI labels), layout, and anything broken or unexpected."
	}
}

// ---------------------------------------------------------------------------
// Image → text describe pipeline (free-first)
// ---------------------------------------------------------------------------

// describeImageB64 decodes a base64 image and produces the text analysis the
// text-only model will read. Never blocks on the vision LLM for more than 60s.
func describeImageB64(b64, mime, question string) string {
	path, err := writeImageTemp(b64, mime)
	if err != nil {
		return "[image captured but could not be decoded: " + err.Error() + "]"
	}
	defer os.Remove(path)
	return describeImageFile(path, question)
}

// describeImageFile builds the analysis for an image on disk:
//
//	dims → free native OCR (macOS Vision framework) → optional vision-LLM
//	verdict when a provider is configured.
func describeImageFile(path, question string) string {
	if cached, ok := describeCacheGet(path); ok {
		return cached
	}
	text := describeImageFileUncached(path, question)
	describeCachePut(path, text)
	return text
}

func describeImageFileUncached(path, question string) string {
	if question == "" {
		question = "Describe what is visible in this image. Include visible text (especially error messages, crash logs, and UI labels), layout, and anything broken or unexpected."
	}
	var parts []string

	if w, h, err := imageDims(path); err == nil {
		parts = append(parts, fmt.Sprintf("Image: %dx%d pixels", w, h))
	}

	// Layer 1 — free native OCR. $0, on-device, private.
	if ocr, err := freeOCR(path); err == nil && strings.TrimSpace(ocr) != "" {
		parts = append(parts, "Visible text (on-device OCR):\n"+ocr)
	}

	// Layer 2 — semantic verdict. Only when the user configured a vision
	// provider. No silent Ollama fallback.
	if cfg, ok := resolvedVisionConfig("", ""); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		res := testkit.InspectImage(ctx, cfg, path, question)
		if res != nil {
			v := res.Verdict
			if v == "" {
				v = "warn"
			}
			line := fmt.Sprintf("Vision verdict (%s/%s): %s", res.Provider, res.Model, strings.ToUpper(v))
			if len(res.Issues) > 0 {
				line += "\nIssues:\n- " + strings.Join(res.Issues, "\n- ")
			}
			parts = append(parts, line)
		}
	}

	if len(parts) == 0 {
		return "[image captured — no vision available. Configure MISTRAL_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (optionally YAVER_VISION_MODEL) to enable analysis, or call vision_analyze_image for details.]"
	}
	return strings.Join(parts, "\n\n")
}

func writeImageTemp(b64, mime string) (string, error) {
	ext := ".png"
	if strings.Contains(mime, "jpeg") || strings.Contains(mime, "jpg") {
		ext = ".jpg"
	}
	f, err := os.CreateTemp("", "yaver-mcp-image-*"+ext)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(b); err != nil {
		return "", err
	}
	return f.Name(), nil
}

func imageDims(path string) (int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// ---------------------------------------------------------------------------
// Vision provider config — explicit, never silent-Ollama
// ---------------------------------------------------------------------------

// resolvedVisionConfig returns a vision LLM config ONLY when the user has
// configured a provider. Resolution order (shared "joint usages" seam):
//
//  1. env keys MISTRAL_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
//  2. ~/.yaver/config.json `vision_keys` map (set via `yaver set vision-key`
//     or the web/mobile settings surfaces)
//  3. per-call provider/model args + YAVER_VISION_PROVIDER / YAVER_VISION_MODEL
//
// This deliberately does NOT fall back to local Ollama — free native OCR is
// the $0 default; the LLM is opt-in.
func resolvedVisionConfig(provider, model string) (testkit.VisionConfig, bool) {
	p := strings.ToLower(strings.TrimSpace(provider))
	if p == "" {
		p = strings.ToLower(strings.TrimSpace(os.Getenv("YAVER_VISION_PROVIDER")))
	}
	if p == "" {
		// Auto: pick the first configured provider — env first, then the
		// shared config.json vision_keys map.
		keys := visionKeysFromConfig()
		switch {
		case os.Getenv("MISTRAL_API_KEY") != "":
			p = "mistral"
		case os.Getenv("OPENAI_API_KEY") != "":
			p = "openai"
		case os.Getenv("ANTHROPIC_API_KEY") != "":
			p = "anthropic"
		case keys["mistral"] != "":
			p = "mistral"
		case keys["openai"] != "":
			p = "openai"
		case keys["anthropic"] != "":
			p = "anthropic"
		}
	}
	if p == "" {
		return testkit.VisionConfig{}, false
	}
	if model == "" {
		model = os.Getenv("YAVER_VISION_MODEL")
	}
	switch p {
	case "mistral":
		key := os.Getenv("MISTRAL_API_KEY")
		if key == "" {
			key = visionKeysFromConfig()["mistral"]
		}
		if key == "" {
			return testkit.VisionConfig{}, false
		}
		if model == "" {
			model = "pixtral-12b-2409"
		}
		return testkit.VisionConfig{Provider: testkit.VisionProviderMistral, APIKey: key, Model: model, Endpoint: "https://api.mistral.ai/v1/chat/completions"}, true
	case "openai":
		key := os.Getenv("OPENAI_API_KEY")
		if key == "" {
			key = visionKeysFromConfig()["openai"]
		}
		if key == "" {
			return testkit.VisionConfig{}, false
		}
		if model == "" {
			model = "gpt-4o-mini"
		}
		return testkit.VisionConfig{Provider: testkit.VisionProviderOpenAI, APIKey: key, Model: model, Endpoint: "https://api.openai.com/v1/chat/completions"}, true
	case "anthropic":
		key := os.Getenv("ANTHROPIC_API_KEY")
		if key == "" {
			key = visionKeysFromConfig()["anthropic"]
		}
		if key == "" {
			return testkit.VisionConfig{}, false
		}
		if model == "" {
			model = "claude-haiku-4-5-20251001"
		}
		return testkit.VisionConfig{Provider: testkit.VisionProviderAnthropic, APIKey: key, Model: model, Endpoint: "https://api.anthropic.com/v1/messages"}, true
	}
	return testkit.VisionConfig{}, false
}

// visionKeysFromConfig reads the shared vision_keys map from
// ~/.yaver/config.json (never panics; returns empty map on any error).
func visionKeysFromConfig() map[string]string {
	cfg, err := LoadConfig()
	if err != nil || cfg == nil || cfg.VisionKeys == nil {
		return map[string]string{}
	}
	out := map[string]string{}
	for k, v := range cfg.VisionKeys {
		if strings.TrimSpace(v) != "" {
			out[strings.ToLower(strings.TrimSpace(k))] = v
		}
	}
	return out
}

// visionProviderHelp is the actionable hint returned when no provider is set.
const visionProviderHelp = "no vision LLM configured — set MISTRAL_API_KEY (cheapest), OPENAI_API_KEY, or ANTHROPIC_API_KEY, optionally YAVER_VISION_PROVIDER/YAVER_VISION_MODEL. Free on-device OCR still works without any key."

// ---------------------------------------------------------------------------
// Mac-native OCR (Vision framework) — $0, on-device, private
// ---------------------------------------------------------------------------

// freeOCR extracts visible text from an image using ONLY on-device tools ($0):
// macOS → Vision framework helper (macocr); Linux/other → tesseract when
// installed. This is the free layer of the describe pipeline — the vision LLM
// is optional and never required for OCR.
func freeOCR(imagePath string) (string, error) {
	if runtime.GOOS == "darwin" {
		return macOCR(imagePath)
	}
	// Linux / Windows / other: tesseract (apt install tesseract-ocr).
	if _, err := exec.LookPath("tesseract"); err != nil {
		return "", fmt.Errorf("no free OCR available on %s (macOS uses the Vision framework; Linux needs `apt install tesseract-ocr`)", runtime.GOOS)
	}
	cmd := exec.Command("tesseract", imagePath, "stdout", "-l", "eng", "--psm", "3")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("tesseract: %v: %s", err, stderr.String())
	}
	lines := []string{}
	for _, l := range strings.Split(stdout.String(), "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, "- "+t)
		}
	}
	return strings.Join(lines, "\n"), nil
}

// macOCR extracts visible text from an image using the macOS Vision framework
// via a small helper binary compiled on demand. Returns one "text" per line.
func macOCR(imagePath string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("mac OCR is only available on macOS")
	}
	bin := filepath.Join(yaverBinDir(), "macocr")
	if _, err := os.Stat(bin); err != nil {
		if err := buildMacOCR(bin); err != nil {
			return "", err
		}
	}
	cmd := exec.Command(bin, imagePath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("macocr: %v: %s", err, stderr.String())
	}
	var items []struct {
		Text       string  `json:"text"`
		Confidence float64 `json:"confidence"`
		X          float64 `json:"x"`
		Y          float64 `json:"y"`
		W          float64 `json:"w"`
		H          float64 `json:"h"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &items); err != nil {
		return "", fmt.Errorf("macocr: bad JSON: %v", err)
	}
	lines := make([]string, 0, len(items))
	for _, it := range items {
		t := strings.TrimSpace(it.Text)
		if t == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s", t))
	}
	return strings.Join(lines, "\n"), nil
}

func yaverBinDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "/tmp"
	}
	dir := filepath.Join(home, ".yaver", "bin")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func buildMacOCR(dst string) error {
	if _, err := exec.LookPath("swiftc"); err != nil {
		return fmt.Errorf("macocr needs Xcode Command Line Tools (swiftc) once to build; install with `xcode-select --install`: %v", err)
	}
	src := filepath.Join(os.TempDir(), "yaver-macocr-"+fmt.Sprintf("%d", time.Now().UnixNano())+".swift")
	if err := os.WriteFile(src, []byte(macOCRSwiftSource), 0o644); err != nil {
		return err
	}
	defer os.Remove(src)
	cmd := exec.Command("swiftc", "-O", "-framework", "Vision", "-framework", "AppKit", src, "-o", dst)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("swiftc macocr: %v: %s", err, stderr.String())
	}
	return nil
}

// macOCRSwiftSource is the on-device OCR helper: reads an image, runs
// VNRecognizeTextRequest, prints JSON [{text, confidence, x, y, w, h}].
const macOCRSwiftSource = `import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: macocr <image-path>\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path) else {
    FileHandle.standardError.write("macocr: cannot load image\n".data(using: .utf8)!)
    exit(2)
}
guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("macocr: cannot make CGImage\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("macocr: \(error)\n".data(using: .utf8)!)
    exit(2)
}
var out: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    out.append([
        "text": top.string,
        "confidence": Double(top.confidence),
        "x": Double(b.origin.x),
        "y": Double(b.origin.y),
        "w": Double(b.size.width),
        "h": Double(b.size.height),
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
`

// ---------------------------------------------------------------------------
// MCP tool handlers — explicit vision tools for any runner
// ---------------------------------------------------------------------------

// visionSourceToFile resolves a vision tool `source` argument (file path,
// base64:/data: URI, or http(s) URL) to a local temp file.
func (s *HTTPServer) visionSourceToFile(source string) (string, error) {
	src := strings.TrimSpace(source)
	if src == "" {
		return "", fmt.Errorf("source is required: a file path, base64:..., data:image/...;base64,..., or http(s) URL")
	}
	switch {
	case strings.HasPrefix(src, "data:image/"):
		// data:image/png;base64,xxxx
		comma := strings.Index(src, ",")
		if comma < 0 {
			return "", fmt.Errorf("malformed data: URI")
		}
		meta := src[5:comma]
		mime := "image/png"
		if i := strings.Index(meta, ";"); i > 0 {
			mime = meta[:i]
		}
		return writeImageTemp(src[comma+1:], mime)
	case strings.HasPrefix(src, "base64:"):
		return writeImageTemp(src[len("base64:"):], "image/png")
	case strings.HasPrefix(src, "http://"), strings.HasPrefix(src, "https://"):
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(src)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", fmt.Errorf("download %s: %d", src, resp.StatusCode)
		}
		f, err := os.CreateTemp("", "yaver-vision-url-*.png")
		if err != nil {
			return "", err
		}
		defer f.Close()
		if _, err := f.ReadFrom(resp.Body); err != nil {
			return "", err
		}
		return f.Name(), nil
	default:
		// Local file path — resolve against the agent workdir when serving
		// MCP; against the current directory for the `yaver vision` CLI.
		if s != nil && s.taskMgr != nil {
			return s.resolveFilePath(src), nil
		}
		if filepath.IsAbs(src) {
			return filepath.Clean(src), nil
		}
		abs, err := filepath.Abs(src)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
}

// inspectWithTimeout runs the QA vision inspector with a bounded timeout.
func inspectWithTimeout(cfg testkit.VisionConfig, path, question string) *testkit.InspectionResult {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	return testkit.InspectImage(ctx, cfg, path, question)
}

// handleVisionAnalyzeImage implements vision_analyze_image.
func (s *HTTPServer) handleVisionAnalyzeImage(args json.RawMessage) interface{} {
	var a struct {
		Source    string `json:"source"`
		Question  string `json:"question"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
		Tier      string `json:"tier"` // "free" (OCR only) | "fast" | "quality" (LLM)
		SessionID string `json:"session_id"`
	}
	json.Unmarshal(args, &a)

	path := ""
	switch {
	case a.Source != "":
		p, err := s.visionSourceToFile(a.Source)
		if err != nil {
			return mcpToolError("vision_analyze_image: " + err.Error())
		}
		path = p
	case a.SessionID != "" && s.browserMgr != nil:
		res, err := s.browserMgr.Screenshot(a.SessionID)
		if err != nil {
			return mcpToolError("vision_analyze_image: " + err.Error())
		}
		if res.ScreenshotB64 == "" {
			return mcpToolError("vision_analyze_image: no screenshot for session")
		}
		p, err := writeImageTemp(res.ScreenshotB64, "image/png")
		if err != nil {
			return mcpToolError("vision_analyze_image: " + err.Error())
		}
		path = p
	default:
		return mcpToolError("vision_analyze_image: source (or session_id for a browser screenshot) is required")
	}
	defer os.Remove(path)

	out := map[string]interface{}{"ok": true}
	if w, h, err := imageDims(path); err == nil {
		out["width"], out["height"] = w, h
	}
	if ocr, err := freeOCR(path); err == nil {
		out["ocr"] = ocr
	} else {
		out["ocr_error"] = err.Error()
	}

	tier := strings.ToLower(strings.TrimSpace(a.Tier))
	if tier == "" {
		tier = "fast"
	}
	useLLM := tier != "free"
	if useLLM {
		cfg, ok := resolvedVisionConfig(a.Provider, a.Model)
		if !ok {
			out["verdict"] = "no_provider"
			out["issues"] = []string{visionProviderHelp}
			out["note"] = "Free OCR above still works without a vision LLM. To enable semantic analysis, set MISTRAL_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (optionally YAVER_VISION_PROVIDER/YAVER_VISION_MODEL)."
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			res := testkit.InspectImage(ctx, cfg, path, a.Question)
			if res != nil {
				out["provider"] = string(res.Provider)
				out["model"] = res.Model
				out["verdict"] = res.Verdict
				out["issues"] = res.Issues
			}
		}
	} else {
		out["verdict"] = "n/a"
		out["note"] = "tier=free — OCR only, no vision LLM call."
	}
	return mcpToolJSON(out)
}

// handleUiInspect implements ui_inspect: capture one surface and return the
// full text report (dims + OCR + verdict) in a single call.
func (s *HTTPServer) handleUiInspect(args json.RawMessage) interface{} {
	var a struct {
		Surface   string `json:"surface"`
		SessionID string `json:"session_id"`
		Device    string `json:"device"`
		Question  string `json:"question"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	json.Unmarshal(args, &a)

	var imgPath string
	switch strings.ToLower(strings.TrimSpace(a.Surface)) {
	case "browser":
		if s.browserMgr == nil {
			return mcpToolError("ui_inspect browser: no browser session. Call browser_open first (or pass an existing session_id).")
		}
		if a.SessionID == "" {
			return mcpToolError("ui_inspect browser: session_id is required (open one with browser_open first).")
		}
		res, err := s.browserMgr.Screenshot(a.SessionID)
		if err != nil {
			return mcpToolError("ui_inspect browser: " + err.Error())
		}
		p, err := writeImageTemp(res.ScreenshotB64, "image/png")
		if err != nil {
			return mcpToolError("ui_inspect browser: " + err.Error())
		}
		imgPath = p
		defer os.Remove(imgPath)
	case "selenium":
		if a.SessionID == "" {
			return mcpToolError("ui_inspect selenium: session_id is required (start one with selenium_start first).")
		}
		out, err := seleniumMCP.screenshot(a.SessionID)
		if err != nil {
			return mcpToolError("ui_inspect selenium: " + err.Error())
		}
		b64, _ := out["base64"].(string)
		if b64 == "" {
			return mcpToolError("ui_inspect selenium: no screenshot returned")
		}
		p, err := writeImageTemp(b64, "image/png")
		if err != nil {
			return mcpToolError("ui_inspect selenium: " + err.Error())
		}
		imgPath = p
		defer os.Remove(imgPath)
	case "droid":
		serial := droidResolveDevice(a.Device)
		if serial == "" {
			return mcpToolError("ui_inspect droid: no android device attached")
		}
		buf, err := droidFrame(serial)
		if err != nil {
			return mcpToolError("ui_inspect droid: " + err.Error())
		}
		p, err := writeImageTemp(base64.StdEncoding.EncodeToString(buf), "image/png")
		if err != nil {
			return mcpToolError("ui_inspect droid: " + err.Error())
		}
		imgPath = p
		defer os.Remove(imgPath)
	case "simulator":
		out, _ := mcpSimulatorScreenshot(a.Device).(map[string]interface{})
		if path, _ := out["path"].(string); path != "" {
			imgPath = path
			defer os.Remove(imgPath)
		} else {
			return mcpToolError("ui_inspect simulator: " + fmt.Sprint(out["error"]))
		}
	case "mac":
		b64, err := captureScreen()
		if err != nil {
			return mcpToolError("ui_inspect mac: " + err.Error())
		}
		p, err := writeImageTemp(b64, "image/png")
		if err != nil {
			return mcpToolError("ui_inspect mac: " + err.Error())
		}
		imgPath = p
		defer os.Remove(imgPath)
	default:
		return mcpToolError("ui_inspect: surface must be one of browser | selenium | droid | simulator | mac")
	}

	if a.Question == "" {
		a.Question = visionQuestionForTool("ui_inspect")
	}
	analysis := describeImageFile(imgPath, a.Question)
	return mcpToolResult(analysis)
}

// handleTestkitVisualCheck implements testkit_visual_check: run the QA vision
// inspector (PASS/WARN/FAIL) on a selenium session or a provided image.
func (s *HTTPServer) handleTestkitVisualCheck(args json.RawMessage) interface{} {
	var a struct {
		SessionID string `json:"session_id"`
		Image     string `json:"image"`
		Question  string `json:"question"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	json.Unmarshal(args, &a)

	path := ""
	if a.Image != "" {
		p, err := s.visionSourceToFile(a.Image)
		if err != nil {
			return mcpToolError("testkit_visual_check: " + err.Error())
		}
		path = p
		defer os.Remove(path)
	} else if a.SessionID != "" {
		out, err := seleniumMCP.screenshot(a.SessionID)
		if err != nil {
			return mcpToolError("testkit_visual_check: " + err.Error())
		}
		b64, _ := out["base64"].(string)
		if b64 == "" {
			return mcpToolError("testkit_visual_check: no screenshot from session")
		}
		p, err := writeImageTemp(b64, "image/png")
		if err != nil {
			return mcpToolError("testkit_visual_check: " + err.Error())
		}
		path = p
		defer os.Remove(path)
	} else {
		return mcpToolError("testkit_visual_check: session_id (selenium) or image (path/base64/url) is required")
	}

	cfg, ok := resolvedVisionConfig(a.Provider, a.Model)
	if !ok {
		return mcpToolError("testkit_visual_check: " + visionProviderHelp)
	}
	if a.Question == "" {
		a.Question = "This is a screenshot from a UI test. Judge whether the UI looks correct: PASS / WARN / FAIL on the first line, then bullet issues. Flag broken layout, overlapping text, missing content, error screens, and anything that would fail a visual regression."
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	res := testkit.InspectImage(ctx, cfg, path, a.Question)
	if res == nil {
		return mcpToolError("testkit_visual_check: vision inspector returned nothing")
	}
	return mcpToolJSON(map[string]interface{}{
		"ok":       true,
		"verdict":  res.Verdict,
		"issues":   res.Issues,
		"provider": res.Provider,
		"model":    res.Model,
	})
}

// ---------------------------------------------------------------------------
// Describe-result cache — avoid re-paying for near-identical images in loops
// (e.g. screenlog keyframes, repeated ui_inspect calls). Keyed on file sha256.
// ---------------------------------------------------------------------------

var describeCache = struct {
	mu    sync.Mutex
	items map[string]describeCacheEntry
}{items: map[string]describeCacheEntry{}}

type describeCacheEntry struct {
	text string
	at   time.Time
}

const describeCacheCap = 64
const describeCacheTTL = 10 * time.Minute

func describeCacheGet(path string) (string, bool) {
	h, err := fileHash(path)
	if err != nil {
		return "", false
	}
	describeCache.mu.Lock()
	defer describeCache.mu.Unlock()
	e, ok := describeCache.items[h]
	if !ok || time.Since(e.at) > describeCacheTTL {
		return "", false
	}
	return e.text, true
}

func describeCachePut(path, text string) {
	h, err := fileHash(path)
	if err != nil {
		return
	}
	describeCache.mu.Lock()
	defer describeCache.mu.Unlock()
	if len(describeCache.items) >= describeCacheCap {
		// Evict oldest.
		var oldest string
		var oldestAt time.Time
		for k, e := range describeCache.items {
			if oldest == "" || e.at.Before(oldestAt) {
				oldest, oldestAt = k, e.at
			}
		}
		delete(describeCache.items, oldest)
	}
	describeCache.items[h] = describeCacheEntry{text: text, at: time.Now()}
}

func fileHash(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("%x", sum[:16]), nil
}

// ---------------------------------------------------------------------------
// vision_pdf_extract — PDF → text, free on macOS (PDFKit), pdftotext elsewhere
// ---------------------------------------------------------------------------

// macPDFText extracts text from a PDF using PDFKit via a small on-demand
// helper binary (same compile-on-demand pattern as macocr). $0, on-device.
func macPDFText(pdfPath string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("PDFKit extraction is only available on macOS")
	}
	bin := filepath.Join(yaverBinDir(), "macpdftext")
	if _, err := os.Stat(bin); err != nil {
		if err := buildMacPDFText(bin); err != nil {
			return "", err
		}
	}
	cmd := exec.Command(bin, pdfPath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("macpdftext: %v: %s", err, stderr.String())
	}
	return strings.TrimSpace(stdout.String()), nil
}

func buildMacPDFText(dst string) error {
	if _, err := exec.LookPath("swiftc"); err != nil {
		return fmt.Errorf("macpdftext needs Xcode Command Line Tools (swiftc) once to build: %v", err)
	}
	src := filepath.Join(os.TempDir(), "yaver-macpdftext-"+fmt.Sprintf("%d", time.Now().UnixNano())+".swift")
	if err := os.WriteFile(src, []byte(macPDFTextSwiftSource), 0o644); err != nil {
		return err
	}
	defer os.Remove(src)
	cmd := exec.Command("swiftc", "-O", "-framework", "PDFKit", src, "-o", dst)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("swiftc macpdftext: %v: %s", err, stderr.String())
	}
	return nil
}

const macPDFTextSwiftSource = `import Foundation
import PDFKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: macpdftext <pdf-path>\n".data(using: .utf8)!)
    exit(2)
}
guard let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("macpdftext: cannot open PDF\n".data(using: .utf8)!)
    exit(2)
}
var out: [String] = []
for i in 0..<doc.pageCount {
    if let page = doc.page(at: i), let s = page.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        out.append("--- page \(i + 1) ---")
        out.append(s)
    }
}
print(out.joined(separator: "\n"))
`

// handleVisionPDFExtract implements vision_pdf_extract.
func (s *HTTPServer) handleVisionPDFExtract(args json.RawMessage) interface{} {
	var a struct {
		Source string `json:"source"`
	}
	json.Unmarshal(args, &a)
	path, err := s.visionSourceToFile(a.Source)
	if err != nil {
		return mcpToolError("vision_pdf_extract: " + err.Error())
	}
	defer os.Remove(path)

	text := ""
	if runtime.GOOS == "darwin" {
		if t, err := macPDFText(path); err == nil {
			text = t
		} else {
			// Fall back to pdftotext if present.
			if _, lerr := exec.LookPath("pdftotext"); lerr == nil {
				cmd := exec.Command("pdftotext", "-layout", path, "-")
				var stdout bytes.Buffer
				cmd.Stdout = &stdout
				if err := cmd.Run(); err == nil {
					text = stdout.String()
				}
			}
			if text == "" {
				return mcpToolError("vision_pdf_extract: " + err.Error() + "; also tried pdftotext (not found)")
			}
		}
	} else if _, lerr := exec.LookPath("pdftotext"); lerr == nil {
		cmd := exec.Command("pdftotext", "-layout", path, "-")
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		if err := cmd.Run(); err != nil {
			return mcpToolError("vision_pdf_extract: " + err.Error())
		}
		text = stdout.String()
	} else {
		return mcpToolError("vision_pdf_extract: no extractor available (need macOS or pdftotext on PATH)")
	}

	if strings.TrimSpace(text) == "" {
		return mcpToolResult("PDF extracted but no text found (scanned/image PDF — OCR it with vision_analyze_image per page, or set a vision provider).")
	}
	return mcpToolResult(text)
}

// ---------------------------------------------------------------------------
// vision_diff — pixel diff between two images (pure stdlib, $0)
// ---------------------------------------------------------------------------

// handleVisionDiff implements vision_diff: decodes two images, compares pixels
// (nearest-neighbor scaling B to A if sizes differ), reports changed-ratio +
// bounding box of the changed region.
func (s *HTTPServer) handleVisionDiff(args json.RawMessage) interface{} {
	var a struct {
		SourceA string `json:"source_a"`
		SourceB string `json:"source_b"`
	}
	json.Unmarshal(args, &a)
	if a.SourceA == "" || a.SourceB == "" {
		return mcpToolError("vision_diff: source_a and source_b are required (paths, base64:, data:, or URLs)")
	}
	pa, err := s.visionSourceToFile(a.SourceA)
	if err != nil {
		return mcpToolError("vision_diff: " + err.Error())
	}
	defer os.Remove(pa)
	pb, err := s.visionSourceToFile(a.SourceB)
	if err != nil {
		return mcpToolError("vision_diff: " + err.Error())
	}
	defer os.Remove(pb)

	imgA, err := decodeImageFile(pa)
	if err != nil {
		return mcpToolError("vision_diff a: " + err.Error())
	}
	imgB, err := decodeImageFile(pb)
	if err != nil {
		return mcpToolError("vision_diff b: " + err.Error())
	}

	bounds := imgA.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	bw, bh := imgB.Bounds().Dx(), imgB.Bounds().Dy()
	scaledB := imgB
	if bw != w || bh != h {
		scaledB = resizeNearest(imgB, w, h)
	}

	var changed int64
	minX, minY, maxX, maxY := w, h, -1, -1
	total := int64(w) * int64(h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r1, g1, b1, _ := imgA.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			r2, g2, b2, _ := scaledB.At(x, y).RGBA()
			if colorDist(r1, g1, b1, r2, g2, b2) > 24 {
				changed++
				if x < minX {
					minX = x
				}
				if x > maxX {
					maxX = x
				}
				if y < minY {
					minY = y
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	ratio := 0.0
	if total > 0 {
		ratio = float64(changed) / float64(total)
	}
	out := map[string]interface{}{
		"ok":             true,
		"width":          w,
		"height":         h,
		"changed_pixels": changed,
		"change_ratio":   fmt.Sprintf("%.4f", ratio),
		"change_percent": fmt.Sprintf("%.2f%%", ratio*100),
	}
	if changed > 0 {
		out["changed_bbox"] = map[string]int{"x": minX, "y": minY, "w": maxX - minX + 1, "h": maxY - minY + 1}
	} else {
		out["changed_bbox"] = nil
		out["identical"] = true
	}
	return mcpToolJSON(out)
}

func decodeImageFile(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

func colorDist(r1, g1, b1, r2, g2, b2 uint32) float64 {
	dr := float64(int(r1>>8) - int(r2>>8))
	dg := float64(int(g1>>8) - int(g2>>8))
	db := float64(int(b1>>8) - int(b2>>8))
	return dr*dr + dg*dg + db*db
}

// resizeNearest scales src to (w,h) using nearest-neighbor sampling.
func resizeNearest(src image.Image, w, h int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw == 0 || sh == 0 {
		return src
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		sy := b.Min.Y + (y*sh)/h
		for x := 0; x < w; x++ {
			sx := b.Min.X + (x*sw)/w
			dst.Set(x, y, src.At(sx, sy))
		}
	}
	return dst
}

// ---------------------------------------------------------------------------
// mac_ui_snapshot — macOS Accessibility element tree (free structural vision)
// ---------------------------------------------------------------------------

// macUISnapshot dumps the frontmost app's UI element tree (role: title/value)
// via the macOS Accessibility API. The Mac equivalent of droid_ui_texts / DOM.
// Requires Accessibility permission for the hosting terminal app.
func macUISnapshot() (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("macOS accessibility snapshot is only available on macOS")
	}
	script := `tell application "System Events"
  set frontProc to first process whose frontmost is true
  set procName to name of frontProc
  set winTitle to ""
  try
    set winTitle to name of front window of frontProc
  end try
  set lines to {}
  try
    repeat with w in windows of frontProc
      repeat with el in UI elements of w
        try
          set r to role of el
          set t to ""
          try
            set t to value of el
          end try
          if t is "" then
            try
              set t to title of el
            end try
          end if
          if t is not "" then
            set end of lines to (r & ": " & t)
          end if
        end try
      end repeat
    end repeat
  end try
  return (procName & "||" & winTitle & "||" & (lines as string))
end tell`
	cmd := exec.Command("osascript", "-e", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("macOS accessibility: %v: %s (grant Accessibility permission to your terminal in System Settings → Privacy & Security → Accessibility)", err, strings.TrimSpace(stderr.String()))
	}
	parts := strings.SplitN(stdout.String(), "||", 3)
	if len(parts) != 3 {
		return "", fmt.Errorf("macOS accessibility: unexpected output")
	}
	return fmt.Sprintf("Frontmost app: %s\nWindow: %s\nElements:\n%s", parts[0], parts[1], strings.ReplaceAll(parts[2], ", ", "\n")), nil
}

// handleMacUISnapshot implements mac_ui_snapshot.
func (s *HTTPServer) handleMacUISnapshot(args json.RawMessage) interface{} {
	snap, err := macUISnapshot()
	if err != nil {
		return mcpToolError(err.Error())
	}
	return mcpToolResult(snap)
}

// ---------------------------------------------------------------------------
// HTTP settings surface — GET /vision/status, PUT /vision/key
// (consumed by the web dashboard and mobile settings; never returns keys)
// ---------------------------------------------------------------------------

func (s *HTTPServer) handleVisionStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	keys := visionKeysFromConfig()
	providers := []string{}
	if os.Getenv("MISTRAL_API_KEY") != "" || keys["mistral"] != "" {
		providers = append(providers, "mistral")
	}
	if os.Getenv("OPENAI_API_KEY") != "" || keys["openai"] != "" {
		providers = append(providers, "openai")
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" || keys["anthropic"] != "" {
		providers = append(providers, "anthropic")
	}
	active := os.Getenv("YAVER_VISION_PROVIDER")
	if active == "" && len(providers) > 0 {
		active = providers[0]
	}
	freeOCRNote := "macOS Vision framework — $0, on-device"
	freeOCR := runtime.GOOS == "darwin"
	if !freeOCR {
		_, tesseractErr := exec.LookPath("tesseract")
		if tesseractErr == nil {
			freeOCR = true
			freeOCRNote = "tesseract — $0, on-device (apt install tesseract-ocr)"
		}
	}
	writeJSON(w, 200, map[string]interface{}{
		"ok":                        true,
		"providers_configured":      providers,
		"active_provider":           active,
		"model_override":            os.Getenv("YAVER_VISION_MODEL"),
		"free_ocr":                  freeOCR,
		"free_ocr_note":             freeOCRNote,
		"mac_ui_snapshot_available": runtime.GOOS == "darwin",
		"set_hint":                  "Store a key with `yaver set vision-key <provider> <key>`, or PUT /vision/key {provider, key}.",
	})
}

func (s *HTTPServer) handleVisionKeySet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Provider string `json:"provider"`
		Key      string `json:"key"`
		Clear    bool   `json:"clear"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	switch provider {
	case "mistral", "openai", "anthropic":
	default:
		http.Error(w, "provider must be mistral | openai | anthropic", http.StatusBadRequest)
		return
	}
	cfg, err := LoadConfig()
	if err != nil {
		http.Error(w, "load config: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if cfg.VisionKeys == nil {
		cfg.VisionKeys = map[string]string{}
	}
	if req.Clear || strings.TrimSpace(req.Key) == "" {
		delete(cfg.VisionKeys, provider)
	} else {
		cfg.VisionKeys[provider] = strings.TrimSpace(req.Key)
	}
	if err := SaveConfig(cfg); err != nil {
		http.Error(w, "save config: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, 200, map[string]interface{}{
		"ok":       true,
		"provider": provider,
		"stored":   !req.Clear && strings.TrimSpace(req.Key) != "",
		"note":     "Key stored in ~/.yaver/config.json vision_keys — the shared seam for MCP vision tools, `yaver vision`, QA, and ghost vision.",
	})
}
