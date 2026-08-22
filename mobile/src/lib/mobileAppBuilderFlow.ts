export type BuilderDevice = { id: string; name: string };

export type MobileAppGitProvider = "yaver-git" | "github" | "gitlab";

export const MOBILE_APP_GIT_PROVIDERS: Array<{
  id: MobileAppGitProvider;
  name: string;
  detail: string;
}> = [
  { id: "yaver-git", name: "Yaver Git", detail: "Private managed history on your Yaver box" },
  { id: "github", name: "GitHub", detail: "Create a private repository in GitHub" },
  { id: "gitlab", name: "GitLab", detail: "Create a private project in GitLab" },
];

export type MobileAppPalette = {
  id: string;
  name: string;
  mood: string;
  colors: [string, string, string, string];
  surface: string;
  text: string;
  muted: string;
};

export const MOBILE_APP_PALETTES: MobileAppPalette[] = [
  { id: "electric", name: "Electric", mood: "Bold, digital, high-energy", colors: ["#7557FF", "#34D6FF", "#FF4FD8", "#11111A"], surface: "#11111A", text: "#FFFFFF", muted: "#AAA7BA" },
  { id: "ocean", name: "Ocean", mood: "Clear, calm, trustworthy", colors: ["#075985", "#0EA5E9", "#67E8F9", "#F0F9FF"], surface: "#F0F9FF", text: "#082F49", muted: "#376176" },
  { id: "forest", name: "Forest", mood: "Natural, focused, grounded", colors: ["#14532D", "#22C55E", "#A3E635", "#F7FEE7"], surface: "#F7FEE7", text: "#14351F", muted: "#4B6B54" },
  { id: "sunset", name: "Sunset", mood: "Warm, social, expressive", colors: ["#C2410C", "#FB7185", "#FBBF24", "#FFF7ED"], surface: "#FFF7ED", text: "#431407", muted: "#865B4D" },
  { id: "mono", name: "Mono", mood: "Editorial, sharp, minimal", colors: ["#111827", "#4B5563", "#D1D5DB", "#FFFFFF"], surface: "#FFFFFF", text: "#111827", muted: "#6B7280" },
  { id: "lavender", name: "Lavender", mood: "Soft, thoughtful, friendly", colors: ["#6D28D9", "#A78BFA", "#F0ABFC", "#FAF5FF"], surface: "#FAF5FF", text: "#3B0764", muted: "#79558D" },
];

/** Pick only from genuinely connected machines: primary, active, then name. */
export function chooseBuilderRemote<T extends BuilderDevice>(
  devices: T[],
  connectedDeviceIds: ReadonlySet<string>,
  primaryDeviceId?: string | null,
  activeDeviceId?: string | null,
): T | null {
  const connected = devices.filter((device) => connectedDeviceIds.has(device.id));
  if (!connected.length) return null;
  return connected.find((device) => device.id === primaryDeviceId)
    ?? connected.find((device) => device.id === activeDeviceId)
    ?? [...connected].sort((a, b) => a.name.localeCompare(b.name))[0];
}

export function buildMobileAppBuilderPrompt(palette: MobileAppPalette, remoteName?: string): string {
  const location = remoteName ? `Build and render on the connected remote box “${remoteName}”.` : "Build locally on this phone where supported.";
  return [
    "I want to build a new mobile app in this initialized Yaver project. Start by asking me what it should do, then work with me in this chat and render as you build.",
    location,
    `Use the ${palette.name} palette as the initial visual direction: ${palette.colors.join(", ")}.`,
    "Yaver Serverless is already initialized as the default backend. Infer the product structure, data model, auth, navigation, permissions, and implementation details from my intent. Do not turn this into a questionnaire or ask whether the app needs a backend. Ask only when a consequential choice genuinely cannot be inferred.",
  ].join("\n\n");
}

export function projectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "mobile-app";
}
