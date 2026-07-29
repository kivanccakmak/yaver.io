"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/use-auth";

// Canonical definitional one-liner — picked up by AI search
// (ChatGPT, Claude) and SEO as the answer to "what is Yaver?". Framed
// around the factual wedge (self-hosted on-device RN dev client, no
// third-party dev-portal gate) rather than specific competitor names,
// per LEGAL_SAFETY.md §2 (trademark) and §3 (comparative claims).
const LANDING_TAGLINE =
  "Yaver is an open-source MCP server for Claude Code, Codex, and OpenCode. It builds on your own machine, hot-reloads the real app on your iPhone or Android, and sends screenshots, logs, and repro context back to your coding agent when you shake the phone.";

const SUPPORTED_SURFACES = ["iOS", "Android"];

const LANDING_FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What is Yaver?",
    a: "Yaver is an open-source MCP server plus phone app. You register it in Claude Code, Codex, or OpenCode; the agent builds on your own machine; the result hot-reloads on your paired iPhone or Android.",
  },
  {
    q: "Is it a WebView?",
    a: "No. For React Native and Expo projects, Yaver compiles your JavaScript to Hermes bytecode and loads it through a real native bridge, so TurboModules, Fabric, and JSI behave like a production build.",
  },
  {
    q: "Does my code leave my machine?",
    a: "Your source, prompts, runner output, files, and secrets stay on the machine doing the work. The hosted coordination plane stores sign-in and peer-discovery metadata; traffic is encrypted and the relay forwards bytes without reading them.",
  },
  {
    q: "How self-hosted is it?",
    a: "The CLI, agent, relay, and backend are self-hostable. The current mobile app still uses a thin hosted coordination plane for sign-in and device discovery; pointing the phone at your own backend needs an app rebuild today.",
  },
  {
    q: "Which coding agents work?",
    a: "Claude Code, OpenAI Codex, and OpenCode are first-class. Anything that runs in a terminal can be driven through the generic runner, and OpenCode can route to Aider, Goose, local Ollama models, OpenRouter, and other providers.",
  },
  {
    q: "What license is it under?",
    a: "Core is FSL-1.1-Apache-2.0: free for non-competing use and auto-converts to Apache-2.0 two years after each release. Client SDKs are Apache-2.0 from day one.",
  },
];

const LANDING_HOWTO_STEPS: ReadonlyArray<{ name: string; text: string; url?: string }> = [
  {
    name: "Install the Yaver CLI",
    text: "Run npm install -g yaver-cli, or let npx pull the MCP server on first use.",
    url: "https://yaver.io/download",
  },
  {
    name: "Install a Yaver surface app",
    text: "Download Yaver for iOS or Android and sign in with the same account.",
    url: "https://yaver.io/download",
  },
  {
    name: "Build and hot-reload",
    text: "Ask the agent to build something. Yaver runs it on your own machine, compiles the bundle, and hot-reloads it on your paired phone.",
    url: "https://yaver.io/manuals/cli-setup",
  },
];

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-surface-800/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between py-5 text-left"
      >
        <span className="text-sm font-medium text-surface-100">{question}</span>
        <span className="ml-4 shrink-0 text-surface-500">{open ? "\u2212" : "+"}</span>
      </button>
      {open && (
        <p className="pb-5 text-sm leading-relaxed text-surface-400">{answer}</p>
      )}
    </div>
  );
}

export default function HomePage() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  // Signed-in users go straight to the dashboard. We redirect from
  // an effect instead of early-returning a spinner, because
  // early-returning turns this client page into an SEO black hole:
  // server-rendered HTML is just a spinner, so Google / ChatGPT /
  // Claude never see the hero, FAQPage JSON-LD, HowTo
  // JSON-LD, or any of the AI-search copy. Rendering the landing on
  // both server and client means signed-in users see a ~200 ms flash
  // of the landing during auth resolution before the effect fires —
  // an acceptable trade for real SEO.
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isLoading, isAuthenticated, router]);


  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: LANDING_FAQ.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  const howToLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Install and pair Yaver from a client surface",
    description:
      "Run AI coding agents on your own machine and hot-reload their work on your phone.",
    totalTime: "PT5M",
    supply: [{ "@type": "HowToSupply", name: "A Mac, Linux, or Windows machine" }],
    tool: [
      { "@type": "HowToTool", name: "Node.js (optional, for npm install)" },
      { "@type": "HowToTool", name: "The Yaver mobile app" },
    ],
    step: LANDING_HOWTO_STEPS.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
      url: s.url,
    })),
  };

  const organizationLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Yaver",
    legalName: "SIMKAB ELEKTRIK",
    url: "https://yaver.io",
    logo: "https://yaver.io/icon-512.png",
    sameAs: [
      "https://github.com/kivanccakmak/yaver.io",
      "https://www.npmjs.com/package/yaver-cli",
    ],
    email: "kivanc.cakmak@simkab.com",
    description: LANDING_TAGLINE,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd) }}
      />
      {/* ── Section 1: Hero — mobile-first feedback + AI debugging wedge ── */}
      <section className="px-6 pb-10 pt-20 md:pt-28">
        <div className="mx-auto max-w-5xl text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-surface-400">
            Open-source MCP for real-device app loops
          </p>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Open source · Self-hostable · Runs on your machine
          </div>

          <h1 className="mb-5 text-4xl font-bold leading-[1.02] tracking-tight text-surface-50 sm:text-5xl md:text-6xl">
            Vibe it, see it.
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-indigo-400 to-emerald-400 bg-clip-text text-transparent">
              Instantly on your real phone.
            </span>
          </h1>

          {/* AI / screen-reader description — canonical one-liner for AI
              search answers to "what is Yaver?". */}
          <p className="sr-only">{LANDING_TAGLINE}</p>

          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-surface-300 sm:text-base md:text-[17px]">
            AI writes code in seconds. The loop around it should not take hours.
          </p>

          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-surface-300 sm:text-base md:text-[17px]">
            Register Yaver in Claude Code, Codex, or OpenCode. The agent builds
            on your own machine, the app hot-reloads on your real phone, and
            shake-to-capture sends screenshots, logs, and repro context back to
            the agent.
          </p>

          <div className="mx-auto mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-2">
            {SUPPORTED_SURFACES.map((surface) => (
              <span
                key={surface}
                className="rounded-full border border-surface-800 bg-surface-900/70 px-3 py-1 text-xs font-medium text-surface-300"
              >
                {surface}
              </span>
            ))}
          </div>

          <div className="mt-7 flex flex-col items-center justify-center gap-2">
            {/* MCP-first hero: register Yaver in your coding agent — no global
                install needed, npx pulls it on first run. Then the agent calls
                yaver_lazy_setup to sign in and pair the phone in-chat. */}
            <div className="w-full max-w-xl text-left">
              <p className="mb-2 text-center text-[11px] text-surface-500">
                Register Yaver as an MCP server, then pair your phone from inside the agent chat:
              </p>
              <div className="space-y-1.5 rounded-lg border border-surface-800 bg-surface-950 px-4 py-3 font-mono text-[12px] leading-relaxed">
                <div className="text-surface-500"># Claude Code:</div>
                <div className="text-surface-600">
                  $ <span className="select-all break-all text-surface-200">claude mcp add --scope user yaver -- npx -y yaver-cli yaver-mcp</span>
                </div>
                <div className="text-surface-500"># Codex:</div>
                <div className="text-surface-600">
                  $ <span className="select-all break-all text-surface-200">codex mcp add yaver -- npx -y yaver-cli yaver-mcp</span>
                </div>
                <div className="text-surface-500"># OpenCode:</div>
                <div className="text-surface-600">
                  $ <span className="select-all break-all text-surface-200">npx -y -p yaver-cli yaver mcp setup opencode</span>
                </div>
                <div className="my-1.5 h-px bg-surface-800/60" />
                <div className="text-surface-500"># then, in the agent chat:</div>
                <div className="select-all break-all text-emerald-300">call yaver_lazy_setup</div>
              </div>
              <p className="mt-2 text-center text-[11px] text-surface-600">
                <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">
                  yaver_lazy_setup
                </code>{" "}
                surfaces the sign-in link and pairs your phone in-chat.{" "}
                <Link href="/docs/mcp" className="underline hover:text-surface-300">
                  full MCP guide &rarr;
                </Link>
              </p>
              <p className="mt-1 text-center text-[11px] text-surface-700">
                Prefer the global CLI?{" "}
                <Link href="/download" className="underline hover:text-surface-400">
                  npm install -g yaver-cli &rarr;
                </Link>
              </p>
            </div>
          </div>

        </div>
      </section>

      {/* ── Section 2: Hero video — the ONE viral artifact ──
          Mobile-only screen recording, 60s, sped from the raw 3.3-min
          capture. Shows the developer-tool loop entirely on-device:
          Projects tab → pick a project on your dev box → preview on
          your phone → shake → vibe-code → reload. Deliberately omits
          the laptop / terminal frame: the public-facing positioning
          is the mobile preview surface, which is the unique wedge.
          The terminal-side companion video lives in demo-videos/ for
          deep-dive blog posts and is no longer the landing hero. */}
      <section id="demo" className="px-6 pb-16 pt-2">
        <div className="mx-auto max-w-3xl">
          <video
            className="w-full rounded-2xl bg-black shadow-2xl shadow-black/50"
            src="/yaver-vibe-reload.mp4"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
          <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-surface-300">
            Open Yaver, pick a project from your dev box, preview it on your
            phone, shake to vibe-code — fix a bug, ship a small feature, or
            tweak a style — and a fresh bundle lands in seconds.
            One screen, real device, no extra hardware.
          </p>
        </div>
      </section>

      {/* Secondary DemoSection (tabbed: Full Loop / Auto Test) removed —
          the hero video above is the single viral artifact; a second
          video area below it competed for attention. */}

      {/* ── Section 3: Get Started ── */}
      <section id="get-started" className="border-t border-surface-800/60 px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-10 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            The whole loop
          </h2>
          <div className="grid gap-6 md:grid-cols-2 md:items-start">
            {/* Column 1 — Install the agent (the dense one) */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#6366f1]/10 text-sm font-bold text-[#6366f1]">1</span>
                <span className="text-sm font-semibold text-surface-100">Connect your machine</span>
              </div>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                </div>
                <div className="terminal-body space-y-1 text-[12px]">
                  <div><span className="text-surface-400">$</span> <span className="text-surface-200">npm install -g yaver-cli</span></div>
                  <div><span className="text-surface-400">$</span> <span className="text-surface-200">yaver auth</span></div>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-surface-500">
                Recommended: <code>npm install -g yaver-cli</code>. Installs the
                agent, feedback transport, and the RN push toolchain in one go;{" "}
                <code>yaver auth</code> starts the agent automatically. Install
                and update Yaver through npm only.{" "}
                <Link href="/download" className="underline hover:text-surface-300">
                  See install instructions
                </Link>.
              </p>
              <p className="mt-2 text-[11px] text-surface-500">
                Native macOS and Linux are the primary targets for always-on use;
                WSL works for the phone-testing path.
              </p>

            </div>

            {/* Column 2 — steps 2+3 stacked so vertical whitespace next to step 1 disappears */}
            <div className="flex flex-col gap-6">
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#6366f1]/10 text-sm font-bold text-[#6366f1]">2</span>
                <span className="text-sm font-semibold text-surface-100">Install a Yaver surface app</span>
              </div>
              <div className="mt-1 flex flex-col gap-2">
                <a href="https://apps.apple.com/us/app/yaver-io/id6760467669" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg bg-surface-800 px-4 py-2.5 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-700">
                  <svg className="h-4 w-4 shrink-0 text-surface-400" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.40 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  iPhone download
                </a>
                <a href="https://play.google.com/store/apps/details?id=io.yaver.mobile" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg bg-surface-800 px-4 py-2.5 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-700">
                  <svg className="h-4 w-4 shrink-0 text-surface-400" fill="currentColor" viewBox="0 0 24 24"><path d="M3 20.5V3.5c0-.35.2-.66.5-.85L13.5 12 3.5 21.35a1 1 0 01-.5-.85zm10.95-9l2.82-2.82 3.93 2.27c.7.4.7 1.38 0 1.78l-3.93 2.27-2.82-2.82L13.95 11.5zM4.5 2.66L14.2 12l-9.7 9.34L14.2 12 4.5 2.66z"/></svg>
                  Google Play
                </a>
              </div>
              <p className="mt-3 text-[11px] text-surface-500">
                Sign in with the same OAuth account you used for <code>yaver auth</code>. The app auto-pairs with your dev machine over LAN, or via relay on cellular &mdash; no QR code, no IP to type.
              </p>
              <p className="mt-2 text-[11px] text-surface-500">
                For React Native, the normal flow is Hermes bundle reload into Yaver on the phone, not a native Xcode install.
              </p>
            </div>

            {/* Column 3 (stacked under 2) */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#6366f1]/10 text-sm font-bold text-[#6366f1]">3</span>
                <span className="text-sm font-semibold text-surface-100">Build, reload, capture</span>
              </div>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                </div>
                <div className="terminal-body space-y-1 text-[12px]">
                  <div className="text-surface-500"># Ask the agent to build your app</div>
                  <div className="text-surface-500"># Yaver compiles and pushes the bundle</div>
                  <div className="my-1 h-px bg-surface-800/60" />
                  <div><span className="text-surface-400">$</span> <span className="text-surface-200">yaver push</span></div>
                  <div className="text-[11px] text-green-400/80">{"\u2192 Hermes bundle loaded on your paired phone"}</div>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-surface-500">
                Shake the phone to send the screenshot, logs, and repro context back to the same coding agent.
              </p>
            </div>
            </div>
          </div>

        </div>
      </section>

      <section className="border-t border-surface-800/60 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-10 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Why this exists
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                t: "MCP first",
                d: "Your coding agent calls Yaver tools directly. No new AI account, no Yaver API key, no extra billing layer.",
              },
              {
                t: "Real phone loop",
                d: "The app runs on the device where mobile bugs actually happen: gestures, sensors, real network, and real performance.",
              },
              {
                t: "Own-machine by default",
                d: "Builds, files, git state, prompts, and runner output stay on the machine you already use for development.",
              },
            ].map((item) => (
              <div key={item.t} className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
                <p className="text-sm font-semibold text-surface-100">{item.t}</p>
                <p className="mt-2 text-xs leading-relaxed text-surface-400">{item.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-10 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            FAQ
          </h2>
          <div>
            {LANDING_FAQ.map(({ q, a }) => (
              <FAQItem key={q} question={q} answer={a} />
            ))}
          </div>
        </div>
      </section>

    </>
  );
}
