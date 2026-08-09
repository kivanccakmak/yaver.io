// yaver-vision.ts — opencode plugin: gives a TEXT-ONLY model (e.g. DeepSeek
// V4 Flash) eyes by converting pasted images into text analysis through the
// LOCAL yaver agent — the same free-first pipeline as the MCP vision_* tools
// (dims → macOS Vision-framework OCR → optional vision-LLM verdict).
//
// Why: opencode with a non-vision model has no usable image path — pasted
// screenshots, crash-log captures and UI-failure images would otherwise be
// invisible. This plugin intercepts image parts BEFORE they reach the
// provider (chat.message) and again at the request boundary
// (experimental.chat.messages.transform, belt-and-braces) and replaces them
// with a text analysis. Vision-capable models (claude/gpt-5/gemini) are left
// untouched so they keep native image blocks.
//
// The analyzed image is kept at ~/.yaver/clipboard-images/paste-*.png so the
// model can call `vision_analyze_image {source: "<path>"}` for a deeper
// semantic verdict (tier=fast) if it needs more than OCR.
//
// Requires `yaver vision describe` (agent CLI 1.99.410+) on the local yaver
// binary. Point YAVER_BIN elsewhere to use a different install.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const YAVER_BIN =
  process.env.YAVER_BIN ||
  join(homedir(), ".yaver", "bin", "current", "darwin-arm64", "yaver")

const KNOWN_VISION_PREFIXES = [
  "claude",
  "gpt-5",
  "gpt-4",
  "gemini",
  "glm-4v",
  "qwen2.5-vl",
  "qwen3-vl",
  "llava",
  "pixtral",
]

function isTextOnlyModel(model) {
  const id = model ? `${model.providerID || ""}/${model.modelID || ""}`.toLowerCase() : ""
  if (!id) return true // unknown → conservative: adapt to text
  return !KNOWN_VISION_PREFIXES.some((p) => id.startsWith(p))
}

function yaverVisionDescribe(data, mimeType) {
  const dir = join(homedir(), ".yaver", "clipboard-images")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  const mime = mimeType || "image/png"
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : ".png"
  const file = join(
    dir,
    `paste-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`,
  )
  try {
    writeFileSync(file, Buffer.from(data, "base64"))
  } catch (err) {
    return `[pasted image could not be saved locally: ${String(err).slice(0, 200)}]`
  }
  try {
    const out = execFileSync(
      YAVER_BIN,
      ["vision", "describe", file, "--tier", "free"],
      { encoding: "utf8", timeout: 60_000 },
    )
    const text = (out || "").trim()
    if (!text) {
      throw new Error("empty analysis")
    }
    return `[Pasted image — analyzed locally by Yaver (free OCR). Original saved at ${file}]\n${text}\n\nIf you need a semantic verdict (is the UI broken?), call vision_analyze_image with source: "${file}" and tier: "fast".`
  } catch (err) {
    return `[Pasted image saved at ${file} — local analysis unavailable: ${String(err).slice(0, 300)}. Call vision_analyze_image with source: "${file}" to analyze it.]`
  }
}

// Convert image parts to text in place. Runs on the user's message and again
// on the provider-bound messages, so whichever path opencode takes, a
// text-only model always receives the analysis.
function convertImageParts(parts) {
  if (!Array.isArray(parts)) return
  for (const part of parts) {
    if (part && part.type === "image" && part.data) {
      const analysis = yaverVisionDescribe(part.data, part.mimeType)
      part.type = "text"
      part.text = analysis
      delete part.data
      delete part.mimeType
    }
  }
}

export default async () => {
  return {
    // Fires when a new user message is received — the paste lands here first.
    "chat.message": async (input, output) => {
      try {
        if (!isTextOnlyModel(input && input.model)) return
        if (output && Array.isArray(output.parts)) {
          convertImageParts(output.parts)
        }
      } catch {}
    },
    // Belt-and-braces at the provider request boundary: any image part that
    // survived (or was added by another plugin) is converted here.
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        for (const msg of (output && output.messages) || []) {
          convertImageParts(msg && msg.parts)
        }
      } catch {}
    },
  }
}
