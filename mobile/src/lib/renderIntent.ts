export type RenderIntentSource = "deeplink" | "siri" | "shortcut" | "voice" | "web" | "cli" | "mcp";
export type RenderIntentMode = "auto" | "browser" | "hermes" | "native";
export type RenderIntentReload = "none" | "fast" | "full";

export interface RenderIntent {
  project?: string;
  device?: string;
  mode: RenderIntentMode;
  reload: RenderIntentReload;
  source: RenderIntentSource;
}

export type ParsedRenderLink =
  | { kind: "render"; intent: RenderIntent }
  | { kind: "shortcut"; id: string; source: RenderIntentSource };

const MODES = new Set<RenderIntentMode>(["auto", "browser", "hermes", "native"]);
const RELOADS = new Set<RenderIntentReload>(["none", "fast", "full"]);

function param(u: URL, name: string): string {
  return (u.searchParams.get(name) || "").trim();
}

function safeToken(value: string): string {
  return value.replace(/[^\p{L}\p{N}._ -]/gu, "").trim().slice(0, 80);
}

function modeFrom(value: string): RenderIntentMode {
  return MODES.has(value as RenderIntentMode) ? value as RenderIntentMode : "auto";
}

function reloadFrom(value: string): RenderIntentReload {
  return RELOADS.has(value as RenderIntentReload) ? value as RenderIntentReload : "none";
}

export function parseRenderLink(raw: string, source: RenderIntentSource = "deeplink"): ParsedRenderLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.host.toLowerCase();
  const path = (u.pathname || "").replace(/\/+$/, "");
  const firstPathPart = path.split("/").filter(Boolean)[0] || "";

  const isYaverScheme = scheme === "yaver";
  const isYaverWeb = scheme === "https" && host === "yaver.io";

  if (!isYaverScheme && !isYaverWeb) return null;

  const route = isYaverScheme ? host : firstPathPart;
  if (route === "shortcut") {
    const id =
      param(u, "id") ||
      (isYaverWeb ? path.split("/").filter(Boolean)[1] || "" : firstPathPart === "shortcut" ? "" : path.replace(/^\//, ""));
    const safeId = id.trim();
    return { kind: "shortcut", id: safeId, source };
  }

  if (route !== "render") return null;

  const project =
    safeToken(param(u, "project")) ||
    safeToken(param(u, "app")) ||
    safeToken(param(u, "slug")) ||
    (isYaverWeb ? safeToken(path.split("/").filter(Boolean)[1] || "") : "");

  return {
    kind: "render",
    intent: {
      ...(project ? { project } : {}),
      ...(param(u, "device") ? { device: safeToken(param(u, "device")) } : {}),
      mode: modeFrom(param(u, "mode").toLowerCase()),
      reload: reloadFrom(param(u, "reload").toLowerCase()),
      source,
    },
  };
}

export function renderIntentToOpenApp(intent: RenderIntent): { app: string; lane?: string } | null {
  const app = safeToken(intent.project || "");
  if (!app) return null;
  const lane = intent.mode === "browser" ? "browser" : intent.mode === "hermes" ? "hermes" : intent.mode === "native" ? "native" : undefined;
  return { app, ...(lane ? { lane } : {}) };
}
