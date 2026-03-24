"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

/* ── LemonSqueezy checkout URLs ─────────────────────────────────── */
const CHECKOUT = {
  relay:       "https://yaver.lemonsqueezy.com/checkout/buy/RELAY_PRODUCT_ID",
  cpu:         "https://yaver.lemonsqueezy.com/checkout/buy/CPU_PRODUCT_ID",
  gpu:         "https://yaver.lemonsqueezy.com/checkout/buy/GPU_PRODUCT_ID",
} as const;

const CONVEX_SITE_URL =
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  "https://shocking-echidna-394.eu-west-1.convex.site";

/* ── Provisioning progress (kept from original) ──────────────────── */
const PROVISIONING_STEPS = [
  { label: "Creating your dedicated server...", key: "creating" },
  { label: "Setting up DNS (yourname.relay.yaver.io)...", key: "dns" },
  { label: "Installing SSL certificate...", key: "ssl" },
  { label: "Deploying relay service...", key: "deploying" },
  { label: "Running health checks...", key: "health" },
  { label: "Your relay is ready!", key: "ready" },
];

type ProvisioningStatus =
  | "pending" | "creating" | "dns" | "ssl"
  | "deploying" | "health" | "ready" | "error";

function ProvisioningProgress() {
  const [status, setStatus] = useState<ProvisioningStatus>("creating");
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${CONVEX_SITE_URL}/subscription`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.provisioningStatus)
        setStatus(data.provisioningStatus as ProvisioningStatus);
      if (data.relayUrl) setRelayUrl(data.relayUrl);
      if (data.provisioningStatus === "error")
        setError(data.error || "Provisioning failed. Please contact support.");
    } catch {
      /* retry on next poll */
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 3000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  const currentStepIndex = PROVISIONING_STEPS.findIndex(
    (s) => s.key === status,
  );

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-[#6366f1]/40 bg-[#1a1d27] p-8">
      <h2 className="mb-6 text-center text-xl font-bold text-surface-50">
        {status === "ready"
          ? "Your relay is live!"
          : "Setting up your relay..."}
      </h2>
      {error ? (
        <div className="rounded-lg bg-red-500/10 p-4 text-center text-sm text-red-400">
          {error}
        </div>
      ) : (
        <div className="space-y-4">
          {PROVISIONING_STEPS.map((step, i) => {
            const isComplete = i < currentStepIndex || status === "ready";
            const isCurrent = i === currentStepIndex && status !== "ready";
            return (
              <div key={step.key} className="flex items-center gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                  {isComplete ? (
                    <svg className="h-5 w-5 text-[#22c55e]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : isCurrent ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#6366f1] border-t-transparent" />
                  ) : (
                    <div className="h-3 w-3 rounded-full bg-surface-700" />
                  )}
                </div>
                <span className={`text-sm ${isComplete ? "text-surface-300" : isCurrent ? "font-medium text-surface-100" : "text-surface-600"}`}>
                  {step.key === "ready" && status === "ready" ? (
                    <span className="text-[#22c55e]">{step.label}</span>
                  ) : (
                    step.label
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {relayUrl && status === "ready" && (
        <div className="mt-6 rounded-lg bg-[#0f1117] p-4 text-center">
          <p className="mb-1 text-xs text-surface-500">Your relay URL</p>
          <p className="font-mono text-sm font-medium text-[#6366f1]">
            {relayUrl}
          </p>
          <p className="mt-3 text-xs text-surface-500">
            This relay is now configured in your devices automatically.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Small helpers ──────────────────────────────────────────────── */
function Check({ accent = "text-surface-500" }: { accent?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${accent}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-surface-800/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between py-5 text-left">
        <span className="text-sm font-medium text-surface-100">{question}</span>
        <span className="ml-4 shrink-0 text-surface-500">{open ? "\u2212" : "+"}</span>
      </button>
      {open && <p className="pb-5 text-sm leading-relaxed text-surface-400">{answer}</p>}
    </div>
  );
}

/* ── Main pricing content ──────────────────────────────────────── */
function PricingContent() {
  const searchParams = useSearchParams();
  const showProvisioning = searchParams.get("success") === "true";

  if (showProvisioning) {
    return (
      <div className="px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <ProvisioningProgress />
          <div className="mt-8 text-center">
            <Link href="/pricing" className="text-xs text-surface-500 hover:text-surface-50">
              Back to pricing
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Simple, honest pricing.
          </h1>
          <p className="mx-auto max-w-xl text-sm leading-relaxed text-surface-500">
            Your code stays on your machine. We handle the infrastructure.
            Self-host everything for free, or let us run it for you.
          </p>
        </div>

        {/* ── 4 Plan cards ─────────────────────────────────────── */}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {/* Self-Hosted */}
          <div className="relative flex flex-col rounded-2xl border border-surface-800 bg-[#1a1d27] p-6">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-surface-100">Self-Hosted</h2>
              <p className="mt-1 text-xs text-surface-500">MIT licensed</p>
            </div>
            <div className="mb-5">
              <span className="text-3xl font-bold text-surface-50">$0</span>
              <span className="ml-1 text-sm text-surface-500">free forever</span>
            </div>
            <ul className="mb-6 flex-1 space-y-2.5">
              {[
                "Run your own relay server",
                "Fork, hack, self-host everything",
                "All features included",
                "Unlimited devices",
                "P2P encrypted connections",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-surface-300">
                  <Check accent="text-[#22c55e]" /> {f}
                </li>
              ))}
            </ul>
            <Link
              href="https://github.com/kivanccakmak/yaver.io"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg border border-surface-700 bg-transparent py-2.5 text-center text-sm font-medium text-surface-300 transition-colors hover:border-surface-500 hover:text-surface-100"
            >
              Get Started
            </Link>
          </div>

          {/* Managed Relay */}
          <div className="relative flex flex-col rounded-2xl border border-surface-800 bg-[#1a1d27] p-6">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-surface-100">Managed Relay</h2>
              <p className="mt-1 text-xs text-surface-500">Zero-config P2P tunneling</p>
            </div>
            <div className="mb-5">
              <span className="text-3xl font-bold text-surface-50">$10</span>
              <span className="ml-1 text-sm text-surface-500">/mo</span>
            </div>
            <ul className="mb-6 flex-1 space-y-2.5">
              {[
                "No VPS or port forwarding",
                "Works on any network",
                "Dedicated server, just yours",
                "Auto-provisioned in minutes",
                "Your own subdomain",
                "Auto-updates, always current",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-surface-300">
                  <Check /> {f}
                </li>
              ))}
            </ul>
            <a
              href={CHECKOUT.relay}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg border border-surface-700 bg-surface-800/50 py-2.5 text-center text-sm font-medium text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
            >
              Subscribe
            </a>
          </div>

          {/* CPU Dev Machine */}
          <div className="relative flex flex-col rounded-2xl border border-[#6366f1]/40 bg-[#1a1d27] p-6">
            <div className="absolute -top-3 right-6">
              <span className="rounded-full bg-[#6366f1] px-3 py-1 text-[10px] font-semibold text-white">
                popular
              </span>
            </div>
            <div className="mb-5">
              <h2 className="text-base font-semibold text-surface-100">CPU Machine</h2>
              <p className="mt-1 text-xs text-surface-500">Your own dedicated dev machine</p>
            </div>
            <div className="mb-5">
              <span className="text-3xl font-bold text-surface-50">$49</span>
              <span className="ml-1 text-sm text-surface-500">/mo</span>
            </div>
            <ul className="mb-6 flex-1 space-y-2.5">
              {[
                "8 vCPU / 16 GB RAM / 160 GB NVMe",
                "Ready in minutes, entirely yours",
                "Node.js, Python, Go, Rust, Docker",
                "Expo CLI + EAS CLI pre-installed",
                "Build iOS without a Mac (EAS Build)",
                "Managed relay included",
                "Yaver server pre-installed",
                "Accessible via Yaver app or SSH",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-surface-300">
                  <Check accent="text-[#6366f1]" /> {f}
                </li>
              ))}
            </ul>
            <a
              href={CHECKOUT.cpu}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg bg-[#6366f1] py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-[#5558e6]"
            >
              Subscribe &mdash; $49/mo
            </a>
          </div>

          {/* GPU Dev Machine */}
          <div className="relative flex flex-col rounded-2xl border border-[#76b900]/40 bg-[#76b900]/[0.03] p-6">
            <div className="absolute -top-3 right-6">
              <span className="rounded-full bg-[#76b900] px-3 py-1 text-[10px] font-semibold text-white">
                GPU
              </span>
            </div>
            <div className="mb-5">
              <h2 className="text-base font-semibold text-surface-100">GPU Machine</h2>
              <p className="mt-1 text-xs text-surface-500">Dedicated NVIDIA RTX 4000</p>
            </div>
            <div className="mb-5">
              <span className="text-3xl font-bold text-surface-50">$299</span>
              <span className="ml-1 text-sm text-surface-500">/mo</span>
            </div>
            <ul className="mb-6 flex-1 space-y-2.5">
              {[
                "NVIDIA RTX 4000 — 20 GB VRAM",
                "Everything in CPU Machine, plus:",
                "Ollama + Qwen 2.5 Coder 32B pre-loaded",
                "PersonaPlex 7B — voice AI, hands-free coding",
                "Run any HuggingFace model locally",
                "Full local AI stack — no API keys",
                "GPU-accelerated ML builds",
                "Your code never leaves your machine",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-surface-300">
                  <Check accent="text-[#76b900]" /> {f}
                </li>
              ))}
            </ul>
            <a
              href={CHECKOUT.gpu}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg bg-[#76b900] py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-[#6aa300]"
            >
              Subscribe &mdash; $299/mo
            </a>
          </div>
        </div>

        {/* ── Comparison table ──────────────────────────────────── */}
        <section className="mt-20">
          <h2 className="mb-8 text-center text-xl font-bold text-surface-50">
            Compare plans
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-surface-800">
                  <th className="pb-4 pr-6 text-xs font-medium text-surface-500">Feature</th>
                  <th className="pb-4 px-4 text-center text-xs font-medium text-surface-500">Self-Hosted</th>
                  <th className="pb-4 px-4 text-center text-xs font-medium text-surface-500">Relay</th>
                  <th className="pb-4 px-4 text-center text-xs font-medium text-surface-500">CPU Machine</th>
                  <th className="pb-4 pl-4 text-center text-xs font-medium text-surface-500">GPU Machine</th>
                </tr>
              </thead>
              <tbody className="text-surface-300">
                {([
                  ["Managed relay",              false, true,  true,  true],
                  ["Works on your hardware",     true,  true,  "opt", "opt"],
                  ["Dedicated cloud machine",    false, false, true,  true],
                  ["NVIDIA GPU (20 GB VRAM)",    false, false, false, true],
                  ["Ollama + Qwen 2.5 Coder",   false, false, false, true],
                  ["Voice AI (PersonaPlex)",     false, false, false, true],
                  ["EAS Build (iOS w/o Mac)",    false, false, true,  true],
                  ["Auto-provisioned",           false, true,  true,  true],
                  ["Setup needed",               true,  false, false, false],
                ] as [string, boolean | string, boolean | string, boolean | string, boolean | string][]).map(([feature, ...vals]) => (
                  <tr key={feature} className="border-b border-surface-800/40">
                    <td className="py-3 pr-6 text-xs text-surface-400">{feature}</td>
                    {vals.map((v, i) => (
                      <td key={i} className="py-3 px-4 text-center text-xs">
                        {v === true ? (
                          <span className="text-[#22c55e]">&#10003;</span>
                        ) : v === false ? (
                          <span className="text-surface-600">&mdash;</span>
                        ) : (
                          <span className="text-surface-400">optional</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Self-host section ────────────────────────────────── */}
        <section className="mt-20 rounded-2xl border border-surface-800 bg-[#1a1d27] p-8">
          <h2 className="mb-4 text-xl font-bold text-surface-50">Self-host for free</h2>
          <p className="mb-6 text-sm leading-relaxed text-surface-400">
            Yaver is fully open-source. You can run your own relay server on any VPS, Raspberry Pi,
            or cloud instance. All you need is Docker and a public IP.
          </p>
          <div className="rounded-lg bg-[#0f1117] p-4">
            <pre className="overflow-x-auto text-sm text-surface-300">
              <code>{`# Clone the repo
git clone https://github.com/kivanccakmak/yaver.io.git
cd yaver.io/relay

# Run with Docker
RELAY_PASSWORD=your-secret docker compose up -d

# Health check
curl http://localhost:8080/health`}</code>
            </pre>
          </div>
          <div className="mt-4 flex gap-3">
            <Link href="/docs/self-hosting" className="text-sm text-[#6366f1] hover:underline">
              Self-hosting guide
            </Link>
            <span className="text-surface-700">|</span>
            <Link href="/manuals/relay-setup" className="text-sm text-[#6366f1] hover:underline">
              Relay setup manual
            </Link>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────── */}
        <section className="mt-20">
          <h2 className="mb-8 text-center text-xl font-bold text-surface-50">
            Frequently asked questions
          </h2>
          <div className="mx-auto max-w-2xl">
            <FAQItem
              question="Do I need a card to self-host?"
              answer="No. The self-hosted version is MIT licensed and completely free. You can run it forever without signing up or paying anything."
            />
            <FAQItem
              question="What happens when I subscribe to a machine plan?"
              answer="We create a dedicated server just for you. It appears in the Yaver app within minutes. No sharing — the machine is entirely yours."
            />
            <FAQItem
              question="What happens when I cancel?"
              answer="Your server stays active until the end of the billing period, then is deleted after a 24-hour grace period. Your Yaver account and local data remain intact."
            />
            <FAQItem
              question="Is my code safe on a cloud machine?"
              answer="Your machine connects through Yaver's P2P system — exactly like your local machine. The relay never sees your code. All data flows directly between your devices, encrypted end-to-end."
            />
            <FAQItem
              question="Can I bring my own server?"
              answer="Yes. Just self-host and point the CLI at your own machine. The managed plans are for people who don't want to manage infrastructure."
            />
            <FAQItem
              question="Why is GPU $299?"
              answer="Because we provision a dedicated NVIDIA RTX 4000 server entirely for you — no sharing. It includes pre-loaded AI models (Qwen 2.5 Coder, PersonaPlex, Whisper), setup, monitoring, and automatic updates."
            />
            <FAQItem
              question="What specs does the CPU Machine have?"
              answer="8 vCPU, 16 GB RAM, 160 GB NVMe storage. Entirely dedicated to you — no sharing, no noisy neighbors."
            />
            <FAQItem
              question="Is the shared relay good enough?"
              answer="For most users, yes. The shared relay handles typical usage well. The managed plan ($10/mo) is best for power users who want guaranteed bandwidth and a dedicated server."
            />
          </div>
        </section>

        <p className="mt-12 text-center text-xs leading-relaxed text-surface-600">
          All machines are dedicated &mdash; no sharing, no noisy neighbors.
          Managed by Yaver, provisioned specifically for your account.
        </p>

        <div className="mt-6 text-center">
          <Link href="/" className="text-xs text-surface-500 hover:text-surface-50">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-96 items-center justify-center">
          <div className="text-surface-500">Loading...</div>
        </div>
      }
    >
      <PricingContent />
    </Suspense>
  );
}
