"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";

export default function ShortcutByIdPage() {
  const params = useParams<{ id?: string }>();
  const appUrl = useMemo(() => {
    const id = (params.id || "").trim().slice(0, 100);
    const qs = id ? `?id=${encodeURIComponent(id)}` : "";
    return `yaver://shortcut${qs}`;
  }, [params.id]);

  return (
    <main className="min-h-screen bg-black text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#8B77FF]">Yaver shortcut</p>
        <h1 className="mt-4 text-4xl font-bold tracking-normal">Open this shortcut in the Yaver app.</h1>
        <p className="mt-4 text-lg text-zinc-400">
          Siri and iOS Shortcuts normally hand this straight to Yaver. If your browser opened instead, continue here.
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
