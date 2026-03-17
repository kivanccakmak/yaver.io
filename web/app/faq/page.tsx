"use client";

import Link from "next/link";
import { useState } from "react";

const faqs = [
  {
    category: "Getting Started",
    items: [
      {
        q: "Do I need my own Claude API key?",
        a: "Yes. Yaver connects your devices to run Claude SDK on your own machine using your own API key or Claude subscription. We don't proxy or store your API keys.",
      },
      {
        q: "Does Yaver auto-start when my PC boots?",
        a: "Yes. During installation, Yaver registers itself as a system service. On macOS it uses a LaunchAgent, on Linux a systemd user service, and on Windows a startup entry. After a reboot, `yaver serve` starts automatically in the background — no manual intervention needed. You can disable this with `yaver config set auto-start false`.",
      },
      {
        q: "Do I need to re-authenticate after a reboot?",
        a: "No. Once you run `yaver auth` the first time, your session is saved locally on your machine. It persists across reboots indefinitely. The CLI uses this saved session every time it starts — no browser interaction needed after the initial sign-in.",
      },
    ],
  },
  {
    category: "Networking & VPN",
    items: [
      {
        q: "Can I use Yaver with a VPN?",
        a: "Yes. Yaver works perfectly alongside any VPN — you don't even have to think about it. As long as both your phone and dev machine have internet access, Yaver will connect.",
      },
      {
        q: "What happens if my P2P connection fails?",
        a: "If a direct P2P connection cannot be established (e.g., restrictive NAT or different networks), Yaver automatically falls back to an encrypted relay. Your data is still end-to-end encrypted even through the relay. The mobile app tries direct connection first (3s timeout), then each relay server in priority order.",
      },
      {
        q: "What happens when I switch from WiFi to cellular?",
        a: "When your phone switches networks (e.g., leaving home WiFi for 4G/5G), Yaver detects the disconnection and automatically reconnects — trying direct connection first, then relay servers. This works like WhatsApp or any modern messaging app. Your in-progress tasks continue from where they left off.",
      },
    ],
  },
  {
    category: "Reliability & Uptime",
    items: [
      {
        q: "What if there's a power outage and my PC restarts?",
        a: "Yaver is designed for always-on operation. If power goes out and comes back: (1) Configure your PC's BIOS/firmware to auto-boot on power restore, (2) Your OS starts automatically, (3) Yaver's system service starts `yaver serve` in the background, (4) The CLI reconnects to relay servers using your saved auth token. No manual intervention at any step. See our auto-boot guide in the Manuals section for step-by-step setup on macOS, Linux, and desktop PCs.",
      },
      {
        q: "Can I run Yaver on a headless server or Mac Mini?",
        a: "Absolutely. This is one of the most popular setups. Install the CLI, run `yaver auth` once (it will open a browser on the machine or you can use `yaver auth --token <token>` for headless auth), then `yaver serve`. Combined with auto-boot and auto-start, your Mac Mini or Linux server becomes a persistent AI development machine you control from your phone — even if you're on the other side of the world.",
      },
      {
        q: "Does Yaver reconnect automatically if the relay goes down?",
        a: "Yes. Yaver supports multiple relay servers for redundancy. If one relay goes down, traffic automatically routes through the remaining relays. The CLI reconnects with exponential backoff (1s, 2s, 4s, 8s, up to 30s max). You can see the active relays with `yaver status`.",
      },
    ],
  },
  {
    category: "Privacy & Security",
    items: [
      {
        q: "Is my data encrypted?",
        a: "All data flows directly between your devices over QUIC with end-to-end encryption. Task data, code, and output never pass through our servers. We only handle authentication and peer discovery.",
      },
      {
        q: "What is your privacy model?",
        a: "Yaver uses a zero-knowledge architecture. All code, prompts, and outputs flow directly between your devices over P2P connections. Our servers only handle authentication and peer discovery — we never see, store, or process your data. Even if our servers were compromised, your code and task data would not be exposed because it never passes through them.",
      },
    ],
  },
  {
    category: "Pricing & Plans",
    items: [
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
    ],
  },
  {
    category: "CLI Features",
    items: [
      {
        q: "Does Yaver auto-update the CLI?",
        a: "Yes, optionally. You can enable auto-update with `yaver config set auto-update true`. When enabled, the CLI checks for new versions on startup and updates itself in the background. If you prefer manual control (e.g., via Homebrew or Scoop), leave it disabled — the default is off. You can always update manually with `brew upgrade yaver` or `scoop update yaver`.",
      },
      {
        q: "Can I use Yaver with any AI tool, not just Claude?",
        a: "Yes. Yaver supports Claude Code, OpenAI Codex, Aider, and any custom CLI command. Switch agents anytime with `yaver set-runner <name>` or bring your own tool with `yaver set-runner custom \"my-command {prompt}\"`.",
      },
    ],
  },
];

export default function FAQPage() {
  const [openFaq, setOpenFaq] = useState<string | null>(null);

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
            Frequently Asked Questions
          </h1>
          <p className="text-sm text-surface-500">
            Everything you need to know about Yaver.
          </p>
        </div>

        <div className="space-y-10">
          {faqs.map((section) => (
            <div key={section.category}>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-surface-400">
                {section.category}
              </h2>
              <div className="space-y-1">
                {section.items.map((faq) => {
                  const key = `${section.category}-${faq.q}`;
                  const isOpen = openFaq === key;
                  return (
                    <div key={key} className="border-b border-surface-800">
                      <button
                        className="flex w-full items-center justify-between py-4 text-left text-sm font-medium text-surface-200 hover:text-surface-50"
                        onClick={() => setOpenFaq(isOpen ? null : key)}
                      >
                        {faq.q}
                        <span className="ml-4 text-surface-600">
                          {isOpen ? "\u2212" : "+"}
                        </span>
                      </button>
                      {isOpen && (
                        <p className="pb-4 text-sm leading-relaxed text-surface-500">
                          {faq.a}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-lg border border-surface-800 bg-surface-900/50 p-6 text-center">
          <p className="text-sm text-surface-400">
            Can&apos;t find what you&apos;re looking for?
          </p>
          <a
            href="mailto:support@yaver.io"
            className="mt-2 inline-block text-sm font-medium text-surface-200 underline underline-offset-2 hover:text-surface-50"
          >
            Contact support
          </a>
        </div>

        <div className="mt-8 text-center">
          <Link href="/" className="text-xs text-surface-500 hover:text-surface-50">
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
