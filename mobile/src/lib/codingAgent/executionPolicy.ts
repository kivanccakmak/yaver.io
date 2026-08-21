// One policy for every RN-hosted remoteless coding surface. A vibe turn edits
// the scoped working tree; Git history and remotes are user-controlled actions
// rendered outside the model loop. Audit is structurally read-only.

import type { CodingTool } from "./sandboxTools";

export type CodingRunMode = "audit" | "vibe";
export type ToolEffect = "read" | "workspace" | "repository" | "network";

export function effectOf(tool: CodingTool): ToolEffect {
  if (!tool.mutating) return "read";
  if (tool.effect) return tool.effect;
  // Backwards-compatible classification for injected tools. Unknown mutations
  // are treated as repository mutations, never as safe workspace edits.
  if (["write_file", "edit_file", "delete_file"].includes(tool.name)) return "workspace";
  if (tool.name === "git_push" || tool.name === "git_pull" || tool.name === "git_fetch") return "network";
  return "repository";
}

export function toolsForRun(tools: CodingTool[], mode: CodingRunMode): CodingTool[] {
  return tools.filter((tool) => {
    const effect = effectOf(tool);
    return effect === "read" || (mode === "vibe" && effect === "workspace");
  });
}

export type RemotelessSurface =
  | "desktop_gui"
  | "web"
  | "phone"
  | "tablet"
  | "tv"
  | "watch"
  | "car"
  | "xr";

export interface SurfaceGitCapabilities {
  inspect: true;
  startVibeTurn: boolean;
  editWorkingTree: boolean;
  undoTurn: boolean;
  commit: "local" | "handoff";
  push: "local" | "handoff";
  reason?: string;
}

/** Default interaction contract. Companion surfaces can start/monitor a turn,
 *  but history/network mutations move to a full surface with a readable diff
 *  and deliberate controls. XR is full-sized by default; compact glass should
 *  identify as a companion surface until it has an equivalent review UI. */
export function capabilitiesForSurface(surface: RemotelessSurface): SurfaceGitCapabilities {
  if (surface === "watch" || surface === "car") {
    return {
      inspect: true,
      startVibeTurn: true,
      editWorkingTree: false,
      undoTurn: false,
      commit: "handoff",
      push: "handoff",
      reason: "Review the diff and finish Git actions on phone, tablet, web, desktop, or XR.",
    };
  }
  if (surface === "tv") {
    return {
      inspect: true,
      startVibeTurn: true,
      editWorkingTree: true,
      undoTurn: true,
      commit: "handoff",
      push: "handoff",
      reason: "TV can drive the turn, but commit and push require a full text-review surface.",
    };
  }
  return {
    inspect: true,
    startVibeTurn: true,
    editWorkingTree: true,
    undoTurn: true,
    commit: "local",
    push: "local",
  };
}

/** Voice/compact surfaces may request coding, but a spoken commit/push is not
 *  the full-surface diff review required to finalize it. */
export function isGitFinalizationRequest(text: string): boolean {
  const value = ` ${text.trim().toLowerCase()} `;
  const repositoryContext = /\b(git|github|gitlab|repo|repository|branch|changes|working tree)\b/.test(value);
  if (/\bpush\b/.test(value)) return repositoryContext;
  return /\bcommit\b/.test(value) &&
    (repositoryContext || /\bcommit (it|this|these|everything|all)\b/.test(value));
}
