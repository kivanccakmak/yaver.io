"use client";

// OpenCodeSettingsView — the single first-class hub for opencode on the
// desktop app (the Electron shell renders the dashboard, so this IS the
// desktop surface).
//
// Before this view existed, opencode config was scattered across four places:
// the chat composer's provider/model chips, the Tools tab section, the
// Settings "Coding model" card, and the Devices tab runner row. Each showed a
// slice; none let a user answer "what does opencode run on my machine and how
// do I point it at my own key?" in one place. This view composes the pieces
// (all backed by the same GET/POST /runner/opencode/config seam):
//
//   1. per-machine target select (local + owned online peers),
//   2. default / small / build / plan model pickers from live opencode.json,
//   3. provider cards with baseURL editing + delete,
//   4. per-provider API-key entry ("✓ Key configured · Change key") — the
//      agent stores the key in opencode.json + auth.json and only returns a
//      hasApiKey boolean over the wire,
//   5. add-provider form with one-click presets (OpenRouter, GLM, Ollama,
//      DeepSeek, Groq, …),
//   6. diagnostics banner + a goal-plugin status note.
//
// The mobile twin is OpenCodeConfigModal; the CLI twin is `yaver code set
// byok` / `yaver runner-auth setup opencode`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { agentClient, type OpenCodeConfigSummary } from "@/lib/agent-client";
import type { Device } from "@/lib/use-devices";
import { ProviderCard, AddProviderForm } from "./ToolsView";

type Props = {
  devices: Device[];
};

export default function OpenCodeSettingsView({ devices }: Props) {
  const peers = useMemo(
    () =>
      devices
        .filter((device) => device.online)
        .map((device) => ({ id: device.id, name: device.name || device.id })),
    [devices],
  );
  const targets = useMemo(() => [{ id: "__local__", name: "This machine" }, ...peers], [peers]);

  const [target, setTarget] = useState("__local__");
  const [cfg, setCfg] = useState<OpenCodeConfigSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable fields (draft state — save applies the whole patch).
  const [defaultAgent, setDefaultAgent] = useState("");
  const [model, setModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [buildModel, setBuildModel] = useState("");
  const [planModel, setPlanModel] = useState("");

  // Per-provider API key entry. Key values never leave the box — the agent
  // returns only hasApiKey booleans; when a key is set we render a badge and
  // a "Change key" path that replaces it.
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [keySaving, setKeySaving] = useState<Record<string, boolean>>({});

  const targetId = target === "__local__" ? undefined : target;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await agentClient.getOpenCodeConfig(targetId);
      setCfg(c);
      setDefaultAgent(c?.defaultAgent || "");
      setModel(c?.model || "");
      setSmallModel(c?.smallModel || "");
      setBuildModel(c?.buildModel || "");
      setPlanModel(c?.planModel || "");
      setKeyDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = cfg?.models || [];
  const modelIds = modelOptions.map((m) => m.id);

  const save = async (patch: Parameters<typeof agentClient.saveOpenCodeConfig>[0]) => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const out = await agentClient.saveOpenCodeConfig(patch, targetId);
      if (!out.ok) {
        setError(out.error || "save failed");
        return false;
      }
      setSaved("Saved. Quit and restart opencode on that machine to apply.");
      if (out.config) {
        setCfg(out.config);
        setDefaultAgent(out.config.defaultAgent || "");
        setModel(out.config.model || "");
        setSmallModel(out.config.smallModel || "");
        setBuildModel(out.config.buildModel || "");
        setPlanModel(out.config.planModel || "");
        setKeyDraft({});
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveModels = () =>
    void save({
      ...(defaultAgent ? { defaultAgent } : {}),
      ...(model ? { model } : {}),
      ...(smallModel ? { smallModel } : {}),
      ...(buildModel ? { buildModel } : {}),
      ...(planModel ? { planModel } : {}),
    });

  const saveKey = async (providerId: string) => {
    const key = (keyDraft[providerId] || "").trim();
    if (!key) return;
    setKeySaving((s) => ({ ...s, [providerId]: true }));
    await save({ providers: [{ id: providerId, apiKey: key }] });
    setKeySaving((s) => ({ ...s, [providerId]: false }));
  };

  const selectCls =
    "mt-1 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 outline-none focus:border-surface-500";

  return (
    <section className="rounded-xl border border-surface-800 bg-surface-950/70 p-4">
      {/* Header + machine target — the same "which box" selector every other
          settings card uses, so configuring the local machine vs a remote
          peer is one dropdown, not a different screen. */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-surface-200">OpenCode — provider & model</h3>
          <p className="mt-0.5 text-xs text-surface-500">
            Pick the provider, its API key, and which model opencode runs on this machine. Everything lives in the
            box's <span className="font-mono">opencode.json</span> + auth store; keys never reach Convex.
          </p>
        </div>
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="rounded-lg border border-surface-700 bg-surface-900 px-2 py-1.5 text-xs text-surface-200 outline-none"
          title="Machine to configure"
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      )}
      {saved && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{saved}</div>
      )}

      {cfg?.diagnostics && cfg.diagnostics.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {cfg.diagnostics.join(" · ")}
        </div>
      )}

      {busy ? (
        <div className="mt-4 text-xs text-surface-500">Loading config…</div>
      ) : (
        <div className="mt-4 space-y-5">
          {/* 1 — Model pickers (default + per-agent) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Default agent</span>
              <input
                value={defaultAgent}
                onChange={(event) => setDefaultAgent(event.target.value)}
                placeholder="build / plan / custom"
                className={selectCls}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Default model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)} className={selectCls}>
                <option value="">(inherit)</option>
                {modelIds.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Small model</span>
              <select value={smallModel} onChange={(event) => setSmallModel(event.target.value)} className={selectCls}>
                <option value="">(inherit)</option>
                {modelIds.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Build agent</span>
              <select value={buildModel} onChange={(event) => setBuildModel(event.target.value)} className={selectCls}>
                <option value="">(inherit)</option>
                {modelIds.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Plan agent</span>
              <select value={planModel} onChange={(event) => setPlanModel(event.target.value)} className={selectCls}>
                <option value="">(inherit)</option>
                {modelIds.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 2 — Discovered models (click a chip to set the default) */}
          {modelOptions.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-surface-500">
                Discovered models
              </div>
              <div className="flex flex-wrap gap-2">
                {modelOptions.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs ${
                      model === m.id
                        ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                        : "border-surface-700 bg-surface-950 text-surface-300"
                    }`}
                    title={m.provider || m.source || ""}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={saveModels}
              disabled={saving}
              className="rounded-lg bg-surface-200 px-3 py-1.5 text-xs font-medium text-surface-950 hover:bg-surface-100 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save models"}
            </button>
            <button
              onClick={() => void load()}
              disabled={busy}
              className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200"
            >
              Refresh
            </button>
          </div>

          {/* 3 — Providers: API key per provider, baseURL edit, delete */}
          {cfg?.providers && cfg.providers.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-surface-500">
                Providers
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {cfg.providers.map((provider) => (
                  <div key={provider.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-surface-300">{provider.name || provider.id}</span>
                      {provider.hasApiKey ? (
                        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-200">
                          ✓ Key configured
                        </span>
                      ) : (
                        <span className="rounded-full border border-surface-700 px-2 py-0.5 text-[10px] text-surface-500">
                          no key
                        </span>
                      )}
                    </div>
                    {/* API-key entry — the first-class "set my own key" path
                        (OpenRouter, GLM, DeepSeek, …). Password input; the
                        value is sent once to the box and never echoed back. */}
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={keyDraft[provider.id] || ""}
                        onChange={(event) => setKeyDraft((s) => ({ ...s, [provider.id]: event.target.value }))}
                        placeholder={provider.hasApiKey ? "Paste a new key to replace" : "Paste API key"}
                        className="flex-1 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-surface-100 outline-none focus:border-surface-500"
                        autoComplete="off"
                      />
                      <button
                        onClick={() => void saveKey(provider.id)}
                        disabled={!keyDraft[provider.id]?.trim() || keySaving[provider.id]}
                        className="rounded border border-indigo-500/40 bg-indigo-500/10 px-3 py-1 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-40"
                      >
                        {keySaving[provider.id] ? "…" : "Set key"}
                      </button>
                    </div>
                    <ProviderCard
                      provider={provider}
                      onSaveBaseUrl={async (baseUrl) => {
                        if (await save({ providers: [{ id: provider.id, baseUrl }] })) setSaved(null);
                      }}
                      onDelete={async () => {
                        if (await save({ providers: [{ id: provider.id, delete: true }] })) setSaved(null);
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4 — Add a provider (one-click presets: OpenRouter, GLM, Ollama, …) */}
          <details className="rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.16em] text-surface-300">
              + Add provider
            </summary>
            <AddProviderForm
              onAdd={async ({ id, baseUrl, apiKey, name }) => {
                if (await save({ providers: [{ id, baseUrl, apiKey, name }] })) {
                  setSaved(null);
                  return true;
                }
                return false;
              }}
            />
          </details>

          {/* 5 — Goal-plugin note. Goal-mode (/goal + create_goal across
              turns) requires the @prevalentware/opencode-goal-plugin on the
              runner machine; the agent treats it as best-effort, so this is
              an honest note, not a false "installed" claim. */}
          <p className="text-[11px] leading-relaxed text-surface-600">
            Goal-mode tasks (<span className="font-mono">/goal …</span>) need the opencode-goal-plugin on the runner
            machine — the agent enables it automatically when present. Keys are stored on the box
            (<span className="font-mono">{cfg?.path || "~/.config/opencode/opencode.jsonc"}</span>) and in its auth
            store; only "has key" booleans are synced to Convex. The same controls exist on mobile (Settings → Coding
            agents → opencode) and via MCP (opencode_config_set).
          </p>
        </div>
      )}
    </section>
  );
}
