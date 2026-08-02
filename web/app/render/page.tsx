"use client";

import Link from "next/link";
import { useMemo } from "react";

function cleanParam(value: string | null): string {
  return (value || "").trim().slice(0, 80);
}

function appUrlFromSearch(search: string): string {
  const input = new URLSearchParams(search);
  const output = new URLSearchParams();
  const project = cleanParam(input.get("project") || input.get("app") || input.get("name") || input.get("p"));
  const device = cleanParam(input.get("device") || input.get("target") || input.get("d"));
  const mode = cleanParam(input.get("mode") || input.get("lane"));
  const reload = cleanParam(input.get("reload"));
  if (project) output.set("project", project);
  if (device) output.set("device", device);
  if (mode) output.set("mode", mode);
  if (reload) output.set("reload", reload);
  const qs = output.toString();
  return `yaver://render${qs ? `?${qs}` : ""}`;
}

export default function RenderPage() {
  const appUrl = useMemo(() => {
    if (typeof window === "undefined") return "yaver://render";
    return appUrlFromSearch(window.location.search);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#8B77FF]">Yaver render</p>
        <h1 className="mt-4 text-4xl font-bold tracking-normal">Open this render in the Yaver app.</h1>
        <p className="mt-4 text-lg text-zinc-400">
          Siri and iOS Shortcuts normally open this link directly in Yaver. If you landed here, open the app manually and Yaver will use the same render intent.
        </p>
        <a
          className="mt-8 rounded-xl bg-[#7C5CFF] px-5 py-4 text-center text-lg font-semibold text-white"
          href={appUrl}
        >
          Open in Yaver
        </a>
        <Link className="mt-4 text-center text-sm text-zinc-500" href="/dashboard">
          Go to dashboard
        </Link>
      </section>
    </main>
  );
}
