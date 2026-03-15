"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

interface Download {
  platform: string;
  arch: string;
  format: string;
  version: string;
  filename: string;
  size: number;
  url: string | null;
}

function detectPlatform(): Platform {
  if (typeof window === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  if (ua.includes("android")) return "android";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

const GITHUB_RELEASE = "https://github.com/kivanccakmak/yaver-cli/releases/latest";

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [cliVersion, setCliVersion] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPlatform(detectPlatform());

    // Fetch downloads list
    fetch(
      `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL || "https://shocking-echidna-394.eu-west-1.convex.site"}/downloads/list`
    )
      .then((res) => res.json())
      .then((data) => setDownloads(data.downloads || []))
      .catch(() => {})
      .finally(() => setLoading(false));

    // Fetch CLI version from config
    fetch(
      `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL || "https://shocking-echidna-394.eu-west-1.convex.site"}/config`
    )
      .then((res) => res.json())
      .then((data) => {
        // cli_version may be in the config response or platformConfig
        if (data.cliVersion) setCliVersion(data.cliVersion);
      })
      .catch(() => {});
  }, []);

  function findDownload(plat: string, arch: string, format: string) {
    // Prefer latest version
    const matches = downloads
      .filter((d) => d.platform === plat && d.arch === arch && d.format === format)
      .sort((a, b) => b.version.localeCompare(a.version));
    return matches[0];
  }

  function downloadButton(
    label: string,
    plat: string,
    arch: string,
    format: string,
    primary = false
  ) {
    const d = findDownload(plat, arch, format);
    const available = d?.url;
    const sizeLabel = d ? ` (${formatSize(d.size)})` : "";
    if (available) {
      return (
        <a
          key={label}
          href={d.url!}
          className={
            primary
              ? "btn-primary py-2 px-4 text-xs"
              : "btn-secondary py-2 px-4 text-xs"
          }
        >
          {label}
          {sizeLabel}
        </a>
      );
    }

    // Fallback to GitHub release
    return (
      <a
        key={label}
        href={GITHUB_RELEASE}
        className={
          primary
            ? "btn-primary py-2 px-4 text-xs"
            : "btn-secondary py-2 px-4 text-xs"
        }
      >
        {label}
      </a>
    );
  }

  const versionBadge = cliVersion ? (
    <span className="ml-2 rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-medium text-surface-400">
      v{cliVersion}
    </span>
  ) : null;

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Download
          </h1>
          <p className="text-sm text-surface-500">
            Install the CLI on your dev machine. Get the app on your phone.
            {versionBadge}
          </p>
        </div>

        {loading && (
          <div className="mb-8 text-center text-sm text-surface-500">
            Loading downloads...
          </div>
        )}

        {/* Desktop CLI */}
        <div className="mb-12">
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-surface-500">
            Desktop CLI {cliVersion && <span className="normal-case tracking-normal text-surface-600">v{cliVersion}</span>}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                name: "macOS",
                desc: "macOS 13+ (Apple Silicon & Intel)",
                highlighted: platform === "macos",
                buttons: [
                  { label: "Apple Silicon", plat: "macos", arch: "arm64", format: "bin", primary: true },
                  { label: "Intel", plat: "macos", arch: "amd64", format: "bin" },
                  { label: ".pkg (ARM)", plat: "macos", arch: "arm64", format: "pkg" },
                ],
              },
              {
                name: "Windows",
                desc: "Windows 10+ (64-bit, signed)",
                highlighted: platform === "windows",
                buttons: [
                  { label: "Download .exe", plat: "windows", arch: "amd64", format: "exe", primary: true },
                ],
              },
              {
                name: "Linux",
                desc: "Ubuntu, Debian, Fedora, Arch",
                highlighted: platform === "linux",
                buttons: [
                  { label: "x86_64", plat: "linux", arch: "amd64", format: "bin", primary: true },
                  { label: "ARM64", plat: "linux", arch: "arm64", format: "bin" },
                  { label: ".deb x86_64", plat: "linux", arch: "amd64", format: "deb" },
                  { label: ".deb ARM64", plat: "linux", arch: "arm64", format: "deb" },
                ],
              },
            ].map((p) => (
              <div
                key={p.name}
                className={`card ${p.highlighted ? "border-surface-600" : ""}`}
              >
                {p.highlighted && (
                  <div className="mb-3 text-xs text-surface-400">
                    Detected your platform
                  </div>
                )}
                <h3 className="mb-1 text-base font-semibold text-surface-50">
                  {p.name}
                </h3>
                <p className="mb-5 text-xs text-surface-500">{p.desc}</p>
                <div className="flex flex-wrap gap-2">
                  {p.buttons.map((btn) =>
                    downloadButton(btn.label, btn.plat, btn.arch, btn.format, btn.primary)
                  )}
                </div>
                {p.name === "Linux" && (
                  <div className="mt-4 border-t border-surface-800 pt-4">
                    <p className="mb-2 text-xs text-surface-500">Or install via APT:</p>
                    <div className="rounded-lg bg-surface-950 px-3 py-2 font-mono text-[11px] space-y-1">
                      <div>
                        <span className="text-surface-500">$</span>{" "}
                        <span className="text-surface-400 select-all">
                          curl -fsSL https://kivanccakmak.github.io/apt-yaver/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/yaver.gpg
                        </span>
                      </div>
                      <div>
                        <span className="text-surface-500">$</span>{" "}
                        <span className="text-surface-400 select-all">
                          {`echo "deb [signed-by=/usr/share/keyrings/yaver.gpg] https://kivanccakmak.github.io/apt-yaver stable main" | sudo tee /etc/apt/sources.list.d/yaver.list`}
                        </span>
                      </div>
                      <div>
                        <span className="text-surface-500">$</span>{" "}
                        <span className="text-surface-400 select-all">
                          sudo apt-get update && sudo apt-get install yaver
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Package managers */}
        <div className="mb-12">
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-surface-500">
            Package managers
          </h2>
          <div className="card space-y-4">
            <div>
              <p className="mb-2 text-xs text-surface-500">Homebrew (macOS / Linux)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">
                  brew install kivanccakmak/yaver/yaver
                </span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">APT (Debian / Ubuntu)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px] space-y-1">
                <div>
                  <span className="text-surface-500">$</span>{" "}
                  <span className="text-surface-300 select-all">
                    curl -fsSL https://kivanccakmak.github.io/apt-yaver/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/yaver.gpg
                  </span>
                </div>
                <div>
                  <span className="text-surface-500">$</span>{" "}
                  <span className="text-surface-300 select-all">
                    {`echo "deb [signed-by=/usr/share/keyrings/yaver.gpg] https://kivanccakmak.github.io/apt-yaver stable main" | sudo tee /etc/apt/sources.list.d/yaver.list`}
                  </span>
                </div>
                <div>
                  <span className="text-surface-500">$</span>{" "}
                  <span className="text-surface-300 select-all">
                    sudo apt-get update && sudo apt-get install yaver
                  </span>
                </div>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Arch Linux (AUR)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px] space-y-1">
                <div>
                  <span className="text-surface-500">$</span>{" "}
                  <span className="text-surface-300 select-all">
                    git clone https://github.com/kivanccakmak/aur-yaver.git && cd aur-yaver && makepkg -si
                  </span>
                </div>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">RPM (Fedora / RHEL) — ARM64</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">
                  sudo rpm -i https://github.com/kivanccakmak/yaver-cli/releases/latest/download/yaver_{cliVersion || "latest"}_aarch64.rpm
                </span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Scoop (Windows)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px] space-y-1">
                <div>
                  <span className="text-surface-500">&gt;</span>{" "}
                  <span className="text-surface-300 select-all">
                    scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver
                  </span>
                </div>
                <div>
                  <span className="text-surface-500">&gt;</span>{" "}
                  <span className="text-surface-300 select-all">
                    scoop install yaver
                  </span>
                </div>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Quick install (macOS / Linux)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">
                  curl -fsSL https://yaver.io/install.sh | sh
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile */}
        <div className="mb-12">
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-surface-500">
            Mobile app
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div
              className={`card ${platform === "ios" ? "border-surface-600" : ""}`}
            >
              <h3 className="mb-1 text-base font-semibold text-surface-50">
                iOS
              </h3>
              <p className="mb-5 text-xs text-surface-500">
                iOS 16+. iPhone and iPad.
              </p>
              <span className="inline-flex items-center justify-center rounded-lg border border-surface-800 bg-surface-900 px-4 py-2 text-xs text-surface-600 cursor-not-allowed">
                App Store (coming soon)
              </span>
            </div>
            <div
              className={`card ${platform === "android" ? "border-surface-600" : ""}`}
            >
              <h3 className="mb-1 text-base font-semibold text-surface-50">
                Android
              </h3>
              <p className="mb-5 text-xs text-surface-500">Android 12+.</p>
              <span className="inline-flex items-center justify-center rounded-lg border border-surface-800 bg-surface-900 px-4 py-2 text-xs text-surface-600 cursor-not-allowed">
                Google Play (coming soon)
              </span>
            </div>
          </div>
        </div>

        {/* GitHub link */}
        <div className="text-center space-y-3">
          <a
            href={GITHUB_RELEASE}
            className="text-xs text-surface-400 hover:text-surface-50 underline underline-offset-2"
          >
            All releases on GitHub
          </a>
          <br />
          <Link
            href="/"
            className="text-xs text-surface-500 hover:text-surface-50"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}

