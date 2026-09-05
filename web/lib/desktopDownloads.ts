export type DesktopPlatform = "macos" | "windows" | "linux";

export type DesktopDownloadKey =
  | "macArm64"
  | "macX64"
  | "winX64"
  | "linuxX64"
  | "linuxArm64"
  | "debX64";

export type DesktopDownload = {
  downloadKey: DesktopDownloadKey;
  platform: string;
  detail: string;
  icon: string;
};

export const DESKTOP_PLATFORM_LABELS: Record<DesktopPlatform, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export const DESKTOP_DOWNLOADS_BY_PLATFORM: Record<
  DesktopPlatform,
  readonly DesktopDownload[]
> = {
  macos: [
    {
      downloadKey: "macArm64",
      platform: "macOS · Apple Silicon",
      detail: "Signed + notarized DMG",
      icon: "🍎",
    },
    {
      downloadKey: "macX64",
      platform: "macOS · Intel",
      detail: "Signed + notarized DMG",
      icon: "🍎",
    },
  ],
  windows: [
    {
      downloadKey: "winX64",
      platform: "Windows",
      detail: "Authenticode NSIS · x64",
      icon: "🪟",
    },
  ],
  linux: [
    {
      downloadKey: "linuxX64",
      platform: "Linux · x64",
      detail: "AppImage",
      icon: "🐧",
    },
    {
      downloadKey: "linuxArm64",
      platform: "Linux · arm64",
      detail: "AppImage",
      icon: "🐧",
    },
    {
      downloadKey: "debX64",
      platform: "Ubuntu / Debian",
      detail: "x64 .deb (apt-get)",
      icon: "📦",
    },
  ],
};

export function detectDesktopPlatform({
  platform = "",
  userAgent = "",
}: {
  platform?: string;
  userAgent?: string;
}): DesktopPlatform {
  const signature = `${platform} ${userAgent}`.toLowerCase();

  if (/windows|win32|win64/.test(signature)) return "windows";
  if (/mac|iphone|ipad|ipod/.test(signature)) return "macos";
  if (/linux|x11|cros/.test(signature)) return "linux";

  // macOS is the least surprising server-rendered/default choice for the
  // signed desktop GUI. Every platform remains one visible chip away.
  return "macos";
}
