import { mutation, query } from "./_generated/server";

export const PREDEFINED_RUNNERS = [
  {
    runnerId: "claude",
    name: "Claude Code",
    command: "claude",
    args: JSON.stringify(["-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--tools", "Bash", "--dangerously-skip-permissions"]),
    outputMode: "stream-json" as const,
    resumeSupported: true,
    resumeArgs: JSON.stringify(["--resume", "{sessionId}"]),
    exitCommand: "/exit",
    description: "Anthropic Claude CLI with streaming",
    isDefault: true,
    sortOrder: 1,
  },
  {
    runnerId: "codex",
    name: "OpenAI Codex",
    command: "codex",
    args: JSON.stringify(["--quiet", "--full-auto", "{prompt}"]),
    outputMode: "raw" as const,
    resumeSupported: false,
    exitCommand: "exit",
    description: "OpenAI Codex CLI",
    sortOrder: 2,
  },
  {
    runnerId: "aider",
    name: "Aider",
    command: "aider",
    args: JSON.stringify(["--yes", "--message", "{prompt}"]),
    outputMode: "raw" as const,
    resumeSupported: false,
    exitCommand: "/quit",
    description: "AI pair programming in terminal",
    sortOrder: 3,
  },
  {
    runnerId: "custom",
    name: "Custom Command",
    command: "",
    args: JSON.stringify([]),
    outputMode: "raw" as const,
    resumeSupported: false,
    description: "Your own terminal AI command",
    sortOrder: 99,
  },
];

export const list = query({
  args: {},
  handler: async (ctx) => {
    const runners = await ctx.db.query("aiRunners").collect();
    runners.sort((a, b) => a.sortOrder - b.sortOrder);
    return runners;
  },
});

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    for (const runner of PREDEFINED_RUNNERS) {
      const existing = await ctx.db
        .query("aiRunners")
        .withIndex("by_runnerId", (q) => q.eq("runnerId", runner.runnerId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, runner);
      } else {
        await ctx.db.insert("aiRunners", runner);
      }
    }
  },
});
