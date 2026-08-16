"use client";

// VisionSettingsCard — configure the Yaver vision stack from the dashboard.
// Backed by GET /vision/status + PUT /vision/key on the connected agent
// (desktop/agent/mcp_vision.go). Keys are stored in ~/.yaver/config.json
// vision_keys — the shared seam read by the MCP vision_* tools, `yaver
// vision`, the QA brain and ghost vision — and are NEVER rendered back.
//
// Free-first: on-device OCR (macOS Vision framework) works with no key at
// all; a provider key just adds semantic verdicts.

import { useCallback, useEffect, useState } from "react";
import { agentClient } from "@/lib/agent-client";

type VisionStatus = {
  ok?: boolean;
  providers_configured?: string[];
  active_provider?: string;
  model_override?: string;
  free_ocr?: boolean;
  free_ocr_note?: string;
  mac_ui_snapshot_available?: boolean;
  set_hint?: string;
};

const PROVIDERS = [
  { id: "mistral", label: "Mistral (pixtral)", cheap: true },
  { id: "openai", label: "OpenAI (gpt-4o-mini)" },
  { id: "anthropic", label: "Anthropic (haiku)" },
] as const;

function Badge({ on }: { on: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
        on
          ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border border-surface-700 text-surface-500"
      }`}
    >
      {on ? "ready" : "off"}
    </span>
  );
}

export default function VisionSettingsCard() {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [provider, setProvider] = useState<string>("mistral");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await agentClient.getVisionStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (clear = false) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const out = await agentClient.setVisionKey(provider, key, clear);
      setMessage(
        clear
          ? `Cleared ${provider} — free OCR still works without a key.`
          : out.note || `${provider} key stored — every vision surface picks it up.`,
      );
      setKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const configured = new Set(status?.providers_configured ?? []);
  const modelOverride = status?.model_override || "(default per provider)";

  return (
    <section className="rounded-xl border border-surface-800 bg-surface-950/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-surface-200">Vision</h3>
          <p className="mt-0.5 text-xs text-surface-500">
            Screenshots, crash logs and UI failures → text, via Yaver MCP.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="text-xs text-surface-500 hover:text-surface-300"
        >
          refresh
        </button>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {message && <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{message}</div>}

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-surface-800 bg-surface-900/50 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-surface-300">Free on-device OCR</span>
            <Badge on={!!status?.free_ocr} />
          </div>
          <div className="mt-1 text-surface-500">{status?.free_ocr_note ?? "macOS Vision framework — $0"}</div>
        </div>
        <div className="rounded-lg border border-surface-800 bg-surface-900/50 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-surface-300">Vision LLM</span>
            <Badge on={configured.size > 0} />
          </div>
          <div className="mt-1 text-surface-500">
            {configured.size > 0 ? [...configured].join(", ") : "none — OCR only"}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-surface-500">
        Active provider: <span className="text-surface-300">{status?.active_provider || "none"}</span>
        {" · "}Model: <span className="text-surface-300">{modelOverride}</span>
        {" · "}Mac UI snapshot: <Badge on={!!status?.mac_ui_snapshot_available} />
      </div>

      <div className="mt-4 space-y-2">
        <label className="block">
          <span className="text-xs font-medium text-surface-400">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 outline-none focus:border-surface-500"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-surface-400">API key</span>
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={configured.has(provider) ? "•••••••• (stored — type to replace)" : "sk-…"}
            className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 placeholder-surface-600 outline-none focus:border-surface-500"
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void save(false)}
            disabled={busy || !key.trim()}
            className="rounded-lg bg-surface-200 px-3 py-1.5 text-xs font-medium text-surface-950 hover:bg-surface-100 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save key"}
          </button>
          {configured.has(provider) && (
            <button
              onClick={() => void save(true)}
              disabled={busy}
              className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200"
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-surface-600">
          One key enables vision everywhere: <code>vision_analyze_image</code>, <code>ui_inspect</code>,{" "}
          <code>testkit_visual_check</code> (PASS/WARN/FAIL for Selenium tests), <code>yaver vision</code>,
          the opencode paste plugin, QA and ghost vision. Keys stay in{" "}
          <code>~/.yaver/config.json</code> — never synced to Convex.
        </p>
      </div>
    </section>
  );
}
