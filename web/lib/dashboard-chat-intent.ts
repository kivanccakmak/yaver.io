export type DashboardChatIntent =
  | { kind: "runtime"; projectQuery?: string; surface?: string; platform?: string; response: string }
  | { kind: "webview"; projectQuery?: string; response: string }
  | { kind: "tmux"; tmuxQuery?: string; response: string };

export function parseDashboardChatIntent(text: string): DashboardChatIntent | null {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  const projectMatch = lower.match(/\b(talos|sfmg|yaver)\b/);
  const projectQuery = projectMatch?.[1];
  const wantsOpen = /\b(open|show|run|test|launch|start|preview)\b/.test(lower);
  const wantsWeb = /\b(web|webview|browser|preview)\b/.test(lower) && !/\bwatch|watchos|wear|tv|tvos|vision|xr\b/.test(lower);
  const wantsTmux = /\b(tmux|session|attach|resume|detach)\b/.test(lower) && /\b(tmux|attach|resume|vibe|session)\b/.test(lower);

  if (wantsTmux) {
    const runner = lower.match(/\b(codex|claude|opencode)\b/)?.[1];
    const query = projectQuery && runner
      ? `${projectQuery}-${runner}`
      : runner || projectQuery || lower.replace(/\b(attach|to|the|open|running|existing|vibe|from|session|tmux|resume)\b/g, " ").trim();
    return {
      kind: "tmux",
      tmuxQuery: query || undefined,
      response: `Opening the existing tmux session${query ? ` matching "${query}"` : ""}. Detach will keep it running; close stays explicit.`,
    };
  }

  if (wantsOpen && /\bwatchos|watch os|apple watch\b/.test(lower)) {
    return {
      kind: "runtime",
      projectQuery,
      surface: "watch",
      platform: "ios",
      response: `Opening ${projectQuery || "the project"} for watchOS in Runtime Lab.`,
    };
  }
  if (wantsOpen && /\bwear|wearos|wear os\b/.test(lower)) {
    return {
      kind: "runtime",
      projectQuery,
      surface: "watch",
      platform: "android",
      response: `Opening ${projectQuery || "the project"} for Wear OS in Runtime Lab.`,
    };
  }
  if (wantsOpen && /\btvos|apple tv\b/.test(lower)) {
    return { kind: "runtime", projectQuery, surface: "tv", platform: "ios", response: `Opening ${projectQuery || "the project"} for tvOS in Runtime Lab.` };
  }
  if (wantsOpen && /\bandroid tv\b/.test(lower)) {
    return { kind: "runtime", projectQuery, surface: "tv", platform: "android", response: `Opening ${projectQuery || "the project"} for Android TV in Runtime Lab.` };
  }
  if (wantsOpen && /\bvision|visionos|xr\b/.test(lower)) {
    return { kind: "runtime", projectQuery, surface: "vision", platform: lower.includes("android") ? "android" : "ios", response: `Opening ${projectQuery || "the project"} for the spatial runtime in Runtime Lab.` };
  }
  if (wantsOpen && wantsWeb) {
    return {
      kind: "webview",
      projectQuery,
      response: `Opening ${projectQuery || "the selected project"} in the Webview preview path with real preview logs.`,
    };
  }
  return null;
}
