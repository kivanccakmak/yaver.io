// opencodeModel.ts — pre-send validation of an OpenCode `provider/model`
// selection against the BOX's probed opencode config snapshot
// (failure-recovery audit 2026-07 §6 item 5).
//
// The gap: the agent probes opencode's real config (providers, models,
// defaults) and the dashboard carries the snapshot — but nothing validated
// the user's selection BEFORE dispatch, so a model the box has no provider
// for travelled all the way to the runner and died minutes later as
// opencode's `ProviderModelNotFoundError` deep in task output. The check is
// free and local; run it before the task leaves the composer.
//
// Deliberately permissive on ignorance: with no snapshot, or a snapshot that
// lists nothing, we let the dispatch proceed — blocking on missing telemetry
// would turn a stale Convex row into a false red. Only a snapshot that
// POSITIVELY lists models/providers can veto.

export type OpenCodeModelSnapshotLike = {
  model?: string;
  models?: Array<{ id: string }>;
  providers?: Array<{ id: string; models?: string[] }>;
  updatedAt?: number;
} | null | undefined;

export type OpenCodeModelValidation =
  | { ok: true }
  | { ok: false; error: string };

function snapshotAge(updatedAt: number | undefined): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) return "";
  const mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
  if (mins < 1) return "probed just now";
  if (mins < 60) return `probed ${mins}m ago`;
  return `probed ${Math.round(mins / 60)}h ago`;
}

export function validateOpenCodeModel(
  snapshot: OpenCodeModelSnapshotLike,
  model: string | null | undefined,
): OpenCodeModelValidation {
  const selected = String(model || "").trim();
  if (!selected) return { ok: true }; // runner default — the box decides.
  if (!snapshot) return { ok: true }; // nothing to validate against.

  const knownIds = new Set<string>();
  for (const m of snapshot.models || []) {
    if (m?.id) knownIds.add(String(m.id));
  }
  for (const p of snapshot.providers || []) {
    for (const m of p?.models || []) {
      knownIds.add(`${p.id}/${m}`);
      knownIds.add(String(m));
    }
  }
  if (snapshot.model) knownIds.add(String(snapshot.model));
  if (knownIds.size === 0) return { ok: true }; // snapshot carries no roster.

  if (knownIds.has(selected)) return { ok: true };

  const age = snapshotAge(snapshot.updatedAt);
  const providerIds = (snapshot.providers || []).map((p) => p.id).filter(Boolean);
  const prefix = selected.includes("/") ? selected.split("/")[0] : "";
  const sample = [...knownIds].slice(0, 6).join(", ");

  if (prefix && providerIds.length > 0 && !providerIds.includes(prefix)) {
    return {
      ok: false,
      error:
        `Model "${selected}" needs provider "${prefix}", which this box's opencode config does not have ` +
        `(providers: ${providerIds.join(", ")}${age ? `; ${age}` : ""}). ` +
        `Pick a model from a configured provider, or add "${prefix}" to opencode.json on the box.`,
    };
  }
  return {
    ok: false,
    error:
      `Model "${selected}" is not in this box's opencode config` +
      `${age ? ` (${age})` : ""}. Known models: ${sample}${knownIds.size > 6 ? ", …" : ""}. ` +
      "Pick one of those, or update opencode.json on the box and re-open Devices to refresh the snapshot.",
  };
}
