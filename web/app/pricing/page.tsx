"use client";

import Link from "next/link";
import { useState } from "react";

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For individual developers trying it out.",
    features: [
      "1 device connection",
      "5 tasks per day",
      "P2P encrypted",
      "Community support",
    ],
    cta: "Get started",
    href: "/auth?signup=true",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$0",
    originalPrice: "$12/mo",
    period: "during early access",
    description: "For developers who use Claude daily.",
    features: [
      "Unlimited devices",
      "Unlimited tasks",
      "P2P encrypted",
      "Priority support",
      "Task history & search",
      "Team sharing (coming soon)",
    ],
    cta: "Get started free",
    href: "/auth?signup=true",
    highlighted: true,
    badge: "FREE IN EARLY ACCESS",
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For teams with security and compliance needs.",
    features: [
      "Everything in Pro",
      "SSO / SAML",
      "Audit logs",
      "Dedicated support",
      "Custom deployment",
      "SLA guarantee",
    ],
    cta: "Contact sales",
    href: "mailto:sales@yaver.io",
    highlighted: false,
  },
];

const faqs = [
  {
    q: "Do I need my own Claude API key?",
    a: "Yes. Yaver connects your devices to run Claude SDK on your own machine using your own API key or Claude subscription. We don't proxy or store your API keys.",
  },
  {
    q: "Is my data encrypted?",
    a: "All data flows directly between your devices over QUIC with end-to-end encryption. Task data, code, and output never pass through our servers. We only handle authentication and peer discovery.",
  },
  {
    q: "What happens if P2P connection fails?",
    a: "If a direct P2P connection cannot be established (e.g., restrictive NAT), we fall back to an encrypted relay. Your data is still end-to-end encrypted even through the relay.",
  },
  {
    q: "Is it really free?",
    a: "Yes. Yaver is in early access and all features across all tiers are completely free. We will give at least 60 days notice before any paid plans begin.",
  },
  {
    q: "Can I cancel my subscription anytime?",
    a: "Yes. Cancel anytime from your account settings. You'll keep access until the end of your billing period.",
  },
  {
    q: "Do you support team accounts?",
    a: "Team features are coming soon. Enterprise customers can contact us for early access to team management, shared devices, and audit logging.",
  },
  {
    q: "What is your privacy model?",
    a: "Yaver uses a zero-knowledge architecture. All code, prompts, and outputs flow directly between your devices over P2P connections. Our servers only handle authentication and peer discovery -- we never see, store, or process your data. Even if our servers were compromised, your code and task data would not be exposed because it never passes through them.",
  },
];

export default function PricingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">Pricing</h1>
          <p className="mb-6 text-sm text-surface-500">
            Start for free. Upgrade when you need more.
          </p>
          <div className="inline-flex items-center rounded-full border border-green-300 bg-green-50 px-4 py-2 text-xs font-semibold text-green-700 dark:border-green-800/60 dark:bg-green-950/50 dark:text-green-400">
            Early Access &mdash; All plans are free for a limited time
          </div>
        </div>

        {/* Tiers */}
        <div className="mb-24 grid grid-cols-1 gap-4 md:grid-cols-3">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`card relative flex flex-col ${
                tier.highlighted ? "border-surface-600" : ""
              }`}
            >
              {tier.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-green-600 px-3 py-0.5 text-[10px] font-bold tracking-wider text-white dark:bg-green-500 dark:text-surface-950">
                  {tier.badge}
                </div>
              )}
              <div className="mb-6">
                <h3 className="mb-1 text-sm font-semibold text-surface-400">{tier.name}</h3>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-surface-50">{tier.price}</span>
                  {(tier as typeof tier & { originalPrice?: string }).originalPrice && (
                    <span className="text-sm text-surface-600 line-through">{(tier as typeof tier & { originalPrice?: string }).originalPrice}</span>
                  )}
                  {tier.period && (
                    <span className="text-sm text-surface-500">{tier.period}</span>
                  )}
                </div>
                <p className="mt-2 text-xs text-surface-500">{tier.description}</p>
              </div>

              <ul className="mb-8 flex-1 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-surface-300">
                    <span className="mt-0.5 text-surface-500">&#10003;</span>
                    {feature}
                  </li>
                ))}
              </ul>

              <a
                href={tier.href}
                className={
                  tier.highlighted
                    ? "btn-primary w-full py-3 text-sm text-center"
                    : "btn-secondary w-full py-3 text-sm text-center"
                }
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-8 text-center text-xl font-bold text-surface-50">
            Frequently asked questions
          </h2>
          <div className="space-y-2">
            {faqs.map((faq, i) => (
              <div key={i} className="border-b border-surface-800">
                <button
                  className="flex w-full items-center justify-between py-4 text-left text-sm font-medium text-surface-200 hover:text-surface-50"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                >
                  {faq.q}
                  <span className="ml-4 text-surface-600">
                    {openFaq === i ? "\u2212" : "+"}
                  </span>
                </button>
                {openFaq === i && (
                  <p className="pb-4 text-sm leading-relaxed text-surface-500">
                    {faq.a}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 text-center">
          <Link href="/" className="text-xs text-surface-500 hover:text-surface-50">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
