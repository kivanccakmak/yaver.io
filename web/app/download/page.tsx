"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

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

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-white md:text-4xl">Download</h1>
          <p className="text-sm text-surface-500">
            Install the agent on your dev machine. Get the app on your phone.
          </p>
        </div>

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
                  { label: "Apple Silicon", href: "/downloads/Yaver-arm64.dmg", primary: true },
                  { label: "Intel", href: "/downloads/Yaver-x64.dmg" },
                ],
              },
              {
                name: "Windows",
                desc: "Windows 10+",
                highlighted: platform === "windows",
                buttons: [
                  { label: "Download .exe", href: "/downloads/Yaver-Setup.exe", primary: true },
                ],
              },
              {
                name: "Linux",
                desc: "Ubuntu, Fedora, Arch",
                highlighted: platform === "linux",
                buttons: [
                  { label: ".deb", href: "/downloads/yaver.deb", primary: true },
                  { label: "AppImage", href: "/downloads/Yaver.AppImage" },
                ],
              },
            ].map((p) => (
              <div key={p.name} className={`card ${p.highlighted ? "border-surface-600" : ""}`}>
                {p.highlighted && (
                  <div className="mb-3 text-xs text-surface-400">Detected your platform</div>
                )}
                <h3 className="mb-1 text-base font-semibold text-white">{p.name}</h3>
                <p className="mb-5 text-xs text-surface-500">{p.desc}</p>
                <div className="flex flex-wrap gap-2">
                  {p.buttons.map((btn) => (
                    <a
                      key={btn.label}
                      href={btn.href}
                      className={btn.primary ? "btn-primary py-2 px-4 text-xs" : "btn-secondary py-2 px-4 text-xs"}
                    >
                      {btn.label}
                    </a>
                  ))}
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
            <div className={`card ${platform === "ios" ? "border-surface-600" : ""}`}>
              <h3 className="mb-1 text-base font-semibold text-white">iOS</h3>
              <p className="mb-5 text-xs text-surface-500">iOS 16+. iPhone and iPad.</p>
              <a href="#" className="btn-primary py-2 px-4 text-xs">App Store (coming soon)</a>
            </div>
            <div className={`card ${platform === "android" ? "border-surface-600" : ""}`}>
              <h3 className="mb-1 text-base font-semibold text-white">Android</h3>
              <p className="mb-5 text-xs text-surface-500">Android 12+.</p>
              <a href="#" className="btn-primary py-2 px-4 text-xs">Google Play (coming soon)</a>
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
                <span className="text-surface-300 select-all">curl -fsSL https://get.yaver.io | sh</span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Homebrew</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">$</span>{" "}
                <span className="text-surface-300 select-all">brew install yaver-io/tap/yaver</span>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-surface-500">Windows (PowerShell)</p>
              <div className="rounded-lg bg-surface-950 px-4 py-3 font-mono text-[13px]">
                <span className="text-surface-500">&gt;</span>{" "}
                <span className="text-surface-300 select-all">irm https://get.yaver.io/windows | iex</span>
              </div>
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link href="/" className="text-xs text-surface-500 hover:text-white">Back to home</Link>
        </div>
      </div>
    </div>
  );
}
