# opencode + Yaver MCP — Vision Audit (2026-08-09)

Status: shipped in `desktop/agent` (runner-aware vision core), opencode plugin, CLI verb, web + mobile settings. This doc is the audit that drove the change and the reference for how the pieces fit.

## The problem

opencode drives **DeepSeek V4 Flash** (`~/.config/opencode/opencode.json`), a **text-only** model. It cannot consume MCP image blocks, and a pasted screenshot / crash-log capture / UI-failure image is invisible to it. Claude Code and Codex run vision-capable models and have no such gap — so the ask was to close the visual-input gap between opencode and those runners **using Yaver's own MCP + on-device stack**, not an external SaaS.

Decisions (user-confirmed): **free-first** vision (no-cost native OCR/structural trees preferred; Mistral etc. optional), a **tiny opencode plugin** for the paste flow, and scope = core + free native backends first.

## What existed (audit findings)

| Area | Finding | File:line |
|---|---|---|
| MCP server | Hand-rolled JSON-RPC 2.0, HTTP + stdio transports sharing one dispatcher | `desktop/agent/httpserver.go:6608`, `main.go:12653` |
| Runner awareness | `initialize` ignored `clientInfo` in **both** transports → server couldn't know who was calling | `httpserver.go:6717`, `main.go:12720` |
| Image-emitting tools | `browser_screenshot`, `screenshot`, `droid_frame`, `simulator_screenshot`, `screenlog_frames sample=N`, `robot_camera`, `runtime_frame`, `appletv_now_playing`, `circuit_plot` — MCP image blocks `{"type":"image","data":b64,"mimeType":...}` | `mcp_tools.go` + dispatcher |
| Text "free vision" | `selenium_snapshot` (flattened elements), `browser_get_dom` (HTML), `droid_ui_texts` (uiautomator), `screenlog_process_model` (episode skeleton) — already model-free | `mcp_selenium.go:360`, `httpserver.go:17516/10471/16451` |
| Vision-LLM stack | `testkit.InspectImage` → `{verdict pass/warn/fail, issues}`; `LoadVisionConfig` env: Mistral→OpenAI→Anthropic→**silent local Ollama** | `desktop/agent/testkit/visual_llm.go:58,112` |
| QA / ghost | `qa_model.go` reuses `InspectImage`; `ghost_vision.go` OpenAI-compatible locator | `qa_model.go:129`, `ghost_vision.go:45` |
| No MCP vision tool | Nothing wrapped `InspectImage` as an MCP tool; text-only models had no image→text path | — |
| Inconsistencies | `selenium_screenshot` returned base64 **inside text**; `feedback_show` claimed "screenshot URL" but returned **file paths** | `mcp_selenium.go:404`, `feedback.go:277` |
| Mac native | `captureScreen()` only; **no** Vision-framework OCR, no Accessibility tree, no PDFKit, no OpenCV — all available on this Mac (swift 6.2.3, Xcode, Vision.framework) | `tools.go:107` |
| `vision_keys` | Doc comment in `visual_llm.go` claimed a `~/.yaver/config.json` `vision_keys` map — **no reader existed** (env-only) | `visual_llm.go:29` |

## What shipped

### Go agent — runner-aware vision core (`desktop/agent/mcp_vision.go`, new)
- `initialize` in both transports captures `clientInfo` → `setMCPClient` (`httpserver.go`, `main.go`).
- `mcpClientVisionMode()`: `YAVER_MCP_VISION_MODE=text-only|vision|auto` env → client table (`claude*`/`codex` → vision) → opencode model sniff from `~/.config/opencode/opencode.json` (`deepseek*`/`qwen3-coder*` → text-only) → safe default text-only.
- `finalizeMCPResult()` — one seam at both `tools/call` sites: for text-only clients, image content blocks are **replaced with text analysis** (dims → free Mac OCR → optional vision-LLM verdict). Vision-capable clients are untouched.

### New MCP tools
- `vision_analyze_image {source: path|base64:|data:|URL | session_id, question?, tier: free|fast|quality, provider?, model?}` → dims + OCR + verdict.
- `ui_inspect {surface: browser|selenium|droid|simulator|mac, session_id?, device?}` → one-call capture + text report.
- `testkit_visual_check {session_id|image, question?}` → PASS/WARN/FAIL for Selenium visual regression.
- `vision_pdf_extract {source}` → PDFKit text (macOS) / `pdftotext` fallback.
- `vision_diff {source_a, source_b}` → pure-Go pixel diff: changed ratio + bbox.
- `mac_ui_snapshot {}` → macOS Accessibility element tree (the Mac's `droid_ui_texts`).

### Free native backends ($0, on-device)
- `macOCR` — ~60-line Swift helper (`VNRecognizeTextRequest`), compiled on demand to `~/.yaver/bin/macocr` (`macOCRSwiftSource` embedded).
- `macUISnapshot` — `osascript System Events` accessibility dump.
- `macPDFText` — PDFKit helper (`~/.yaver/bin/macpdftext`).
- `vision_diff`/`resizeNearest` — pure stdlib image ops (OpenCV-style without the dep).

### Cost plumbing
- `resolvedVisionConfig()` — **no silent Ollama**; env keys → `vision_keys` config map → per-call `provider`/`model` overrides; `YAVER_VISION_PROVIDER`/`YAVER_VISION_MODEL` selection. Missing provider ⇒ named error, never a silent `warn`.
- Describe-result cache keyed on file sha256 (64 entries, 10 min TTL) — screenlog/keyframe loops don't re-pay.
- Free tier routing: OCR + structural trees first; vision LLM only for semantic judgment.

### Shared config seam (`vision_keys`)
- `Config.VisionKeys map[string]string` (`config.go`) — the doc-claimed seam is now real.
- `yaver set vision-key <provider> <key>` / `--clear` (`set_cmd.go`); `yaver vision status` (`vision_cmd.go`).
- HTTP `GET /vision/status` + `PUT /vision/key` (auth-wrapped) for web/mobile — keys never returned.

### CLI verb — `yaver vision` (`vision_cmd.go`, new)
- `yaver vision describe <image> [--tier|--provider|--model|--json]`, `status`, `extract-pdf`. Same pipeline as MCP; the headless seam the opencode plugin shells out to.

### opencode paste plugin (`opencode-plugins/yaver-vision/yaver-vision.ts`)
- Registered in `~/.config/opencode/opencode.json`. `chat.message` + `experimental.chat.messages.transform` convert image parts → `yaver vision describe --tier free` text for text-only models; images kept at `~/.yaver/clipboard-images/` so the model can follow up with `vision_analyze_image tier=fast`. Vision models untouched.
- `mcpInstructions()` now teaches every client the vision workflow.

### Parity fixes
- `selenium_screenshot` → first-class MCP image block (text-only clients get it auto-rewritten).
- `feedback_show` description fixed: screenshots are **file paths** (read via `vision_analyze_image`).

### Web + mobile settings surfaces
- `web/components/dashboard/VisionSettingsCard.tsx` (+ `agentClient.getVisionStatus`/`setVisionKey`) mounted in `SettingsView.tsx`.
- `mobile/src/components/VisionSettingsSection.tsx` (+ `quicClient.getVisionStatus`/`setVisionKey`) mounted in `app/(tabs)/settings.tsx`.

## Using it

1. **Restart opencode** (config + plugin load once at startup).
2. Paste a screenshot in the opencode terminal → the plugin OCRs it locally and injects the text; ask for a verdict and the model calls `vision_analyze_image tier=fast`.
3. Selenium visual regression: `selenium_start → selenium_navigate → selenium_snapshot → testkit_visual_check` → PASS/WARN/FAIL.
4. Configure a key once from web/mobile settings or `yaver set vision-key mistral sk-…` — every surface picks it up.

## Known limits / next steps
- Video: compose `screenlog_process_model` + keyframe `vision_analyze_image` today; a dedicated `video_analyze` tool is a follow-up.
- Mac OCR compiles its helper on first use (`swiftc`, Xcode CLT required once).
- `vision_keys` keys are plaintext in `~/.yaver/config.json` (owner-only file, same posture as the env vars they mirror); moving to the encrypted vault is a follow-up.
- Untested-on-this-box surfaces (Windows/Linux) degrade to pdftotext/vision-LLM only — free OCR is macOS-only.
