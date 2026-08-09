export type SendTaskRequestBodyArgs = {
  title: string;
  description: string;
  model?: string;
  runner?: string;
  customCommand?: string;
  speechContext?: Record<string, unknown> | undefined;
  images?: unknown[];
  workDir?: string;
  projectName?: string;
  projectDir?: string;
  mcpServers?: string[];
  mode?: string;
  video?: { enabled?: boolean; source?: "browser" | "sim-ios" | "sim-android" | "phone" };
  codeMode?: boolean;
  allowLocalFallback?: boolean;
  /** Yaver goal-mode objective (opencode goal plugin). When set, the task
   *  runs as a persistent goal the opencode runner keeps working toward
   *  across turns (create_goal + idle auto-continue) until complete with
   *  evidence, blocked, or a safety limit. Empty = one-shot task. Only the
   *  opencode runner honors it; other runners ignore the field. Surfaces
   *  set this when the composer input is `/goal <objective>`. */
  goal?: string;
};

export function buildSendTaskRequestBody(args: SendTaskRequestBodyArgs): Record<string, unknown> {
  return {
    title: args.title,
    description: args.description,
    source: args.codeMode ? "mobile-code" : "mobile",
    ...(args.model ? { model: args.model } : {}),
    ...(args.runner ? { runner: args.runner } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.customCommand ? { customCommand: args.customCommand } : {}),
    ...(args.speechContext ? { speechContext: args.speechContext } : {}),
    ...(args.images?.length ? { images: args.images } : {}),
    ...(args.workDir ? { workDir: args.workDir } : {}),
    ...(args.projectName ? { projectName: args.projectName } : {}),
    ...(args.projectDir ? { projectDir: args.projectDir } : {}),
    ...(args.mcpServers?.length ? { mcpServers: args.mcpServers } : {}),
    ...(args.video?.enabled ? { videoEnabled: true } : {}),
    ...(args.video?.source ? { videoSource: args.video.source } : {}),
    ...(args.allowLocalFallback ? { allowLocalFallback: true } : {}),
    ...(args.goal ? { goal: args.goal } : {}),
  };
}
