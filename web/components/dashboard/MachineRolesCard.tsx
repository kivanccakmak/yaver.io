"use client";

/**
 * MachineRolesCard — the OPTIONAL runner/render machine slicing, configured
 * from Settings (docs/architecture/RUNNER_RENDER_SPLIT.md).
 *
 * "Runner" is the machine that executes AI coding tasks (vibing chat streams
 * from it); "Render" is the machine that holds/serves the app (dev servers,
 * builds, previews, store deploys). No config — or both pointing at the same
 * machine — is today's single-box behavior, and that stays the default.
 *
 * v1 scope: the account-wide FAVORITE row (no projectName). Per-project
 * overrides ride the same Convex row family when the Vibing UI grows them.
 *
 * Guest compliance: this card edits the OWNER's settings doc — guests never
 * read it, and each box enforces guest scopes per request anyway (a
 * render-only guest gets previews from the render box; the runner box
 * refuses task dispatch at its own auth layer, fail-closed).
 */

import { useCallback, useEffect, useState } from "react";
import { CONVEX_URL } from "@/lib/constants";

type DeviceRow = { id: string; name: string; platform?: string };
type RolesRow = {
  projectName?: string;
  runnerDeviceId: string;
  renderDeviceId?: string;
  workspace?: "runner-clone" | "render-ssh";
  autoPush?: "never" | "ask" | "always";
};

export function MachineRolesCard({ token, devices }: { token: string | null; devices: DeviceRow[] }) {
  const [loaded, setLoaded] = useState(false);
  const [runnerId, setRunnerId] = useState("");
  const [renderId, setRenderId] = useState("");
  const [workspace, setWorkspace] = useState<"runner-clone" | "render-ssh">("runner-clone");
  const [autoPush, setAutoPush] = useState<"never" | "ask" | "always">("ask");
  const [savedRow, setSavedRow] = useState<RolesRow | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${CONVEX_URL}/settings`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        const rows: RolesRow[] = data?.settings?.machineRolesByProject || [];
        const favorite = rows.find((r) => !r.projectName) || null;
        if (cancelled) return;
        setSavedRow(favorite);
        if (favorite) {
          setRunnerId(favorite.runnerDeviceId);
          setRenderId(favorite.renderDeviceId || favorite.runnerDeviceId);
          setWorkspace(favorite.workspace || "runner-clone");
          setAutoPush(favorite.autoPush || "ask");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch(`${CONVEX_URL}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `settings: HTTP ${res.status}`);
  }, [token]);

  const save = useCallback(async () => {
    if (!token || !runnerId) return;
    setBusy(true);
    setNote(null);
    try {
      const row: RolesRow = {
        runnerDeviceId: runnerId,
        renderDeviceId: renderId || runnerId,
        workspace,
        autoPush,
      };
      await post({ machineRolesForProject: { ...row, updatedAt: Date.now() } });
      setSavedRow(row);
      const runnerName = devices.find((d) => d.id === runnerId)?.name || runnerId.slice(0, 8);
      const renderName = devices.find((d) => d.id === (renderId || runnerId))?.name || (renderId || runnerId).slice(0, 8);
      setNote(
        runnerId === (renderId || runnerId)
          ? `Saved: ${runnerName} runs tasks and renders (single-box).`
          : `Saved: ${runnerName} runs the AI tasks · ${renderName} builds and renders. Vibing chat will stream from the runner, previews from the renderer.`,
      );
    } catch (err) {
      setNote(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [autoPush, devices, post, renderId, runnerId, token, workspace]);

  const clear = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setNote(null);
    try {
      await post({ machineRolesForProject: { runnerDeviceId: null } });
      setSavedRow(null);
      setNote("Cleared — back to single-box behavior (the connected machine does everything).");
    } catch (err) {
      setNote(`Could not clear: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [post, token]);

  const selectCls = "h-9 w-full rounded-md border border-surface-700 bg-surface-900/60 px-2 text-xs text-surface-200";

  return (
    <section className="mb-4 rounded-lg border border-surface-800 bg-surface-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-surface-200">Machine roles</h2>
        {savedRow ? (
          <span className="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
            split active
          </span>
        ) : (
          <span className="rounded-full border border-surface-700 bg-surface-800/60 px-2.5 py-0.5 text-[11px] text-surface-400">
            single-box (default)
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[12px] text-surface-400">
        Optional: run AI tasks on one machine and build/render on another. Leave both on the same
        machine — or clear — for today&apos;s behavior. Example: a Linux box with signed-in runners as
        the AI runner, a Mac with Xcode/Flutter as the renderer.
      </p>
      {!loaded ? (
        <p className="mt-2 text-[12px] text-surface-500">Loading…</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-surface-500">Default AI runner</span>
              <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)} className={selectCls}>
                <option value="">— pick a machine —</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.platform ? ` · ${d.platform}` : ""}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-surface-500">Default renderer / build machine</span>
              <select value={renderId} onChange={(e) => setRenderId(e.target.value)} className={selectCls}>
                <option value="">same as runner</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}{d.platform ? ` · ${d.platform}` : ""}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-surface-500">Runner workspace</span>
              <select value={workspace} onChange={(e) => setWorkspace(e.target.value as "runner-clone" | "render-ssh")} className={selectCls}>
                <option value="runner-clone">Own clone — converge via git (recommended)</option>
                <option value="render-ssh">Renderer&apos;s tree over SSH (advanced)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-surface-500">Push to git remote</span>
              <select value={autoPush} onChange={(e) => setAutoPush(e.target.value as "never" | "ask" | "always")} className={selectCls}>
                <option value="ask">Ask me each time (recommended)</option>
                <option value="always">Push automatically</option>
                <option value="never">Never push — I sync manually</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !runnerId}
              onClick={() => void save()}
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-emerald-200"
            >
              Save favorite configuration
            </button>
            {savedRow ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void clear()}
                className="rounded-md border border-surface-700 px-3 py-1.5 text-xs font-semibold text-surface-300 disabled:opacity-40 hover:border-surface-600"
              >
                Clear (single-box)
              </button>
            ) : null}
          </div>
          {note ? <p className="mt-2 text-[12px] leading-4 text-surface-400">{note}</p> : null}
        </>
      )}
    </section>
  );
}
