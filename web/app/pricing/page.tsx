"use client";

import Link from "next/link";
import { HIDE_PAID_UI } from "@/lib/launchFlags";

// Public pricing page — source of truth for the locked Model A catalog
// (docs/audits/hetzner-access-and-monetization-2026-08.md §0.5):
//   - Self-hosted: free, your machines, npm install.
//   - Cloud Workspace: $29/mo BYOK, 120 standard hours, private relay,
//     auto-stop, wallet for overage. The ONLY compute plan.
//   - Relay Pro: $9/mo pooled private relay for self-hosted setups.
// cloud-agent (managed model) is legacy/never-ship and deliberately absent.
//
// Copy rules (monetization.md): no "GPU", "Hetzner", "VM", "tokens" on the
// public path — "workspace", "hours", "auto-stops", "bring your own AI
// account". Purchase happens in the authenticated dashboard (BillingView)
// because of App Store checkout policy; the CTA below is gated by
// HIDE_PAID_UI (the single launch flag — never shadow a copy of it).

const PLANS = [
  {
    name: "Self-hosted",
    price: "$0",
    per: "forever",
    highlight: false,
    tagline: "Run Yaver on your own machines. Full runtime, no Yaver infrastructure.",
    items: [
      "npm install -g yaver-cli on your Mac, Linux box, or Pi",
      "Your files, secrets, and runner output stay on your hardware",
      "Connect over LAN, your own relay, or Tailscale",
      "All surfaces: phone, tablet, watch, TV, car, web",
      "Open source — FSL-1.1-Apache-2.0 core",
    ],
    ctaLabel: "Install free",
    ctaHref: "/download",
  },
  {
    name: "Cloud Workspace",
    price: "$29",
    per: "/mo",
    highlight: true,
    tagline: "A persistent remote runtime when you don't want to babysit a box.",
    items: [
      "Persistent workspace — repos and setup saved",
      "120 standard hours of active runtime per month",
      "Bring your own Claude Code, Codex, or OpenCode account",
      "Private relay included — reachable from anywhere",
      "Auto-stops when idle; reopens where you left off",
      "One workspace per plan, fair-use metered",
    ],
    ctaLabel: HIDE_PAID_UI ? "Sign in to get started" : "Get started",
    ctaHref: "/auth",
  },
  {
    name: "Relay Pro",
    price: "$9",
    per: "/mo",
    highlight: false,
    tagline: "Private connectivity for your self-hosted setup, away from home.",
    items: [
      "Private managed relay for your devices",
      "Reachable on cellular, hotel Wi-Fi, anywhere",
      "Per-user, per-device authentication",
      "Rides a shared, pass-through pool — no tenant code, no cross-tenant access",
      "Pairs with a self-hosted setup",
    ],
    ctaLabel: HIDE_PAID_UI ? "Sign in to get started" : "Get started",
    ctaHref: "/auth",
  },
];

const PRICING_FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What is a standard hour?",
    a: "Cloud Workspace includes 120 standard hours per month of active runtime. Bigger workspaces burn the same budget faster — a heavy workspace consumes standard hours at a higher rate, so upgrading can't stretch your allowance into a loss for us. The app always shows your remaining time in real wall-clock hours for your current workspace, not the adjusted number.",
  },
  {
    q: "What happens when I'm idle?",
    a: "The workspace auto-stops after idle — repos and setup are saved, and it reopens where you left off. Stopping halts compute billing entirely; only the parked state (saved workspace) costs anything, and that's covered by your plan. You'll get a heads-up before it stops.",
  },
  {
    q: "What does 'bring your own AI account' mean?",
    a: "Yaver doesn't sell AI model access. You use your existing Claude Code, Codex, or OpenCode account — your subscription, your keys, your usage — and Yaver provides the workspace, the mobile cockpit, previews, private connectivity, and auto-stop around it.",
  },
  {
    q: "Can I self-host instead of paying?",
    a: "Yes — the full runtime is free and open source. Install the CLI on your own machine, pair the app, and use LAN, your own relay, or Tailscale for connectivity. Cloud Workspace and Relay Pro are for when you want Yaver to run that infrastructure for you.",
  },
  {
    q: "Do I need a cloud account or token to use Yaver?",
    a: "No. Yaver never asks you for cloud provider credentials. Your machines are yours; the managed path uses Yaver's own infrastructure, provisioned server-side behind your subscription.",
  },
  {
    q: "What isn't for sale yet?",
    a: "GPU workspaces and a managed (included) model tier are not offered. If they ship, they'll be priced so they're never subsidized by other plans.",
  },
  {
    q: "How do I pay?",
    a: "Checkout happens in the Yaver dashboard after you sign in. Subscriptions are billed through LemonSqueezy.",
  },
];

function FAQItem({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="border-b border-surface-800/60 py-5">
      <p className="text-sm font-medium text-surface-100">{question}</p>
      <p className="mt-2 text-sm leading-relaxed text-surface-400">{answer}</p>
    </div>
  );
}

export default function PricingPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="px-6 pb-12 pt-20 md:pt-28">
        <div className="mx-auto max-w-5xl text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-surface-400">
            Pricing
          </p>
          <h1 className="mb-5 text-4xl font-bold leading-[1.02] tracking-tight text-surface-50 md:text-5xl">
            Self-host for free.
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-indigo-400 to-emerald-400 bg-clip-text text-transparent">
              Pay only when Yaver runs infrastructure for you.
            </span>
          </h1>
          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-surface-300 md:text-base">
            The full remote AI runtime is free on your own machines. The paid
            plans are Yaver-managed: a persistent Cloud Workspace and private
            relay connectivity.
          </p>
        </div>
      </section>

      {/* ── Plan cards ── */}
      <section className="px-6 pb-16">
        <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={
                "flex flex-col rounded-xl border p-6 " +
                (plan.highlight
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-surface-800 bg-surface-900/50")
              }
            >
              <p className="text-sm font-semibold text-surface-100">{plan.name}</p>
              <p className="mt-3 text-4xl font-bold text-surface-50">
                {plan.price}
                <span className="text-base font-normal text-surface-500">{plan.per}</span>
              </p>
              <p className="mt-3 text-xs leading-relaxed text-surface-400">{plan.tagline}</p>
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {plan.items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-relaxed text-surface-400">
                    <span className="mt-0.5 shrink-0 text-emerald-500">{"\u2713"}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Link
                href={plan.ctaHref}
                className={
                  "mt-6 rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors " +
                  (plan.highlight
                    ? "btn-primary"
                    : "border border-surface-700 bg-surface-900 text-surface-200 hover:border-surface-600 hover:text-surface-50")
                }
              >
                {plan.ctaLabel}
              </Link>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-surface-600">
          Cloud Workspace includes 120 standard hours per month. Beyond the
          included hours, overage is metered from a small prepaid balance and
          stops when it can't cover the rate — you're never billed for compute
          we can't recover.
        </p>
      </section>

      {/* ── Comparison ── */}
      <section className="border-t border-surface-800/60 px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-8 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Which path is yours?
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-xs uppercase tracking-wider text-surface-500">
                  <th className="py-3 pr-4 font-medium">Feature</th>
                  <th className="py-3 pr-4 font-medium">Self-hosted</th>
                  <th className="py-3 pr-4 font-medium">Cloud Workspace</th>
                  <th className="py-3 font-medium">Relay Pro</th>
                </tr>
              </thead>
              <tbody className="text-surface-300">
                {[
                  ["Where the agent runs", "Your machines", "Yaver-managed workspace", "Your machines"],
                  ["Setup", "npm install -g yaver-cli", "One tap from the app", "Attach to self-hosted"],
                  ["Included runtime", "Unlimited (your hardware)", "120 standard hours/mo", "—"],
                  ["Private relay", "Your own or Tailscale", "Included", "$9/mo"],
                  ["Auto-stop", "Your choice", "Built in, saves your state", "—"],
                  ["Monthly cost", "$0", "$29", "$9"],
                ].map((row) => (
                  <tr key={row[0]} className="border-b border-surface-800/40">
                    <td className="py-3 pr-4 font-medium text-surface-100">{row[0]}</td>
                    <td className="py-3 pr-4">{row[1]}</td>
                    <td className="py-3 pr-4">{row[2]}</td>
                    <td className="py-3">{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="border-t border-surface-800/60 px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-8 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Pricing FAQ
          </h2>
          {PRICING_FAQ.map(({ q, a }) => (
            <FAQItem key={q} question={q} answer={a} />
          ))}
        </div>
      </section>
    </>
  );
}
