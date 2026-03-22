"use client";

import Link from "next/link";
import { useState } from "react";

const MONTHLY_CHECKOUT_URL =
  "https://yaver.lemonsqueezy.com/checkout/buy/MONTHLY_PRODUCT_ID";
const YEARLY_CHECKOUT_URL =
  "https://yaver.lemonsqueezy.com/checkout/buy/YEARLY_PRODUCT_ID";

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

export default function PricingPage() {
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Simple, transparent pricing
          </h1>
          <p className="text-sm text-surface-500">
            Yaver is free and open-source. Pay only if you want a managed relay server.
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
          {/* Free tier */}
          <div className="rounded-2xl border border-surface-800 bg-[#1a1d27] p-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-surface-100">Free</h2>
              <p className="mt-1 text-xs text-surface-500">Current plan</p>
            </div>
            <div className="mb-6">
              <span className="text-4xl font-bold text-surface-50">$0</span>
              <span className="ml-1 text-sm text-surface-500">/month</span>
            </div>
            <ul className="mb-8 space-y-3">
              {[
                "Shared relay server",
                "500MB/day bandwidth (relaxed when idle)",
                "All features included",
                "Self-host your own relay",
                "Unlimited devices",
                "P2P encrypted connections",
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
            <button
              disabled
              className="w-full rounded-lg border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm font-medium text-surface-500 cursor-not-allowed"
            >
              Already included
            </button>
          </div>

          {/* Managed Relay tier */}
          <div className="relative rounded-2xl border border-[#6366f1]/40 bg-[#1a1d27] p-8">
            <div className="absolute -top-3 left-6">
              <span className="rounded-full bg-[#6366f1] px-3 py-1 text-[11px] font-semibold text-white">
                Recommended
              </span>
            </div>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-surface-100">Managed Relay</h2>
              <p className="mt-1 text-xs text-surface-500">Dedicated infrastructure</p>
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
                "Dedicated server (Hetzner Cloud)",
                "20TB/month bandwidth",
                "Auto-provisioned in ~90 seconds",
                "Your own subdomain (*.relay.yaver.io)",
                "Auto-TLS (Let's Encrypt)",
                "24/7 uptime monitoring",
              ].map((feature) => (
                <li key={feature} className="flex items-start gap-2.5 text-sm text-surface-300">
                  <span className="mt-0.5 text-[#6366f1]">
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
              className="block w-full rounded-lg bg-[#6366f1] px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-[#5558e6]"
            >
              Get Managed Relay
            </a>
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

        <div className="mt-12 text-center">
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
