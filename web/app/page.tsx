"use client";

import Link from "next/link";
import { useState } from "react";

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

function MCPIntegrationSection() {
  const [mcpTab, setMcpTab] = useState<"stdio" | "http" | "cli">("stdio");

  return (
    <section className="border-t border-surface-800/60 px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
          MCP Integration
        </h2>
        <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
          Connect Yaver as an MCP server from Claude Desktop, Claude Web UI, or any MCP-compatible client.
        </p>

        {/* Tabs */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {(
            [
              { key: "stdio", label: "Local (stdio)" },
              { key: "http", label: "Network (HTTP)" },
              { key: "cli", label: "CLI setup" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMcpTab(tab.key)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                mcpTab === tab.key
                  ? "bg-surface-800 text-surface-100"
                  : "text-surface-500 hover:text-surface-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {mcpTab === "stdio" && (
          <div className="terminal">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">claude_desktop_config.json</span>
            </div>
            <div className="terminal-body text-[13px]">
              <pre className="text-surface-200 whitespace-pre-wrap">{`{
  "mcpServers": {
    "yaver": {
      "command": "yaver",
      "args": ["mcp"]
    }
  }
}`}</pre>
            </div>
          </div>
        )}

        {mcpTab === "http" && (
          <div>
            <p className="mb-4 text-center text-sm text-surface-400">
              For remote access from Claude Web UI or other network clients:
            </p>
            <div className="terminal">
              <div className="terminal-header">
                <div className="terminal-dot bg-[#ff5f57]" />
                <div className="terminal-dot bg-[#febc2e]" />
                <div className="terminal-dot bg-[#28c840]" />
                <span className="ml-3 text-xs text-surface-500">terminal</span>
              </div>
              <div className="terminal-body space-y-2 text-[13px]">
                <div>
                  <span className="text-surface-400">$</span>{" "}
                  <span className="text-surface-200 select-all">
                    yaver mcp --mode http --port 18090
                  </span>
                </div>
                <div className="text-green-400/80 pl-2">
                  MCP HTTP server listening on :18090
                </div>
              </div>
            </div>
          </div>
        )}

        {mcpTab === "cli" && (
          <div className="terminal">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500"># Install</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  brew install kivanccakmak/yaver/yaver
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Start MCP server (stdio for Claude Desktop)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver mcp</span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Start MCP server (HTTP for remote/web)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver mcp --mode http --port 18090</span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Configure email (optional)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">yaver email setup</span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Connect to other MCP servers (optional)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200">
                  yaver acl add ollama http://localhost:11434/mcp
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="px-6 pb-24 pt-20 md:pt-32">
        <div className="mx-auto max-w-6xl">
          <div className="mb-16 text-center">
            <div className="mb-6 inline-flex items-center gap-3">
              <span className="inline-flex items-center rounded-full border border-surface-700 bg-surface-900 px-4 py-1.5 text-xs text-surface-400">
                <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-green-500/70" />
                MIT Licensed &middot; Free Forever
              </span>
              <a
                href="https://github.com/kivanccakmak/yaver.io"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-surface-400 bg-white px-4 py-1.5 text-xs font-semibold text-surface-950 hover:bg-surface-100 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.405.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                Source Code
              </a>
            </div>
            <h1 className="mb-6 text-4xl font-bold tracking-tight text-surface-50 sm:text-5xl md:text-6xl">
              Your code never leaves
              <br />
              your machine
            </h1>
            <p className="mx-auto max-w-2xl text-base leading-relaxed text-surface-400 md:text-lg">
              Open-source P2P remote for AI coding agents &mdash;
              Claude Code, Codex, Aider, Ollama, and more.
              Encrypted peer-to-peer connections. Everything runs under YOUR control.
              No middleman, no cloud dependency, no vendor lock-in. Like OpenClaw, but for developers.
            </p>
          </div>

          {/* Getting started — inline in hero */}
          <div className="mx-auto max-w-4xl grid grid-cols-1 gap-6 md:grid-cols-2 items-stretch">
            {/* Left: Phone */}
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-1">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-800 text-[10px] font-bold text-surface-400 mr-2">1</span>
                Get the app
              </h3>
              <div className="card flex-1">
                <div className="flex items-start gap-4">
                  <svg className="mt-0.5 h-6 w-6 shrink-0 text-surface-400" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.40 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  <div>
                    <h4 className="text-sm font-medium text-surface-200">iOS</h4>
                    <p className="mt-1 text-xs text-surface-500">iPhone &amp; iPad</p>
                    <a href="https://testflight.apple.com/join/yaver" target="_blank" rel="noopener noreferrer"
                      className="mt-2 inline-block rounded-lg bg-surface-800 px-3 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-700 transition-colors">
                      App Store
                    </a>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-surface-800/60 flex items-start gap-4">
                  <svg className="mt-0.5 h-6 w-6 shrink-0 text-surface-400" fill="currentColor" viewBox="0 0 24 24"><path d="M17.523 2.238l-1.931 3.334c1.88.907 3.261 2.565 3.713 4.608H4.694c.452-2.043 1.833-3.701 3.714-4.608L6.477 2.238a.357.357 0 01.13-.487.357.357 0 01.487.13l1.962 3.389A8.97 8.97 0 0112 4.749c1.07 0 2.088.188 3.039.521l1.962-3.389a.357.357 0 01.487-.13.357.357 0 01.13.487h-.095zM9.5 7.5a.75.75 0 100-1.5.75.75 0 000 1.5zm5 0a.75.75 0 100-1.5.75.75 0 000 1.5zM4.5 11.68h15c.276 0 .5.224.5.5v7.5c0 1.401-1.119 2.5-2.5 2.5h-11C5.119 22.18 4 21.061 4 19.68v-7.5c0-.276.224-.5.5-.5z"/></svg>
                  <div>
                    <h4 className="text-sm font-medium text-surface-200">Android</h4>
                    <span className="mt-1 text-xs text-surface-500">Coming soon</span>
                  </div>
                </div>
                <p className="mt-4 pt-4 border-t border-surface-800/60 text-xs text-surface-500">
                  Sign in with Apple, Google, or Microsoft. Your dev machine shows up automatically.
                </p>
              </div>
            </div>

            {/* Right: CLI */}
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-1">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-800 text-[10px] font-bold text-surface-400 mr-2">2</span>
                Install the CLI
              </h3>
              <div className="terminal flex-1">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">terminal</span>
                </div>
                <div className="terminal-body space-y-3 text-[13px]">
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      brew install kivanccakmak/yaver/yaver
                    </span>
                  </div>
                  <div className="h-px bg-surface-800/60" />
                  <div className="text-surface-500"># same account as the app</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">yaver auth</span>
                  </div>
                  <div className="h-px bg-surface-800/60" />
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">yaver serve</span>
                  </div>
                  <div className="text-green-400/80 pl-2">
                    Ready. Waiting for tasks...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* What is Yaver? */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            What does it do?
          </h2>
          <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            Yaver turns your phone into a remote for AI coding agents on
            your dev machine. Send tasks, read output, adopt existing tmux sessions,
            manage everything &mdash; from the couch, the bus, or anywhere with a signal.
            Free and open-source. Self-host everything. No vendor lock-in.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Works with any agent</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Claude Code, Codex, OpenCode, Goose, Amp, Aider, Ollama, Qwen &mdash; anything that runs in a terminal. Bring your own models, bring your own API keys (or don&apos;t &mdash; local models need neither).
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">P2P encrypted connections</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Traffic flows directly between your phone and your machine over encrypted channels. No middleman servers storing your code. The optional relay is a dumb pipe &mdash; it can&apos;t read what passes through. Your code never leaves your devices.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Self-host everything</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Run your own relay, use Tailscale, or just be on the same WiFi. Pair with Ollama for a fully local, zero-cost, zero-cloud setup. MIT licensed &mdash; fork it, hack it, ship it. Everything runs under your control.
              </p>
            </div>
          </div>

          {/* Capabilities */}
          <div className="mt-12">
            <h3 className="mb-6 text-center text-sm font-semibold uppercase tracking-wider text-surface-500">
              Capabilities
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { name: "Session Transfer", desc: "Move AI sessions between machines" },
                { name: "Remote Exec", desc: "Run agents on any dev machine" },
                { name: "Task Scheduling", desc: "Queue and schedule agent tasks" },
                { name: "Notifications", desc: "Telegram, Discord, Slack alerts" },
                { name: "CI/CD Webhooks", desc: "GitHub Actions, GitLab CI triggers" },
                { name: "File Search", desc: "Search files across your codebase" },
                { name: "Git Operations", desc: "Status, diff, commit from mobile" },
                { name: "Screen Capture", desc: "Capture and share terminal output" },
              ].map((cap) => (
                <div key={cap.name} className="rounded-xl border border-surface-800 bg-surface-900/50 px-4 py-3">
                  <p className="text-sm font-medium text-surface-200">{cap.name}</p>
                  <p className="mt-1 text-xs text-surface-500">{cap.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Full On-Prem Free Stack */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 text-center">
            <span className="inline-flex items-center rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1 text-xs font-medium text-green-400">
              $0/month &middot; Fully on-prem &middot; No API keys
            </span>
          </div>
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Full on-prem free stack
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            Run a complete AI coding assistant on your own hardware for zero cost.
            Every component is open source (MIT / Apache 2.0). Nothing leaves your network.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                name: "Ollama",
                role: "LLM runtime",
                detail: "Downloads and runs models locally",
              },
              {
                name: "GLM-4.7-Flash",
                role: "The AI model",
                detail: "30B MoE, 59.2% SWE-bench Verified",
              },
              {
                name: "Aider",
                role: "Coding agent",
                detail: "Git-aware AI pair programming",
              },
              {
                name: "Yaver",
                role: "Mobile remote",
                detail: "Control it all from your phone",
              },
            ].map((item) => (
              <div
                key={item.name}
                className="rounded-xl border border-green-500/10 bg-green-500/5 px-4 py-4"
              >
                <p className="text-sm font-semibold text-surface-100">
                  {item.name}
                </p>
                <p className="text-xs text-green-400">{item.role}</p>
                <p className="mt-2 text-xs text-surface-400">{item.detail}</p>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-8 max-w-3xl rounded-xl border border-surface-800 bg-surface-900/50 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-surface-200">
                  Runs on a PC with 24 GB RAM
                </p>
                <p className="mt-1 text-xs text-surface-400">
                  Q4 quantization &mdash; 19 GB download, ~22 GB in memory.
                  GPU optional but faster. Works on Apple Silicon, Linux, and Windows.
                </p>
              </div>
              <Link
                href="/manuals/free-onprem"
                className="btn-primary shrink-0 px-6 py-2.5 text-sm text-center"
              >
                Setup guide &amp; SWE analysis
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* anchor for nav link */}
      <div id="how-it-works" />

      {/* Architecture */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            What&apos;s in the box
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Every piece is open source. Self-host all of it, or just the parts you need.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-surface-600 bg-surface-800">
                <span className="text-sm font-bold text-surface-300">&gt;_</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-surface-50">CLI Agent</h3>
              <p className="text-xs text-surface-500">Go</p>
              <p className="mt-2 text-sm leading-relaxed text-surface-400">
                Runs on your dev machine. Manages AI sessions in tmux. Discovers and adopts existing tmux sessions so you can control them from mobile. 1000 MCP tools. All connections outbound.
              </p>
            </div>

            <div className="card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-surface-600 bg-surface-800">
                <span className="text-sm font-bold text-surface-300">M</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Mobile App</h3>
              <p className="text-xs text-surface-500">React Native &mdash; iOS &amp; Android</p>
              <p className="mt-2 text-sm leading-relaxed text-surface-400">
                Send tasks, read output, browse and adopt tmux sessions, send input to running agents. Works on WiFi and cellular. Auto-discovers machines on your LAN.
              </p>
            </div>

            <div className="card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-surface-600 bg-surface-800">
                <span className="text-sm font-bold text-surface-300">R</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Relay Server</h3>
              <p className="text-xs text-surface-500">Go &mdash; optional, self-hostable</p>
              <p className="mt-2 text-sm leading-relaxed text-surface-400">
                QUIC relay for NAT traversal when direct connection isn&apos;t possible. Password-protected, stores nothing. Run your own with Docker or use Tailscale instead.
              </p>
            </div>

            <div className="card">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-surface-600 bg-surface-800">
                <span className="text-sm font-bold text-surface-300">A</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Auth Bridge</h3>
              <p className="text-xs text-surface-500">Convex</p>
              <p className="mt-2 text-sm leading-relaxed text-surface-400">
                Handles OAuth (Apple / Google / Microsoft) sign-in, device discovery, and account management. The web UI is only for initial registration and viewing your devices &mdash; all control happens from the CLI and mobile app. No task data, no code, no logs touch this layer.
              </p>
            </div>

            <div className="card sm:col-span-2 lg:col-span-2">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-surface-600 bg-surface-800">
                <span className="text-sm font-bold text-surface-300">~</span>
              </div>
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Or just use Tailscale / Cloudflare Tunnel</h3>
              <p className="mt-2 text-sm leading-relaxed text-surface-400">
                Already on Tailscale? Skip the relay &mdash; connect over your tailnet directly. Behind a corporate firewall? Cloudflare Tunnel works too.
                Tailscale&apos;s DERP servers handle hard NAT cases automatically. No extra infrastructure needed.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How Connections Work */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            How connections work
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Three layers, tried in order. The fastest available path wins.
          </p>

          {/* Connection waterfall */}
          <div className="mx-auto max-w-3xl space-y-4">
            {/* Layer 1 */}
            <div className="relative rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="flex items-start gap-4">
                <div className="flex flex-col items-center">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-sm font-bold text-green-400">
                    1
                  </span>
                  <div className="mt-2 h-full w-px bg-surface-800" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-surface-50">LAN Discovery</h3>
                    <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-400">
                      ~5ms
                    </span>
                    <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[11px] font-medium text-surface-400">
                      UDP broadcast
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-surface-400">
                    On the same WiFi, the CLI broadcasts a UDP beacon every 3 seconds. The mobile app
                    discovers your machine instantly &mdash; no configuration needed. Auth-aware: only
                    your devices match, even on shared networks.
                  </p>
                </div>
              </div>
            </div>

            {/* Layer 2 */}
            <div className="relative rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="flex items-start gap-4">
                <div className="flex flex-col items-center">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-sm font-bold text-blue-400">
                    2
                  </span>
                  <div className="mt-2 h-full w-px bg-surface-800" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-surface-50">Direct Connection</h3>
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-400">
                      ~5ms
                    </span>
                    <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[11px] font-medium text-surface-400">
                      HTTP
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-surface-400">
                    If the mobile app knows your machine&apos;s IP (from the device registry), it
                    tries a direct HTTP connection. Works when both devices are on the same network,
                    or when the desktop has a reachable IP.
                  </p>
                </div>
              </div>
            </div>

            {/* Layer 3 */}
            <div className="relative rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="flex items-start gap-4">
                <div className="flex flex-col items-center">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-sm font-bold text-amber-400">
                    3
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-surface-50">Relay Server</h3>
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                      ~50ms
                    </span>
                    <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[11px] font-medium text-surface-400">
                      QUIC
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-surface-400">
                    When direct connection isn&apos;t possible (different networks, NAT), traffic routes through
                    a QUIC relay. The CLI connects outbound to the relay &mdash; no port forwarding needed.
                    Mobile makes HTTP requests to the relay. The relay is a pass-through &mdash; it
                    can&apos;t read the traffic.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Network behavior */}
          <div className="mx-auto mt-12 max-w-3xl">
            <div className="terminal">
              <div className="terminal-header">
                <div className="terminal-dot bg-[#ff5f57]" />
                <div className="terminal-dot bg-[#febc2e]" />
                <div className="terminal-dot bg-[#28c840]" />
                <span className="ml-3 text-xs text-surface-500">network transitions</span>
              </div>
              <div className="terminal-body space-y-2 text-[13px]">
                <div>
                  <span className="text-surface-500">WiFi &rarr; cellular</span>
                  <span className="text-surface-400"> &nbsp;&mdash;&nbsp; </span>
                  <span className="text-surface-200">reconnects via relay, no disruption</span>
                </div>
                <div>
                  <span className="text-surface-500">cellular &rarr; WiFi</span>
                  <span className="text-surface-400"> &nbsp;&mdash;&nbsp; </span>
                  <span className="text-surface-200">discovers machine on LAN, switches to direct</span>
                </div>
                <div>
                  <span className="text-surface-500">relay goes down</span>
                  <span className="text-surface-400"> &nbsp;&mdash;&nbsp; </span>
                  <span className="text-surface-200">routes through other configured relays</span>
                </div>
                <div className="h-px bg-surface-800/60" />
                <div className="text-surface-500">
                  All transitions are silent &mdash; no UI disruption, no reconnect prompts.
                </div>
              </div>
            </div>
          </div>

          {/* Hard NAT note */}
          <div className="mx-auto mt-8 max-w-3xl">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">
                Hard NAT / corporate firewalls
              </h3>
              <p className="text-sm leading-relaxed text-surface-400">
                If even the relay&apos;s QUIC (UDP) is blocked, use
                Tailscale (which has DERP relay servers built in for hard NAT) or
                Cloudflare Tunnel (pure TCP/HTTPS, works through any firewall).
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Agents & Tools */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Works with
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Anything that runs in a terminal. Switch agents per task or set a default.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: "Claude Code",
                by: "Anthropic",
                desc: "Terminal-based AI coding agent. Yaver launches it in tmux or adopts an existing Claude Code session \u2014 start on your laptop, continue from your phone.",
                url: "https://docs.anthropic.com/en/docs/claude-code",
                oss: false,
                local: false,
              },
              {
                name: "Codex CLI",
                by: "OpenAI",
                desc: "OpenAI\u2019s terminal coding agent. Cloud-powered, needs an API key. Yaver runs it like any other CLI command.",
                url: "https://github.com/openai/codex",
                oss: true,
                local: false,
              },
              {
                name: "Ollama",
                by: "ollama.com",
                desc: "Run LLMs locally \u2014 Llama, Mistral, Qwen, CodeGemma, and more. No API keys, no cloud, fully private. Pair with Yaver for zero-cost mobile AI coding.",
                url: "https://ollama.com",
                oss: true,
                local: true,
              },
              {
                name: "Aider",
                by: "aider.chat",
                desc: "AI pair programming in the terminal. Works with many LLM backends (OpenAI, Anthropic, Ollama, etc.). Git-aware edits.",
                url: "https://aider.chat",
                oss: true,
                local: false,
              },
              {
                name: "OpenCode",
                by: "open source",
                desc: "Terminal AI coding tool with a TUI. Supports multiple LLM providers. Lightweight alternative to heavier agents.",
                url: "https://github.com/opencode-ai/opencode",
                oss: true,
                local: false,
              },
              {
                name: "Goose",
                by: "Block",
                desc: "Autonomous coding agent from Block. Runs tasks, edits files, executes shell commands. Open source.",
                url: "https://github.com/block/goose",
                oss: true,
                local: false,
              },
              {
                name: "Amp",
                by: "Sourcegraph",
                desc: "AI coding agent with deep codebase understanding. Terminal and editor modes. Powered by Sourcegraph\u2019s code graph.",
                url: "https://ampcode.com",
                oss: false,
                local: false,
              },
              {
                name: "Continue",
                by: "continue.dev",
                desc: "Open-source AI code assistant. IDE extension and CLI. Connects to any LLM \u2014 local or cloud.",
                url: "https://continue.dev",
                oss: true,
                local: false,
              },
              {
                name: "Any CLI agent",
                by: "custom command",
                desc: "Launch any command in tmux, or adopt an existing tmux session. If it runs in a terminal, Yaver can discover, adopt, and remote-control it from mobile.",
                url: null,
                oss: null,
                local: null,
              },
            ].map((agent) => (
              <div
                key={agent.name}
                className="rounded-xl border border-surface-800 bg-surface-900/50 px-4 py-4 transition-colors duration-150 hover:border-surface-700"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-surface-200">{agent.name}</p>
                  <div className="flex gap-1.5">
                    {agent.oss && (
                      <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                        OSS
                      </span>
                    )}
                    {agent.local && (
                      <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                        local
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-0.5 text-xs text-surface-500">{agent.by}</p>
                <p className="mt-2 text-xs leading-relaxed text-surface-400">{agent.desc}</p>
                {agent.url && (
                  <a
                    href={agent.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-[11px] text-surface-500 underline underline-offset-2 hover:text-surface-300"
                  >
                    {agent.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                )}
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-surface-500">
            Some agents already offer their own remote/mobile interfaces (e.g. Claude Code Remote, OpenAI Codex cloud).
            Yaver is agent-agnostic and works with any of them, including local models that have no cloud option at all.
          </p>

          {/* Networking & infrastructure tools */}
          <div className="mt-12">
            <h3 className="mb-6 text-center text-sm font-semibold uppercase tracking-wider text-surface-500">
              Networking &amp; Infrastructure
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  name: "Tailscale",
                  desc: "Mesh VPN built on WireGuard. Client is open source (BSD 3-Clause). Coordination server is proprietary \u2014 use Headscale for a fully self-hosted alternative. Free for personal use (100 devices).",
                  url: "https://tailscale.com",
                  oss: "Client: BSD",
                },
                {
                  name: "Cloudflare Tunnel",
                  desc: "Pure TCP/HTTPS tunnel through any firewall. Good fallback when UDP (QUIC) is blocked.",
                  url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
                  oss: null,
                },
                {
                  name: "Convex",
                  desc: "Backend-as-a-service used for Yaver\u2019s auth and device discovery. Not in the data path \u2014 no code or tasks pass through it.",
                  url: "https://www.convex.dev",
                  oss: null,
                },
                {
                  name: "tmux",
                  desc: "Terminal multiplexer. Yaver runs each agent in tmux and can adopt existing sessions. Start Claude Code in tmux on your laptop, walk away, and pick it up from your phone.",
                  url: "https://github.com/tmux/tmux",
                  oss: "MIT",
                },
              ].map((tool) => (
                <div
                  key={tool.name}
                  className="rounded-xl border border-surface-800 bg-surface-900/50 px-4 py-4 transition-colors duration-150 hover:border-surface-700"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-surface-200">{tool.name}</p>
                    {tool.oss && (
                      <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                        {tool.oss}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-surface-400">{tool.desc}</p>
                  <a
                    href={tool.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-[11px] text-surface-500 underline underline-offset-2 hover:text-surface-300"
                  >
                    {tool.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                </div>
              ))}
            </div>
          </div>

          <div className="mx-auto mt-8 max-w-3xl">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">
                CLI-to-CLI: connect from any terminal
              </h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Don&apos;t need the mobile app? Use <code className="rounded bg-surface-800 px-1.5 py-0.5 text-xs text-surface-300">yaver connect</code> from
                any terminal to connect to your remote dev machine &mdash; laptop to desktop, server to server, or SSH session to home machine.
                Same connection strategy (direct, relay, Tailscale), same agent support. Works anywhere the CLI runs.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Enterprise & Privacy-First Use Cases */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Enterprise &amp; Privacy-First Use Cases
          </h2>
          <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            From local-only AI coding to multi-user GPU servers and agent-to-agent orchestration.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Privacy-First AI Coding</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Run Ollama, Qwen, or any local LLM. Your code never leaves your network. Connect from Claude Web UI via MCP to use local models for sensitive codebases.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Shared GPU Servers</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Multiple developers share the same machine with isolated agents. Each user runs their own yaver serve with separate auth, tasks, and sandboxed execution.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">MCP Integration</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                1000 MCP tools &mdash; tasks, files, tmux sessions, relay/tunnel management, email, diagnostics, and agent-to-agent communication. Connect from Claude Desktop, any MCP client, or other AI agents.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Tmux Session Adoption</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Start Claude Code, Aider, or any agent in tmux on your laptop. Yaver discovers it, detects the running agent, and lets you adopt the session &mdash; control it from your phone seamlessly. Walk away from your desk without losing context.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Email Automation</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Office 365 and Gmail connectors let AI agents read, search, and send emails. Synced to a local database for fast retrieval. Perfect for automated workflows.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Agent-to-Agent (ACL)</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Agent Communication Layer connects Yaver with other MCP servers &mdash; local Ollama, remote databases, or other AI tools. Chain agents together for complex workflows.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-100">Security Sandbox</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Built-in command sandbox blocks dangerous operations: no rm -rf /, no filesystem encryption, no privilege escalation. Configurable deny-list with secure defaults.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* MCP Integration */}
      <MCPIntegrationSection />

      {/* Integrations */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Works with everything you use
          </h2>
          <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            7 AI agents, 4 chat platforms, 5 SDKs, issue trackers, alerting, and every major transport layer.
            All data flows peer-to-peer &mdash; nothing stored on our servers.
          </p>

          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {/* AI Agents */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/40 p-5">
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-surface-100">AI Agents</h3>
              </div>
              <ul className="space-y-2 text-sm text-surface-400">
                <li>Claude Code</li>
                <li>OpenAI Codex</li>
                <li>Aider</li>
                <li>Goose</li>
                <li>Ollama</li>
                <li>Amp</li>
                <li>OpenCode</li>
                <li className="text-surface-600">+ any custom CLI</li>
              </ul>
            </div>

            {/* Chat & Notifications */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/40 p-5">
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-surface-100">Chat & Notifications</h3>
              </div>
              <ul className="space-y-2 text-sm text-surface-400">
                <li>Telegram <span className="text-emerald-400/70 text-xs">(2-way)</span></li>
                <li>Discord</li>
                <li>Slack</li>
                <li>Teams</li>
              </ul>
            </div>

            {/* SDKs */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/40 p-5">
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-surface-100">SDKs</h3>
              </div>
              <ul className="space-y-2 text-sm text-surface-400">
                <li>Go</li>
                <li>Python</li>
                <li>JavaScript / TypeScript</li>
                <li>Flutter / Dart</li>
                <li>C / C++</li>
              </ul>
            </div>

            {/* Connectivity */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/40 p-5">
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 text-green-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-surface-100">Connectivity</h3>
              </div>
              <ul className="space-y-2 text-sm text-surface-400">
                <li>Direct LAN <span className="text-surface-600 text-xs">(~5ms)</span></li>
                <li>QUIC Relay <span className="text-surface-600 text-xs">(self-host)</span></li>
                <li>Cloudflare Tunnel</li>
                <li>Tailscale</li>
              </ul>
            </div>

            {/* Developer Integrations */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/40 p-5">
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-surface-100">Dev Tools</h3>
              </div>
              <ul className="space-y-2 text-sm text-surface-400">
                <li>Linear</li>
                <li>Jira</li>
                <li>PagerDuty</li>
                <li>Opsgenie</li>
                <li>Email</li>
              </ul>
            </div>
          </div>

          <div className="mt-10 text-center">
            <Link
              href="/integrations"
              className="inline-flex items-center gap-1.5 text-sm text-surface-400 transition-colors hover:text-[#6366f1]"
            >
              View all integrations
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* Self-Hosting */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Relay options
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-sm text-surface-400">
            Use our managed relay for zero setup, self-host on any VPS, or skip the relay
            entirely with Tailscale. The relay is a pass-through proxy &mdash; it stores nothing.
          </p>

          {/* Managed relay callout */}
          <div className="mb-8 rounded-xl border border-[#6366f1]/30 bg-[#6366f1]/5 p-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <div className="flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-full bg-[#6366f1]/20 px-2 py-0.5 text-[10px] font-medium text-[#818cf8]">
                    easiest
                  </span>
                  <h3 className="text-sm font-semibold text-surface-100">Managed Relay</h3>
                </div>
                <p className="text-sm text-surface-400">
                  No VPS, no Docker, no DNS records. Sign up and your agent connects
                  automatically. Multi-region, auto-failover, always up to date.
                </p>
              </div>
              <Link
                href="/pricing"
                className="btn-primary shrink-0 px-5 py-2 text-sm"
              >
                $10/mo &rarr;
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Option 1: Automated */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-400">
                  recommended
                </span>
                <h3 className="text-sm font-semibold text-surface-100">One-command setup</h3>
              </div>
              <p className="mb-4 text-xs text-surface-400">
                Installs Docker, nginx, Let&apos;s Encrypt SSL, firewall, and deploys the relay container.
                Needs a VPS with SSH access and a DNS A record.
              </p>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">your laptop</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      ./scripts/setup-relay.sh 1.2.3.4 relay.example.com --password secret
                    </span>
                  </div>
                  <div className="pl-2 text-green-400/80">
                    Relay running at https://relay.example.com
                  </div>
                </div>
              </div>
            </div>

            {/* Option 2: Docker manual */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <h3 className="mb-3 text-sm font-semibold text-surface-100">Docker (manual)</h3>
              <p className="mb-4 text-xs text-surface-400">
                Clone only the relay directory, set a password, start with Docker Compose.
                Add nginx + Let&apos;s Encrypt for HTTPS.
              </p>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">on your VPS</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div className="text-surface-500"># sparse clone + start</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      RELAY_PASSWORD=secret docker compose up -d
                    </span>
                  </div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">curl localhost:8443/health</span>
                  </div>
                  <div className="pl-2 text-green-400/80">
                    {`{"status":"ok"}`}
                  </div>
                </div>
              </div>
            </div>

            {/* Option 3: Native binary */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <h3 className="mb-3 text-sm font-semibold text-surface-100">Native binary (no Docker)</h3>
              <p className="mb-4 text-xs text-surface-400">
                Cross-compile the Go binary, copy to server, run directly or as a systemd service.
                No container runtime needed.
              </p>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">build &amp; deploy</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      cd relay &amp;&amp; GOOS=linux go build -o yaver-relay .
                    </span>
                  </div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      scp yaver-relay root@vps:/usr/local/bin/
                    </span>
                  </div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">
                      ssh root@vps &apos;RELAY_PASSWORD=secret yaver-relay serve&apos;
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Option 4: Tailscale */}
            <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-5">
              <h3 className="mb-3 text-sm font-semibold text-surface-100">No relay (Tailscale)</h3>
              <p className="mb-4 text-xs text-surface-400">
                Skip the relay entirely. Install Tailscale on both devices, connect
                over your tailnet. WireGuard end-to-end encryption, ~5ms latency.
              </p>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">terminal</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      yaver serve --no-relay
                    </span>
                  </div>
                  <div className="pl-2 text-green-400/80">
                    Listening on tailnet...
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-surface-800 bg-surface-900/50 p-4">
            <p className="text-center text-sm text-surface-400">
              <strong className="text-surface-200">VPS requirements:</strong>{" "}
              1 vCPU, 512 MB RAM, any Linux. Hetzner, DigitalOcean, Linode, AWS &mdash; any VPS works.
            </p>
          </div>

          <div className="mt-6 text-center">
            <Link
              href="/docs/self-hosting"
              className="text-sm text-surface-300 underline underline-offset-2 hover:text-surface-100"
            >
              Full self-hosting guide &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* SDK */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Embed Yaver in your app
          </h2>
          <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            SDKs for Go, Python, JavaScript/TypeScript, Flutter/Dart, and C/C++. Connect to Yaver agents, create tasks, stream output, and use speech-to-text from your own code.
          </p>

          <div className="space-y-4">
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-surface-100">Go</span>
                <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-surface-400">Native</span>
              </div>
              <pre className="rounded-lg bg-surface-950 p-3 text-xs text-surface-300 overflow-x-auto"><code>{`import "github.com/kivanccakmak/yaver.io/sdk/go/yaver"

c := yaver.NewClient(url, token)
task, _ := c.CreateTask("Fix bug", nil)
for chunk := range c.StreamOutput(task.ID, 0) {
    fmt.Print(chunk)
}`}</code></pre>
            </div>
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-surface-100">Python</span>
                <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-surface-400">pip install</span>
              </div>
              <pre className="rounded-lg bg-surface-950 p-3 text-xs text-surface-300 overflow-x-auto"><code>{`from yaver import YaverClient

client = YaverClient(url, token)
task = client.create_task("Fix bug")
for chunk in client.stream_output(task["id"]):
    print(chunk, end="")`}</code></pre>
            </div>
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-surface-100">JavaScript / TypeScript</span>
                <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-surface-400">npm</span>
              </div>
              <pre className="rounded-lg bg-surface-950 p-3 text-xs text-surface-300 overflow-x-auto"><code>{`import { YaverClient } from 'yaver-sdk';

const c = new YaverClient(url, token);
const task = await c.createTask('Fix bug');
for await (const chunk of c.streamOutput(task.id)) {
  process.stdout.write(chunk);
}`}</code></pre>
            </div>
          </div>

          <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold text-surface-100">Flutter / Dart</span>
                <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] text-surface-400">pub.dev</span>
              </div>
              <pre className="rounded-lg bg-surface-950 p-3 text-xs text-surface-300 overflow-x-auto"><code>{`import 'package:yaver/yaver.dart';

final c = YaverClient(url, token);
final task = await c.createTask('Fix bug');
await for (final chunk in c.streamOutput(task.id)) {
  stdout.write(chunk);
}`}</code></pre>
            </div>

          <div className="mt-8 rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
            <h3 className="mb-3 text-sm font-semibold text-surface-100">Install from package managers</h3>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-surface-400">npm</span>
                <code className="flex-1 rounded bg-surface-950 px-3 py-1.5 text-xs text-surface-300 select-all">npm install yaver-sdk</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-surface-400">pip</span>
                <code className="flex-1 rounded bg-surface-950 px-3 py-1.5 text-xs text-surface-300 select-all">pip install yaver</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-surface-400">Go</span>
                <code className="flex-1 rounded bg-surface-950 px-3 py-1.5 text-xs text-surface-300 select-all">go get github.com/kivanccakmak/yaver.io/sdk/go/yaver</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs font-medium text-surface-400">Flutter</span>
                <code className="flex-1 rounded bg-surface-950 px-3 py-1.5 text-xs text-surface-300 select-all">flutter pub add yaver</code>
              </div>
            </div>
            <p className="mt-3 text-xs text-surface-500">
              Also available as a C shared library (.so/.dylib/.dll) for C/C++ and any language with FFI.
              {" "}<a href="https://github.com/kivanccakmak/yaver.io/tree/main/sdk" target="_blank" rel="noopener noreferrer" className="text-surface-400 underline hover:text-surface-200">SDK docs</a>
              {" · "}<a href="https://www.npmjs.com/package/yaver-sdk" target="_blank" rel="noopener noreferrer" className="text-surface-400 underline hover:text-surface-200">npm</a>
              {" · "}<a href="https://pypi.org/project/yaver/" target="_blank" rel="noopener noreferrer" className="text-surface-400 underline hover:text-surface-200">PyPI</a>
              {" · "}<a href="https://pub.dev/packages/yaver" target="_blank" rel="noopener noreferrer" className="text-surface-400 underline hover:text-surface-200">pub.dev</a>
            </p>
          </div>
        </div>
      </section>

      {/* Voice Input */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Voice Input &amp; Text-to-Speech
          </h2>
          <p className="mx-auto mb-16 max-w-2xl text-center text-sm leading-relaxed text-surface-400">
            Speak your tasks from mobile or CLI. Choose a free on-device model or bring your own cloud API key.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                name: "On-Device",
                tag: "Free",
                desc: "Whisper tiny model runs locally on your phone or machine. No internet, no API key, no cost.",
              },
              {
                name: "OpenAI",
                tag: "$0.003/min",
                desc: "GPT-4o Mini Transcribe. Excellent accuracy, lowest error rate for technical speech.",
              },
              {
                name: "Deepgram",
                tag: "$0.004/min",
                desc: "Nova-2 with real-time WebSocket streaming. Top-tier accuracy for English.",
              },
              {
                name: "AssemblyAI",
                tag: "$0.002/min",
                desc: "Universal-2. Cheapest cloud option for async transcription.",
              },
            ].map((p) => (
              <div key={p.name} className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-surface-100">{p.name}</span>
                  <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs text-surface-400">{p.tag}</span>
                </div>
                <p className="text-xs leading-relaxed text-surface-500">{p.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <h3 className="mb-1 text-sm font-semibold text-surface-100">Text-to-Speech</h3>
              <p className="text-xs leading-relaxed text-surface-500">Have AI responses read aloud using your device&apos;s built-in TTS. Great for hands-free workflows.</p>
            </div>
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <h3 className="mb-1 text-sm font-semibold text-surface-100">Verbosity Control</h3>
              <p className="text-xs leading-relaxed text-surface-500">Set response detail from 0 (just &quot;done&quot;) to 10 (full diffs + reasoning). The AI adapts its output accordingly.</p>
            </div>
            <div className="rounded-xl border border-surface-800/60 bg-surface-900/50 p-5">
              <h3 className="mb-1 text-sm font-semibold text-surface-100">CLI Voice</h3>
              <p className="text-xs leading-relaxed text-surface-500">Type <code className="rounded bg-surface-800 px-1">/voice</code> in <code className="rounded bg-surface-800 px-1">yaver connect</code> to record and submit tasks by voice from any terminal.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Your code never leaves your machine
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            No telemetry, no analytics, no data collection. P2P encrypted connections mean your code stays on your devices. Here&apos;s how it actually works.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              {
                title: "Peer-to-peer",
                desc: "Tasks, output, and code flow directly between your phone and your machine. There is no server in the middle that could store or inspect your data.",
              },
              {
                title: "Transport encryption",
                desc: "CLI-to-relay connections use QUIC with TLS. Mobile-to-relay connections use HTTPS (TLS). Direct LAN connections use HTTP on your local network. Tailscale path uses WireGuard for full end-to-end encryption.",
              },
              {
                title: "OAuth + token auth",
                desc: "Authentication uses OAuth (Apple / Google / Microsoft) via Convex. Both CLI and mobile receive a session token that authenticates all requests. The relay validates a shared password before accepting any connection.",
              },
              {
                title: "Relay is a dumb pipe",
                desc: "If you use a relay, it forwards bytes between endpoints. It\u2019s password-protected so only authorized agents can register. You self-host it, so you control who has access. The relay code is open source \u2014 read it yourself.",
              },
              {
                title: "Auth-only backend",
                desc: "The Convex backend handles OAuth sign-in and device discovery. It never sees your code, your tasks, or your AI output. Device registration includes only hostname, platform, and IP \u2014 no task data.",
              },
              {
                title: "LAN beacon auth",
                desc: "On local networks, the CLI broadcasts a UDP beacon with a token fingerprint (SHA-256 hash of your user ID). Only devices signed in to the same account will match. Other users on the same WiFi can\u2019t discover or connect to your machine.",
              },
              {
                title: "Go fully local",
                desc: "Ollama + Tailscale = no cloud, no API keys, no relay, no third-party servers at all. WireGuard encryption end-to-end. Everything runs on hardware you own.",
              },
              {
                title: "Read the source",
                desc: "Every component is MIT-licensed. Don\u2019t trust, verify. Or fork it and run your own instance of everything.",
              },
            ].map((item) => (
              <div key={item.title} className="card">
                <h3 className="mb-2 text-sm font-semibold text-surface-50">{item.title}</h3>
                <p className="text-sm leading-relaxed text-surface-400">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-12 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            FAQ
          </h2>

          <div>
            <FAQItem
              question="What agents work with Yaver?"
              answer="Anything that runs in a terminal. Claude Code, Codex CLI, OpenCode, Goose, Amp, Aider, Ollama, Qwen, Continue, or whatever custom command you want. Run local models with Ollama for zero-cost, fully private AI coding. Switch agents per task or set a default."
            />
            <FAQItem
              question="Don't some agents already have remote access?"
              answer="Yes — Claude Code has a remote control feature, and OpenAI Codex runs in the cloud. Yaver is useful when you want a single interface across multiple agents, when you use local models that have no cloud option, or when you want full control over your infrastructure. It's agent-agnostic by design."
            />
            <FAQItem
              question="Do I need API keys?"
              answer="Depends on the agent. Cloud agents like Claude Code or Codex need their own API keys or subscriptions. Local models via Ollama need nothing — just download the model and go. Yaver itself has no API keys and no paid tiers."
            />
            <FAQItem
              question="Do I need a relay server?"
              answer="It depends on your network setup. On the same WiFi, Yaver discovers your machine automatically via UDP LAN broadcast — no relay needed, connections are direct at ~5ms latency. When your phone is on cellular or a different network, you need a way to reach your machine: either a relay server (self-host with one Docker command), Tailscale (connect over your tailnet, DERP handles hard NAT), or Cloudflare Tunnel (pure TCP/HTTPS). The relay is a pass-through — it forwards encrypted bytes and cannot read your traffic. Relay credentials are stored locally on each device by default; you can optionally enable cloud sync in the mobile app to share them across devices."
            />
            <FAQItem
              question="Is my code safe?"
              answer="Yaver connects your phone directly to your dev machine. CLI-to-relay uses QUIC (TLS encrypted), mobile-to-relay uses HTTPS. The relay is password-protected and can't inspect traffic — it just forwards bytes. On Tailscale, you get full WireGuard end-to-end encryption. On LAN, the beacon uses a SHA-256 token fingerprint so only your devices can discover each other. No code, tasks, or output ever reach any server. All of this is open source — read the code yourself."
            />
            <FAQItem
              question="Can I use Tailscale instead of a relay?"
              answer="Yes. If both devices are on your tailnet, Yaver connects directly via the Tailscale IP. No relay needed. Tailscale's DERP servers handle hard NAT cases automatically."
            />
            <FAQItem
              question="What if I'm behind a strict corporate firewall?"
              answer="Yaver's relay uses QUIC, which runs over UDP. Some corporate firewalls block all UDP traffic, which would prevent the relay from working. In that case, you have two options: Tailscale (its DERP relay servers use HTTPS to punch through even the strictest firewalls, and it works with the Tailscale mobile app too), or Cloudflare Tunnel (pure TCP/HTTPS, works through any firewall that allows web browsing). Both options give you a direct connection to your machine without needing Yaver's relay at all."
            />
            <FAQItem
              question="Can I use Yaver without the mobile app?"
              answer="Yes. Run `yaver connect` from any terminal to connect to your remote dev machine. Laptop to desktop, server to server, SSH session to home machine — same connection strategy, same agent support. The mobile app is just one way to interact with your agent."
            />
            <FAQItem
              question="Is it actually free?"
              answer="Yes. MIT license, no paid tiers, no usage limits, no telemetry, no catch. If you find it useful, star the repo or contribute a patch."
            />
            <FAQItem
              question="How does voice input work?"
              answer="Yaver supports speech-to-text on both mobile and CLI. You can use the free on-device option (Whisper, runs entirely on your phone/machine) or bring your own API key for OpenAI, Deepgram, or AssemblyAI. On mobile, tap the mic button in the task modal. On CLI, type /voice in yaver connect. All transcription happens on your device or goes directly to the provider you choose — nothing passes through Yaver servers."
            />
            <FAQItem
              question="Can I hear responses read aloud?"
              answer="Yes — enable Text-to-Speech in Settings > Voice. It uses your device's built-in TTS engine (Apple TTS on iOS/macOS, espeak on Linux). You can also control response verbosity from 0 (just 'done') to 10 (full diffs and reasoning) so the AI adapts how much detail it gives."
            />
            <FAQItem
              question="Can I embed Yaver in my own app?"
              answer="Yes — Yaver provides SDKs for Go, Python, and JavaScript/TypeScript. Import the package, point it at a running Yaver agent, and create tasks, stream output, or use speech-to-text from your code. A C shared library (.so/.dylib/.dll) is also available for C/C++ and any language with FFI support (Ruby, Rust, etc)."
            />
            <FAQItem
              question="How do I contribute?"
              answer="Fork the repo, hack on it, open a PR. Check the README for dev setup. Bug reports and feature ideas are welcome as GitHub issues."
            />
          </div>
        </div>
      </section>

      {/* Open Source */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Free and open-source. Self-host everything. No vendor lock-in.
          </h2>
          <p className="mb-12 text-center text-sm text-surface-400">
            MIT licensed. Fork it, run your own instance, contribute back. Every component is open source &mdash; you own your entire stack.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Build freely</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Add new AI runner integrations, fix bugs, improve the mobile app, write docs.
                Every component is open for contributions. Run your own Convex backend with one command.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Protected releases</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Releases, deploys, and production infrastructure are maintainer-only.
                CI checks run on every PR. Nobody can push to TestFlight, Vercel, or Convex prod without approval.
              </p>
            </div>
            <div className="card">
              <h3 className="mb-2 text-sm font-semibold text-surface-50">Self-hostable</h3>
              <p className="text-sm leading-relaxed text-surface-400">
                Run your own Convex backend (cloud free tier or self-hosted Docker), your own relay server, your own LLMs.
                Zero dependency on our infrastructure if you want.
              </p>
            </div>
          </div>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/docs/contributing" className="btn-primary px-6 py-3 text-sm">
              Contributing Guide
            </Link>
            <Link href="/docs/developers" className="btn-secondary px-6 py-3 text-sm">
              Developer Docs
            </Link>
          </div>
        </div>
      </section>

      {/* Related Work */}
      <section className="border-t border-surface-800/60 px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-2 text-xl font-bold text-surface-50 md:text-2xl">Related Work</h2>
          <p className="mb-3 text-sm text-surface-400">
            Projects and tools in the same problem space. Yaver is compatible with most of these and can be used alongside them.
          </p>
          <p className="mb-10 text-xs text-surface-500">
            <span className="inline-flex items-center gap-1"><span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span> = open-source software</span>
          </p>

          <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-3">
            {/* AI Coding Agents */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">AI Coding Agents</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Claude Code</a>
                  <span className="text-surface-500"> — Anthropic&apos;s agentic coding tool</span>
                </li>
                <li>
                  <a href="https://github.com/openai/codex" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">OpenAI Codex CLI</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — OpenAI&apos;s terminal coding agent</span>
                </li>
                <li>
                  <a href="https://aider.chat" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Aider</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — AI pair programming in your terminal</span>
                </li>
                <li>
                  <a href="https://github.com/block/goose" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Goose</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — autonomous coding agent by Block</span>
                </li>
                <li>
                  <a href="https://github.com/nichochar/amp" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Amp</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — terminal-native AI coding agent</span>
                </li>
                <li>
                  <a href="https://github.com/opencode-ai/opencode" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">OpenCode</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — AI coding in the terminal</span>
                </li>
                <li>
                  <a href="https://continue.dev" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Continue</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — AI code assistant for IDEs</span>
                </li>
              </ul>
            </div>

            {/* Local LLMs & Inference */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Local LLMs &amp; Inference</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Ollama</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — run LLMs locally with one command</span>
                </li>
                <li>
                  <a href="https://github.com/QwenLM/Qwen" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Qwen</a>
                  <span className="text-surface-500"> — open-weight LLMs by Alibaba Cloud</span>
                </li>
                <li>
                  <a href="https://github.com/THUDM/GLM-4" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">GLM-4</a>
                  <span className="text-surface-500"> — open-weight multilingual LLM</span>
                </li>
                <li>
                  <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">llama.cpp</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — LLM inference in C/C++</span>
                </li>
                <li>
                  <a href="https://github.com/vllm-project/vllm" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">vLLM</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — high-throughput LLM serving engine</span>
                </li>
              </ul>
            </div>

            {/* Remote Development */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Remote Development</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://github.com/coder/code-server" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">code-server</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — VS Code in the browser</span>
                </li>
                <li>
                  <a href="https://github.com/coder/coder" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Coder</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — self-hosted remote dev environments</span>
                </li>
                <li>
                  <a href="https://github.com/tmate-io/tmate" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">tmate</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — instant terminal sharing</span>
                </li>
                <li>
                  <a href="https://github.com/nichochar/sshx" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">sshx</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — collaborative terminal sharing over the web</span>
                </li>
                <li>
                  <a href="https://github.com/nicm/ttyd" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">ttyd</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — share your terminal over the web</span>
                </li>
              </ul>
            </div>

            {/* Networking & NAT Traversal */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Networking &amp; NAT Traversal</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://tailscale.com" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Tailscale</a>
                  <span className="text-surface-500"> — mesh VPN built on WireGuard (client is open-source)</span>
                </li>
                <li>
                  <a href="https://github.com/netbirdio/netbird" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">NetBird</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — network connectivity platform</span>
                </li>
                <li>
                  <a href="https://github.com/fatedier/frp" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">frp</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — fast reverse proxy for NAT traversal</span>
                </li>
                <li>
                  <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Cloudflare Tunnel</a>
                  <span className="text-surface-500"> — expose local services securely</span>
                </li>
                <li>
                  <a href="https://github.com/juanfont/headscale" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Headscale</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — self-hosted Tailscale control server</span>
                </li>
              </ul>
            </div>

            {/* Infrastructure */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Infrastructure</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://www.convex.dev" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Convex</a>
                  <span className="text-surface-500"> — reactive backend-as-a-service (runtime is open-source)</span>
                </li>
                <li>
                  <a href="https://github.com/quic-go/quic-go" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">quic-go</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — QUIC protocol implementation in Go</span>
                </li>
                <li>
                  <a href="https://github.com/tmux/tmux" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">tmux</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — terminal multiplexer</span>
                </li>
              </ul>
            </div>

            {/* Speech & Voice */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Speech &amp; Voice</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://github.com/ggerganov/whisper.cpp" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">whisper.cpp</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — port of Whisper in C/C++ (Yaver&apos;s on-device STT engine)</span>
                </li>
                <li>
                  <a href="https://github.com/mybigday/whisper.rn" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">whisper.rn</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — React Native bindings for whisper.cpp (Yaver mobile)</span>
                </li>
                <li>
                  <a href="https://platform.openai.com/docs/guides/speech-to-text" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">OpenAI Audio API</a>
                  <span className="text-surface-500"> — GPT-4o transcription ($0.003/min)</span>
                </li>
                <li>
                  <a href="https://deepgram.com" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">Deepgram</a>
                  <span className="text-surface-500"> — Nova-2 real-time STT ($0.004/min)</span>
                </li>
                <li>
                  <a href="https://www.assemblyai.com" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">AssemblyAI</a>
                  <span className="text-surface-500"> — Universal-2 STT ($0.002/min)</span>
                </li>
                <li>
                  <a href="https://docs.expo.dev/versions/latest/sdk/speech/" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">expo-speech</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — device TTS for React Native (Yaver&apos;s TTS engine)</span>
                </li>
              </ul>
            </div>

            {/* Protocols & Standards */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">Protocols &amp; Standards</p>
              <ul className="space-y-2.5 text-sm">
                <li>
                  <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">MCP</a>
                  <span className="ml-1.5 rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-surface-400">Open Spec</span>
                  <span className="text-surface-500"> — Model Context Protocol</span>
                </li>
                <li>
                  <a href="https://www.rfc-editor.org/rfc/rfc9000.html" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">QUIC (RFC 9000)</a>
                  <span className="ml-1.5 rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-surface-400">Open Standard</span>
                  <span className="text-surface-500"> — UDP-based transport protocol</span>
                </li>
                <li>
                  <a href="https://www.wireguard.com" target="_blank" rel="noopener noreferrer" className="font-medium text-surface-300 hover:text-surface-50">WireGuard</a>
                  <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">OSS</span>
                  <span className="text-surface-500"> — modern VPN protocol</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
