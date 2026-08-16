"use client";

/**
 * Machine-role (runner/render split) config — the web read/write seam for
 * `userSettings.machineRolesByProject` (docs/architecture/RUNNER_RENDER_SPLIT.md).
 *
 * One hook so the Settings card, the dashboard shell (which feeds
 * agentClient.setMachineRoleRoutes) and the Vibing header all read and write
 * the SAME Convex rows — never per-surface copies. v1 scope is the
 * account-wide favorite row (no projectName); per-project overrides ride the
 * same row family.
 */

import { useCallback, useEffect, useState } from "react";
import { CONVEX_URL } from "@/lib/constants";
import { machineRolesSaveErrorMessage } from "./machineRolesErrors";
import { fanoutModeFromSettings, type FanoutMode } from "./connectionFanout";

export { machineRolesSaveErrorMessage } from "./machineRolesErrors";

export type MachineRolesRow = {
  projectName?: string;
  runnerDeviceId: string;
  secondaryRunnerDeviceId?: string;
  renderDeviceId?: string;
  secondaryRenderDeviceId?: string;
  workspace?: "runner-clone" | "render-ssh";
  autoPush?: "never" | "ask" | "always";
};

/** True when the row actually splits work across two machines. */
export function machineRolesSplitActive(row: MachineRolesRow | null | undefined): boolean {
  if (!row?.runnerDeviceId) return false;
  return Boolean(
    (row.renderDeviceId && row.renderDeviceId !== row.runnerDeviceId) ||
      (row.secondaryRunnerDeviceId && row.secondaryRunnerDeviceId !== row.runnerDeviceId) ||
      (row.secondaryRenderDeviceId && row.secondaryRenderDeviceId !== (row.renderDeviceId || row.runnerDeviceId)),
  );
}

export function useMachineRoles(token: string | null) {
  const [favorite, setFavorite] = useState<MachineRolesRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The connection fan-out preference rides the SAME /settings read — no extra
  // call. See connectionFanout.ts; unset means "all".
  const [connectionMode, setConnectionMode] = useState<FanoutMode>("all");

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${CONVEX_URL}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      const rows: MachineRolesRow[] = data?.settings?.machineRolesByProject || [];
      setFavorite(rows.find((r) => !r.projectName) || null);
      setConnectionMode(fanoutModeFromSettings(data?.settings));
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (row: MachineRolesRow) => {
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`${CONVEX_URL}/settings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ machineRolesForProject: { ...row, updatedAt: Date.now() } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(machineRolesSaveErrorMessage(res.status, data));
      setFavorite(row);
    },
    [token],
  );

  const clear = useCallback(async () => {
    if (!token) throw new Error("Not signed in");
    const res = await fetch(`${CONVEX_URL}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ machineRolesForProject: { runnerDeviceId: null } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(machineRolesSaveErrorMessage(res.status, data));
    setFavorite(null);
  }, [token]);

  return { favorite, loaded, reload, save, clear, connectionMode };
}
