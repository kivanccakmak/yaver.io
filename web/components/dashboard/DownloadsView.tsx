"use client";

// DownloadsView — the logged-in downloads surface. Lives inside the dashboard
// shell so an authenticated user can grab the GUI desktop app, the agent CLI,
// or the mobile apps without logging out of the webui. Mirrors the public
// /download page but in the dashboard's own card language, and always offers
// the direct artifact paths (GitHub Releases) rather than only prose.

import Link from "next/link";
import { GUI_DOWNLOADS, GUI_VERSION } from "@/lib/versions";

function DownloadCard({
  platform,
  detail,
  href,
  icon,
}: {
  platform: string;
  detail: string;
  href: string;
  icon: string;
}) {
  return (
    <a
      href={href}
      className="group rounded-xl border border-surface-700 bg-surface-950 p-5 transition hover:border-brand/50 hover:bg-surface-900"
      title={`Download ${platform} — ${detail}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-surface-50">
          <span className="mr-1.5" aria-hidden>{icon}</span>
          {platform}
        </span>
        <span className="whitespace-nowrap text-xs font-medium text-emerald-400 group-hover:text-emerald-300">
          Download &rarr;
        </span>
      </div>
      <div className="mt-1 text-xs text-surface-500">{detail}</div>
    </a>
  );
}

export default function DownloadsView() {
  return (
    <div className="flex flex-col gap-5 text-surface-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-surface-50">Downloads</h2>
          <p className="mt-0.5 text-xs text-surface-500">
            Install Yaver on any machine you own — desktop, server, phone. You stay signed in here.
          </p>
        </div>
        <span className="rounded-full border border-surface-700 bg-surface-950 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-surface-400">
          GUI v{GUI_VERSION}
        </span>
      </div>

      {/* Desktop app (GUI) — the direct artifact paths live here. */}
      <section className="rounded-2xl border border-surface-800 bg-surface-900 p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500">
          Desktop app (GUI)
        </p>
        <h3 className="mt-1 text-base font-semibold text-surface-50">
          Yaver for macOS, Windows &amp; Linux
        </h3>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-surface-400">
          A native desktop shell around this dashboard — sign in and vibe tasks straight from the
          computer. It embeds the same Go agent, so the machine you install it on is itself a Yaver
          node. Includes tray, task notifications, and deep links.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DownloadCard platform="macOS · Apple Silicon" detail="Signed + notarized DMG" href={GUI_DOWNLOADS.macArm64} icon="🍎" />
          <DownloadCard platform="macOS · Intel" detail="Signed + notarized DMG" href={GUI_DOWNLOADS.macX64} icon="🍎" />
          <DownloadCard platform="Windows" detail="Authenticode NSIS · x64" href={GUI_DOWNLOADS.winX64} icon="🪟" />
          <DownloadCard platform="Linux · x64" detail="AppImage" href={GUI_DOWNLOADS.linuxX64} icon="🐧" />
          <DownloadCard platform="Linux · arm64" detail="AppImage" href={GUI_DOWNLOADS.linuxArm64} icon="🐧" />
          <DownloadCard platform="Ubuntu / Debian" detail="x64 .deb (apt-get)" href={GUI_DOWNLOADS.debX64} icon="📦" />
        </div>
        <p className="mt-3 text-[11px] text-surface-500">
          All GUI releases and the full artifact set (rpm, tar.gz, zip):{" "}
          <a
            href="https://github.com/yaver-io/yaver.io/releases"
            target="_blank"
            rel="noreferrer"
            className="text-surface-300 underline hover:text-surface-50"
          >
            GitHub Releases
          </a>
          .
        </p>
      </section>

      {/* Agent / CLI — one npm path, binary fetched from GitHub Releases. */}
      <section className="rounded-2xl border border-surface-800 bg-surface-900 p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500">
          Agent &amp; CLI
        </p>
        <h3 className="mt-1 text-base font-semibold text-surface-50">
          The Go agent, on any server or laptop
        </h3>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-surface-400">
          <code className="rounded bg-surface-950 px-1 py-0.5 text-[11px] text-surface-300">yaver-cli</code>{" "}
          is npm-only: the tiny shim installs from npm, and the first run downloads the matching
          signed agent binary for your platform (macOS, Linux x64/arm64, Windows via WSL2) into{" "}
          <code className="rounded bg-surface-950 px-1 py-0.5 text-[11px] text-surface-300">~/.yaver/bin/</code>
          . Upgrades are <code className="rounded bg-surface-950 px-1 py-0.5 text-[11px] text-surface-300">npm install -g yaver-cli@latest</code>.
        </p>
        <div className="mt-4 rounded-xl bg-surface-950 p-4 font-mono text-[12px] text-surface-300">
          <div className="mb-2"><span className="text-surface-500">$</span> <span className="select-all">npm install -g yaver-cli</span></div>
          <div className="mb-2"><span className="text-surface-500">$</span> <span className="select-all">yaver auth</span></div>
          <div><span className="text-surface-500">$</span> <span className="select-all">yaver serve</span></div>
        </div>
        <p className="mt-3 text-[11px] text-surface-500">
          MCP for Claude Code / Codex / opencode:{" "}
          <Link href="/download" className="text-surface-300 underline hover:text-surface-50">
            see the install guide
          </Link>
          .
        </p>
      </section>

      {/* Mobile — phone surfaces. */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-surface-800 bg-surface-900 p-5">
          <h3 className="text-sm font-semibold text-surface-50">Android app</h3>
          <p className="mt-1.5 text-xs leading-5 text-surface-400">
            Latest signed APK, QR install page, or Google Play — pick your path.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="https://download.yaver.io"
              className="inline-flex items-center justify-center rounded-xl bg-surface-50 px-3 py-2 text-xs font-semibold text-surface-950 transition hover:bg-surface-100"
            >
              QR install page
            </a>
            <a
              href="https://download.yaver.io/latest.apk"
              className="inline-flex items-center justify-center rounded-xl border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-200 transition hover:border-surface-500 hover:text-surface-50"
            >
              APK directly
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=io.yaver.mobile"
              className="inline-flex items-center justify-center rounded-xl border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-200 transition hover:border-surface-500 hover:text-surface-50"
            >
              Google Play
            </a>
          </div>
        </div>

        <div className="rounded-2xl border border-surface-800 bg-surface-900 p-5">
          <h3 className="text-sm font-semibold text-surface-50">iOS app</h3>
          <p className="mt-1.5 text-xs leading-5 text-surface-400">
            iPhone and iPad ship through the App Store; sign in with the same account.
          </p>
          <div className="mt-3">
            <a
              href="https://apps.apple.com/us/app/yaver-io/id6760467669"
              className="inline-flex items-center justify-center rounded-xl bg-surface-50 px-3 py-2 text-xs font-semibold text-surface-950 transition hover:bg-surface-100"
            >
              App Store
            </a>
          </div>
        </div>
      </section>

      {/* Everything else — public page keeps the long tail (Pi image, WSL, headless, MCP). */}
      <section className="rounded-2xl border border-surface-800 bg-surface-900 p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500">
          More install paths
        </p>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-surface-400">
          Raspberry Pi image, WSL2, headless / SSH-only boxes, watch / TV / car / AR-VR surfaces, and
          the full sign-in provider list live on the public install page.
        </p>
        <div className="mt-3">
          <Link
            href="/download"
            className="inline-flex items-center justify-center rounded-xl border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-200 transition hover:border-surface-500 hover:text-surface-50"
          >
            Open full install page &rarr;
          </Link>
        </div>
      </section>
    </div>
  );
}
