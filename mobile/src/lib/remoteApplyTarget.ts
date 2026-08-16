// remoteApplyTarget.ts — the apply layer for the Hermes-only-remote topology.
//
// In `(engine: hermes, target: box)` the brain runs on the phone (one mirrored
// token, $0 on plan) but the EditPlan must land on the BOX's filesystem, not the
// phone sandbox. This adapts the box's owner-authenticated FS endpoints
// (desktop/agent/files_browser.go) to the same ApplyTarget interface that
// applyEditPlan() already drives for phone-local edits — so llmClient.applyEditPlan
// is reused verbatim; only the target swaps.
//
//   phone-local : phoneSandboxSourceDefault  → expo-file-system
//   box (remote): makeRemoteApplyTarget(...)  → POST /files/{write,delete}
//
// Pure + injectable (fetch + headers passed in) so it's tsx-testable with no RN.

import type { ApplyTarget } from "./llmClient";

export interface RemoteApplyConfig {
  /** The box's resolved base URL (quicClient.baseUrl for the target device). */
  baseUrl: string;
  /** Auth headers for the box (quicClient.getAuthHeaders()). */
  headers: Record<string, string>;
  /** Owner file-root id identifying the project on the box. The agent resolves
   *  it from its own project inventory and safeJoin()s every relative path. */
  root: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Build an ApplyTarget that writes/deletes files on a remote box. The `slug`
 *  arg of writeSourceFile/deleteSourceFile is ignored — the box project is
 *  already pinned by root id; we forward only the relative path. */
export function makeRemoteApplyTarget(cfg: RemoteApplyConfig): ApplyTarget {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");

  async function post(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetchImpl(`${base}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...cfg.headers,
      },
      body: JSON.stringify({ root: cfg.root, ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`remote fs ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    // The agent returns { ok: true, ... }; a 200 with ok:false is still an error.
    try {
      const j: any = await res.json();
      if (j && j.ok === false) throw new Error(`remote fs ${endpoint}: ${j.error ?? "rejected"}`);
    } catch (e) {
      // Non-JSON 200 is tolerated (older agents); only rethrow our own error.
      if (e instanceof Error && e.message.startsWith("remote fs")) throw e;
    }
  }

  return {
    async writeSourceFile(_slug: string, relPath: string, content: string): Promise<void> {
      await post("/files/write", { path: normalizeRel(relPath), content });
    },
    async deleteSourceFile(_slug: string, relPath: string): Promise<void> {
      await post("/files/delete", { path: normalizeRel(relPath) });
    },
  };
}

/** Strip a leading slash so the agent's safeJoin treats it as project-relative. */
function normalizeRel(p: string): string {
  return p.replace(/^\/+/, "");
}
