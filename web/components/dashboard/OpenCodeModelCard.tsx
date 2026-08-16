"use client";

// OpenCodeModelCard — change the coding model opencode uses on a machine
// (default + build + plan agents) from the dashboard. Backed by
// GET/POST /runner/opencode/config on the connected agent, peer-proxied to
// the selected owned machine (agent-client.getOpenCodeConfig/saveOpenCodeConfig).
// The web sibling of the mobile OpenCodeConfigModal.

import { useCallback, useEffect, useMemo, useState } from "react";
import { agentClient, type OpenCodeConfigSummary } from "@/lib/agent-client";
import type { Device } from "@/lib/use-devices";

type Props = {
  devices: Device[];
};

export default function OpenCodeModelCard({ devices }: Props) {
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
  const [model, setModel] = useState("");
  const [buildModel, setBuildModel] = useState("");
  const [planModel, setPlanModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const targetId = target === "__local__" ? undefined : target;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await agentClient.getOpenCodeConfig(targetId);
      setCfg(c);
      setModel(c?.model || "");
      setBuildModel(c?.buildModel || "");
      setPlanModel(c?.planModel || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const models = cfg?.models || [];
  const modelOptions = models.map((m) => m.id);
  const byProvider = new Map<string, string[]>();
  for (const m of models) {
    const p = m.provider || "unknown";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m.id);
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const patch: { model?: string; buildModel?: string; planModel?: string } = {};
      if (model) patch.model = model;
      if (buildModel) patch.buildModel = buildModel;
      if (planModel) patch.planModel = planModel;
      const out = await agentClient.saveOpenCodeConfig(patch, targetId);
      if (!out.ok) {
        setError(out.error || "save failed");
      } else {
        setSaved("Saved. Quit and restart opencode on that machine to apply.");
        if (out.config) {
          setCfg(out.config);
          setModel(out.config.model || "");
          setBuildModel(out.config.buildModel || "");
          setPlanModel(out.config.planModel || "");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const selectCls =
    "mt-1 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 outline-none focus:border-surface-500";

  return (
    <section className="rounded-xl border border-surface-800 bg-surface-950/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-surface-200">Coding model (opencode)</h3>
          <p className="mt-0.5 text-xs text-surface-500">
            Which model opencode uses on a machine — e.g. deepseek-v4-flash instead of GLM.
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
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Default model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)} className={selectCls}>
                <option value="">(inherit)</option>
                {modelOptions.map((m) => (
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
                {modelOptions.map((m) => (
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
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void save()}
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

          <div className="flex flex-wrap gap-1.5">
            {[...byProvider.entries()].map(([p, ids]) => (
              <span
                key={p}
                className="rounded-full border border-surface-700 px-2 py-0.5 text-[10px] text-surface-500"
                title={ids.join("\n")}
              >
                {p}
                {cfg?.providers?.find((pr) => pr.id === p)?.hasApiKey ? " · key ✓" : ""}
              </span>
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-surface-600">
            {cfg?.path ? `Config: ${cfg.path}` : "No opencode config found on that machine yet."} Changes need an
            opencode restart on the target machine. The same controls exist on mobile (Settings → Coding agents →
            opencode) and via MCP (opencode_config_set).
          </p>
        </div>
      )}
    </section>
  );
}
