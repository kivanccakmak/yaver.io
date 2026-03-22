"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

const MONTHLY_CHECKOUT_URL =
  "https://yaver.lemonsqueezy.com/checkout/buy/MONTHLY_PRODUCT_ID";
const YEARLY_CHECKOUT_URL =
  "https://yaver.lemonsqueezy.com/checkout/buy/YEARLY_PRODUCT_ID";

const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL || "https://shocking-echidna-394.eu-west-1.convex.site";

const PROVISIONING_STEPS = [
  { label: "Creating your dedicated server...", key: "creating" },
  { label: "Setting up DNS (yourname.relay.yaver.io)...", key: "dns" },
  { label: "Installing SSL certificate...", key: "ssl" },
  { label: "Deploying relay service...", key: "deploying" },
  { label: "Running health checks...", key: "health" },
  { label: "Your relay is ready!", key: "ready" },
];

type ProvisioningStatus = "pending" | "creating" | "dns" | "ssl" | "deploying" | "health" | "ready" | "error";

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
      if (data.provisioningStatus) {
        setStatus(data.provisioningStatus as ProvisioningStatus);
      }
      if (data.relayUrl) {
        setRelayUrl(data.relayUrl);
      }
      if (data.provisioningStatus === "error") {
        setError(data.error || "Provisioning failed. Please contact support.");
      }
    } catch {
      // Silently retry on next poll
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 3000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  const currentStepIndex = PROVISIONING_STEPS.findIndex((s) => s.key === status);

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-[#6366f1]/40 bg-[#1a1d27] p-8">
      <h2 className="mb-6 text-center text-xl font-bold text-surface-50">
        {status === "ready" ? "Your relay is live!" : "Setting up your relay..."}
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
            const isPending = i > currentStepIndex && status !== "ready";

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
                <span
                  className={`text-sm ${
                    isComplete
                      ? "text-surface-300"
                      : isCurrent
                        ? "font-medium text-surface-100"
                        : "text-surface-600"
                  }`}
                >
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
          <p className="font-mono text-sm font-medium text-[#6366f1]">{relayUrl}</p>
          <p className="mt-3 text-xs text-surface-500">
            This relay is now configured in your devices automatically.
          </p>
        </div>
      )}
    </div>
  );
}

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

function PricingContent() {
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");
  const searchParams = useSearchParams();
  const showProvisioning = searchParams.get("success") === "true";

  if (showProvisioning) {
    return (
      <div className="px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <ProvisioningProgress />
          <div className="mt-8 text-center">
            <Link
              href="/pricing"
              className="text-xs text-surface-500 hover:text-surface-50"
            >
              Back to pricing
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Free and open-source. Always.
          </h1>
          <p className="mx-auto max-w-xl text-sm leading-relaxed text-surface-500">
            Yaver is a P2P tool — your code stays on your machines, encrypted end-to-end.
            Every user gets a free relay server included. Self-host everything or use our infrastructure — your choice.
          </p>
        </div>

        {/* Billing toggle */}
        <div className="mb-10 flex items-center justify-center gap-3">
          <button
            onClick={() => setBilling("monthly")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              billing === "monthly"
                ? "bg-[#6366f1] text-white"
                : "text-surface-400 hover:text-surface-200"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setBilling("yearly")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              billing === "yearly"
                ? "bg-[#6366f1] text-white"
                : "text-surface-400 hover:text-surface-200"
            }`}
          >
            Yearly
            <span className="ml-1.5 rounded-full bg-[#22c55e]/10 px-2 py-0.5 text-[11px] font-medium text-[#22c55e]">
              Save 17%
            </span>
          </button>
        </div>

        {/* Pricing cards */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Free — everyone gets this */}
          <div className="relative rounded-2xl border border-[#22c55e]/40 bg-[#1a1d27] p-8">
            <div className="absolute -top-3 left-6">
              <span className="rounded-full bg-[#22c55e] px-3 py-1 text-[11px] font-semibold text-white">
                Included for everyone
              </span>
            </div>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-surface-100">Free Relay</h2>
              <p className="mt-1 text-xs text-surface-500">public.yaver.io — ready to use</p>
            </div>
            <div className="mb-6">
              <span className="text-4xl font-bold text-surface-50">$0</span>
              <span className="ml-1 text-sm text-surface-500">forever</span>
            </div>
            <ul className="mb-8 space-y-3">
              {[
                "P2P encrypted connections — your code never leaves your machines",
                "Free shared relay (public.yaver.io)",
                "Bandwidth adapts dynamically — relaxed when server is idle",
                "All features included — no paywall, no limits on functionality",
                "Unlimited devices",
                "Self-host your own relay anytime (Docker, any VPS)",
              ].map((feature) => (
                <li key={feature} className="flex items-start gap-2.5 text-sm text-surface-300">
                  <span className="mt-0.5 text-[#22c55e]">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <div className="rounded-lg border border-surface-800 bg-[#0f1117] p-4 text-xs text-surface-500 leading-relaxed">
              <strong className="text-surface-300">Is the free relay secure?</strong> Yes — the relay is a pass-through proxy.
              It never stores, reads, or logs your data. All connections are encrypted via QUIC (TLS 1.3).
              The relay only sees encrypted bytes passing through. Your auth tokens, code, and task data are
              end-to-end encrypted between your devices.
            </div>
          </div>

          {/* Dedicated relay — optional utility */}
          <div className="rounded-2xl border border-surface-800 bg-[#1a1d27] p-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-surface-100">Dedicated Relay</h2>
              <p className="mt-1 text-xs text-surface-500">Optional — your own server, if you want one</p>
            </div>
            <div className="mb-6">
              <span className="text-4xl font-bold text-surface-50">
                {billing === "monthly" ? "$10" : "$100"}
              </span>
              <span className="ml-1 text-sm text-surface-500">
                /{billing === "monthly" ? "month" : "year"}
              </span>
            </div>
            <ul className="mb-8 space-y-3">
              {[
                "Your own dedicated server (Hetzner Cloud ARM)",
                "No bandwidth limits",
                "Auto-provisioned in ~90 seconds",
                "Your own subdomain (*.relay.yaver.io)",
                "HTTPS with auto-renewing certificates",
                "Auto-updates — always the latest relay version",
              ].map((feature) => (
                <li key={feature} className="flex items-start gap-2.5 text-sm text-surface-300">
                  <span className="mt-0.5 text-surface-500">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <a
              href={billing === "monthly" ? MONTHLY_CHECKOUT_URL : YEARLY_CHECKOUT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-center text-sm font-medium text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
            >
              Get a dedicated relay
            </a>
            <p className="mt-3 text-center text-[11px] text-surface-600">
              Or self-host your own — same software, zero cost.
              This just saves you the setup.
            </p>
          </div>
        </div>

        {/* Self-host section */}
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
            <Link
              href="/docs/self-hosting"
              className="text-sm text-[#6366f1] hover:underline"
            >
              Self-hosting guide
            </Link>
            <span className="text-surface-700">|</span>
            <Link
              href="/manuals/relay-setup"
              className="text-sm text-[#6366f1] hover:underline"
            >
              Relay setup manual
            </Link>
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-20">
          <h2 className="mb-8 text-center text-xl font-bold text-surface-50">
            Frequently asked questions
          </h2>
          <div className="mx-auto max-w-2xl">
            <FAQItem
              question="Why do I need a relay server?"
              answer="When your mobile device and desktop are on different networks (e.g., you're on cellular or at a coffee shop), they can't connect directly. A relay server acts as a pass-through proxy so your devices can always reach each other. It never stores any of your data — it's a transparent pipe."
            />
            <FAQItem
              question="Can I self-host instead of paying?"
              answer="Absolutely. Yaver is fully open-source and the relay server is included. You can run it on any VPS (Hetzner, DigitalOcean, AWS, etc.), a Raspberry Pi, or even use Tailscale to skip the relay entirely. The managed plan is for people who prefer a zero-maintenance setup."
            />
            <FAQItem
              question="What happens if I cancel my subscription?"
              answer="Your managed relay server will continue running for 7 days after cancellation to give you time to migrate. After that, the server is deprovisioned. Your Yaver account, devices, and all local data remain intact — you just fall back to the shared relay or your own self-hosted relay."
            />
            <FAQItem
              question="Is the shared relay good enough?"
              answer="For most users, yes. The shared relay handles typical usage well. The managed plan is best for power users who want guaranteed bandwidth, lower latency, and a dedicated server that's not shared with anyone else."
            />
            <FAQItem
              question="Can I change regions after provisioning?"
              answer="Not yet, but it's on the roadmap. For now, choose the region closest to you when signing up. If you need to switch, contact support and we'll re-provision in the new region."
            />
          </div>
        </section>

        {/* Infrastructure note */}
        <p className="mt-12 text-center text-xs leading-relaxed text-surface-600">
          This is an infrastructure hosting service. Your relay server runs on dedicated
          hardware provisioned specifically for your account.
        </p>

        <div className="mt-6 text-center">
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

export default function PricingPage() {
  return (
    <Suspense fallback={<div className="flex h-96 items-center justify-center"><div className="text-surface-500">Loading...</div></div>}>
      <PricingContent />
    </Suspense>
  );
}
