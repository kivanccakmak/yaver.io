// codingAgent/codingAgentRun.ts — RN glue that runs the agentic coding loop on a
// phone-local project with read-only Git inspection available to the agent and
// a reversible working-tree transaction around each vibe turn. Commits and
// pushes are deliberate UI actions; an agent turn never changes history or a
// remote. This is the production entry the sandbox editor
// calls; it pulls in expo (via sandboxBinding + gitFsExpo), so headless tests
// don't import it — the pieces it composes are each tested: execution policy,
// turn transaction, Git tool factory, and the loop itself.

import { createExpoGitFs, gitDirForSlug } from "./gitFsExpo";
import { sandboxForSlug } from "./sandboxBinding";
import { CODING_TOOLS, type CodingSandbox, type CodingTool } from "./sandboxTools";
import { makeGitTools } from "./gitTools";
import type { NetOptions } from "./sandboxGitOps";
import type { SandboxGitOptions } from "./sandboxGit";
import { toolsForRun, type CodingRunMode } from "./executionPolicy";
import {
  changedFilesForTurn,
  createTurnTransaction,
  type TurnChangedFile,
  type TurnSnapshot,
} from "./turnTransaction";
import {
  runCodingAgent,
  type CodingAgentConfig,
  type CodingAgentProgress,
  type CodingAgentResult,
} from "./runner";

/** The git context (fs + virtual dir) for a phone-local project slug. */
export function gitContextForSlug(slug: string): SandboxGitOptions {
  return { fs: createExpoGitFs(), dir: gitDirForSlug(slug) };
}

export interface AgenticRunOptions {
  slug: string;
  prompt: string;
  config: CodingAgentConfig;
  /** Git network context for future explicit UI actions; model policy filters network tools. */
  net?: NetOptions;
  /** Audit is structurally read-only; vibe may edit files but never commit/push. */
  mode?: CodingRunMode;
  /** Optional per-file gate. Omit for normal auto-applied vibe edits. */
  confirmMutation?: (call: { name: string; args: unknown }) => Promise<boolean> | boolean;
  onProgress?: (e: CodingAgentProgress) => void;
  signal?: AbortSignal;
  maxSteps?: number;
  /** @deprecated Git checkpoints are no longer created by coding turns. */
  noCheckpoint?: boolean;
  /**
   * The file-tool sandbox. Defaults to sandboxForSlug (src/-only — right for
   * in-app SQLite projects). Pass repoSandboxForSlug(slug) for a CLONED repo so
   * the agent can edit the whole tree (package.json, convex/, app/, src/), not
   * just src/. Either way it stays rooted at the same dir git operates on.
   */
  sandbox?: CodingSandbox;
}

export interface AgenticCodingRun {
  result: CodingAgentResult;
  snapshot: TurnSnapshot;
  changed: TurnChangedFile[];
  /** @deprecated Always null. Kept temporarily for source compatibility. */
  before: null;
  /** @deprecated Always null. Kept temporarily for source compatibility. */
  after: null;
}

/**
 * Run the agentic coding loop against a phone-local project. The agent gets the
 * file tools plus read-only Git inspection. Vibe edits are recorded in a
 * non-Git transaction for one-tap undo; audit cannot receive mutating tools.
 */
export async function runAgenticCoding(opts: AgenticRunOptions): Promise<AgenticCodingRun> {
  const sandbox = opts.sandbox ?? sandboxForSlug(opts.slug);
  const git = gitContextForSlug(opts.slug);
  const mode = opts.mode ?? "vibe";
  const transaction = createTurnTransaction(sandbox);
  const advertised: CodingTool[] = [...CODING_TOOLS, ...makeGitTools(git, opts.net)];
  const tools = toolsForRun(advertised, mode);

  try {
    const result = await runCodingAgent({
      prompt: opts.prompt,
      sandbox: transaction.sandbox,
      config: opts.config,
      tools,
      confirmMutation: opts.confirmMutation,
      onProgress: opts.onProgress,
      signal: opts.signal,
      maxSteps: opts.maxSteps,
    });
    const snapshot = transaction.snapshot();
    const changed = await changedFilesForTurn(sandbox, snapshot);
    return { result, snapshot, changed, before: null, after: null };
  } catch (error) {
    // An interrupted/failed model turn must not strand invisible partial edits.
    await transaction.rollback();
    throw error;
  }
}
