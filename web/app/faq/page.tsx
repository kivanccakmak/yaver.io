"use client";

import Link from "next/link";
import { useState } from "react";

const faqs = [
  {
    category: "Getting Started",
    items: [
      {
        q: "What AI agents does Yaver work with?",
        a: "Anything that runs in a terminal. Claude Code, Codex CLI, OpenCode, Goose, Amp, Aider, Ollama, Qwen, Continue, or any custom command. Run local models with Ollama for zero-cost, fully private AI coding. Switch agents per task or set a default with `yaver set-runner <name>`.",
      },
      {
        q: "Do I need API keys?",
        a: "Depends on the agent. Cloud agents like Claude Code or Codex need their own API keys or subscriptions. Local models via Ollama need nothing — just download the model and go. Yaver itself has no API keys and no paid tiers.",
      },
      {
        q: "Don't some agents already have remote access?",
        a: "Yes — Claude Code has a remote control feature (code.claude.com), and OpenAI Codex runs in the cloud. Yaver is useful when you want a single interface across multiple agents, when you use local models that have no cloud option, or when you want full control over your infrastructure.",
      },
      {
        q: "Does Yaver auto-start when my PC boots?",
        a: "Yes. During installation, Yaver registers itself as a system service. On macOS it uses a LaunchAgent, on Linux a systemd user service, and on Windows a startup entry. After a reboot, `yaver serve` starts automatically. You can disable this with `yaver config set auto-start false`.",
      },
      {
        q: "Do I need to re-authenticate after a reboot?",
        a: "No. Once you run `yaver auth` the first time, your session is saved locally. It persists across reboots indefinitely.",
      },
    ],
  },
  {
    category: "Networking",
    items: [
      {
        q: "Do I need a relay server?",
        a: "Only if your phone and dev machine aren't on the same network. On the same WiFi, Yaver finds your machine automatically via LAN broadcast. For remote access you can self-host a relay (one Docker command), use Tailscale, or use Cloudflare Tunnel.",
      },
      {
        q: "Can I use Tailscale instead of a relay?",
        a: "Yes. If both devices are on your tailnet, Yaver connects directly via the Tailscale IP. No relay needed. Tailscale's DERP servers handle hard NAT cases automatically, so it works even behind restrictive firewalls.",
      },
      {
        q: "Can I use Yaver with a VPN?",
        a: "Yes. Yaver operates at the application layer — no TUN/TAP, no VPN conflicts. As long as both devices have internet access, it works alongside any VPN.",
      },
      {
        q: "What happens if my connection fails?",
        a: "Yaver tries direct connection first, then falls back to relay servers in priority order. If a relay goes down, traffic routes through remaining relays. The CLI reconnects with exponential backoff (up to 30s). Network changes (WiFi to cellular) trigger an automatic reconnect — no manual intervention.",
      },
    ],
  },
  {
    category: "Self-Hosting",
    items: [
      {
        q: "How do I self-host a relay?",
        a: "One Docker command: `RELAY_PASSWORD=secret docker compose up -d`. For production with HTTPS, use the setup script: `./scripts/setup-relay.sh <ip> <domain> --password <pass>`. See the self-hosting guide for full details.",
      },
      {
        q: "Can I run everything locally with no cloud?",
        a: "Yes. Use Ollama for local models + Tailscale for networking. Zero cloud, zero API keys, zero cost. Your code, your models, your hardware. The only cloud component is the Convex auth bridge for OAuth sign-in, and you can deploy your own instance of that too.",
      },
      {
        q: "What about Cloudflare Tunnel?",
        a: "If you're behind a corporate firewall that blocks UDP, Cloudflare Tunnel can forward traffic to your agent's HTTP port. Install cloudflared, create a tunnel pointing to localhost:18080, and use the tunnel URL in the mobile app.",
      },
    ],
  },
  {
    category: "Privacy & Security",
    items: [
      {
        q: "Is my code safe?",
        a: "Yaver connects your phone directly to your dev machine. CLI-to-relay uses QUIC (TLS encrypted), mobile-to-relay uses HTTPS. The relay is password-protected and forwards bytes without inspecting them. On Tailscale, you get full WireGuard end-to-end encryption. On LAN, the beacon uses a SHA-256 token fingerprint so only your devices can discover each other. No code, tasks, or output ever reach any server. All of this is open source — read the code yourself.",
      },
      {
        q: "What is the privacy model?",
        a: "Zero-knowledge. All code, prompts, and outputs flow P2P between your devices. The backend only handles OAuth sign-in and device discovery — it never sees your data. The website is just for registration and account management, not a control plane. Even if the auth backend were compromised, your code would be safe because it never passes through it.",
      },
      {
        q: "How does authentication work?",
        a: "You sign in via OAuth (Apple, Google, or Microsoft). Both the CLI and mobile app receive a session token from Convex. This token authenticates all API requests and device registration. The relay server has a separate shared password that prevents unauthorized agents from connecting. On LAN, the UDP beacon includes a fingerprint derived from your user ID (first 8 hex chars of SHA-256), so only devices signed in to the same account will discover each other.",
      },
      {
        q: "What encryption is used?",
        a: "It depends on the connection path. CLI-to-relay: QUIC with TLS (encrypted transport). Mobile-to-relay: HTTPS with TLS certificate. Tailscale path: WireGuard (full end-to-end encryption, no relay involved). Direct LAN: HTTP on your local network (no encryption, but traffic stays on your WiFi). The relay is a pass-through — since you self-host it, you control it.",
      },
      {
        q: "Where are my relay credentials stored?",
        a: "You choose. By default, relay server URL and password are stored locally on each device (AsyncStorage on mobile, config.json on CLI). You can optionally enable cloud sync to store them in your Convex account so they sync across devices. The web dashboard always stores to your account. If privacy is a concern, use local-only storage and configure each device separately.",
      },
    ],
  },
  {
    category: "CLI & Usage",
    items: [
      {
        q: "Does the CLI auto-update?",
        a: "Optionally. Enable with `yaver config set auto-update true`. Otherwise update manually via your package manager (`brew upgrade yaver` or `scoop update yaver`).",
      },
      {
        q: "Can I use Yaver without the mobile app?",
        a: "Yes. Run `yaver connect` from any terminal to connect to your remote dev machine. Laptop to desktop, server to server, SSH session to home machine — same connection strategy, same agent support. The mobile app is just one way to interact with your agent.",
      },
      {
        q: "What is the website for?",
        a: "The yaver.io website is only for initial registration and basic account management — signing in via OAuth, viewing your registered devices, and managing your account. It is not a control plane. All actual interaction with your AI agents happens from the CLI (`yaver serve`, `yaver connect`) and the mobile app.",
      },
      {
        q: "Can I run multiple agents per machine?",
        a: "Yes. Each `yaver serve` instance manages its own tmux sessions. You can run different AI agents side by side and switch between them from the mobile app.",
      },
      {
        q: "Can I use Yaver on a headless server?",
        a: "Yes. Install the CLI, run `yaver auth` once (or use `yaver auth --token <token>` for headless), then `yaver serve`. Combined with auto-boot, a Mac Mini or Linux server becomes a persistent AI dev machine you control from your phone.",
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
            FAQ
          </h1>
          <p className="text-sm text-surface-500">
            Common questions about Yaver.
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
            Found a bug or have a feature request?
          </p>
          <a
            href="https://github.com/kivanccakmak/yaver/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-medium text-surface-200 underline underline-offset-2 hover:text-surface-50"
          >
            Open a GitHub issue
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
