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

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPlatform(detectPlatform());

    fetch(
      `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL || "https://shocking-echidna-394.eu-west-1.convex.site"}/downloads/list`
    )
      .then((res) => res.json())
      .then((data) => setDownloads(data.downloads || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function findDownload(plat: string, arch: string, format: string) {
    return downloads.find(
      (d) => d.platform === plat && d.arch === arch && d.format === format
    );
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

    return (
      <span
        key={label}
        className="inline-flex items-center justify-center rounded-lg border border-surface-800 bg-surface-900 px-4 py-2 text-xs text-surface-600 cursor-not-allowed"
      >
        {label} (coming soon)
      </span>
    );
  }

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Download
          </h1>
          <p className="text-sm text-surface-500">
            Install the agent on your dev machine. Get the app on your phone.
          </p>
        </div>

        {loading && (
          <div className="mb-8 text-center text-sm text-surface-500">
            Loading downloads...
          </div>
        )}

        {/* Desktop */}
        <div className="mb-12">
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-surface-500">
            Desktop agent
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                name: "macOS",
                desc: "macOS 13+",
                highlighted: platform === "macos",
                buttons: [
                  { label: "Apple Silicon", plat: "macos", arch: "arm64", format: "dmg", primary: true },
                  { label: "Intel", plat: "macos", arch: "x64", format: "bin" },
                ],
              },
              {
                name: "Windows",
                desc: "Windows 10+ (64-bit)",
                highlighted: platform === "windows",
                buttons: [
                  { label: "Download CLI", plat: "windows", arch: "amd64", format: "exe", primary: true },
                ],
              },
              {
                name: "Linux",
                desc: "Ubuntu, Fedora, Arch",
                highlighted: platform === "linux",
                buttons: [
                  { label: ".deb", plat: "linux", arch: "arm64", format: "deb", primary: true },
                  { label: "AppImage", plat: "linux", arch: "arm64", format: "appimage" },
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
              </div>
            ))}
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

        {/* CLI */}
        <div className="mb-12">
          <h2 className="mb-6 text-xs font-semibold uppercase tracking-wider text-surface-500">
            CLI install
          </h2>
          <div className="card space-y-4">
            <div>
              <p className="mb-2 text-xs text-surface-500">macOS / Linux</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">
                  curl -fsSL https://get.yaver.io | sh
                </span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Homebrew</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">
                  brew install kivanccakmak/yaver/yaver
                </span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">
                Windows (PowerShell)
              </p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">&gt;</span>{" "}
                <span className="text-surface-300 select-all">
                  irm https://get.yaver.io/windows | iex
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="text-center">
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
