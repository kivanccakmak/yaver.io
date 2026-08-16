import Link from "next/link";

export default function LocalLLMManual() {
  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/manuals"
          className="mb-8 inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-50"
        >
          &larr; Back to Manuals
        </Link>

        <h1 className="mb-4 text-3xl font-bold text-surface-50 md:text-4xl">
          Zero-cost local AI coding setup
        </h1>
        <p className="mb-12 text-sm leading-relaxed text-surface-400">
          Run AI coding agents entirely on your own hardware &mdash; no API
          keys, no cloud services, no recurring costs. Send coding tasks from
          your phone to your local AI, anywhere, anytime, for free.
        </p>

        {/* Overview */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            Overview
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-surface-400">
            This guide shows how to combine three free tools into a fully
            local AI coding setup:
          </p>
          <div className="rounded-lg border border-surface-800 bg-surface-900/50 p-5">
            <ul className="space-y-2 text-sm text-surface-400">
              <li className="flex gap-3">
                <span className="text-surface-500">&#8226;</span>
                <span>
                  <strong className="text-surface-300">Ollama</strong> &mdash;
                  runs open-weight LLMs locally on your machine
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-500">&#8226;</span>
                <span>
                  <strong className="text-surface-300">Yaver CLI</strong> &mdash;
                  makes your machine reachable from your phone
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-500">&#8226;</span>
                <span>
                  <strong className="text-surface-300">Tailscale</strong> &mdash;
                  secure networking for remote access (no relay server needed)
                </span>
              </li>
            </ul>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-surface-400">
            The result: send coding tasks from your phone to your local
            AI &mdash; anywhere, anytime, for free.
          </p>
        </section>

        {/* Install Ollama */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            1. Install Ollama
          </h2>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Windows
          </h3>
          <p className="mb-3 text-sm text-surface-400">
            Download the installer from{" "}
            <a href="https://ollama.com/download/windows" target="_blank" rel="noopener noreferrer" className="text-surface-300 underline underline-offset-2 hover:text-surface-100">ollama.com/download/windows</a>.
            Run the installer &mdash; it adds <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">ollama</code> to your PATH automatically.
            Ollama runs as a background service on Windows.
          </p>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Linux
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  curl -fsSL https://ollama.com/install.sh | sh
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            macOS
          </h3>
          <div className="terminal mb-6">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  brew install ollama
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Pull a coding model
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div className="text-surface-500"># Recommended for coding</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  ollama pull qwen2.5-coder:7b
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Larger, more capable</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  ollama pull qwen2.5-coder:32b
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Alternative: Code Llama</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  ollama pull codellama:13b
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Alternative: DeepSeek Coder</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  ollama pull deepseek-coder-v2:16b
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Verify it works
          </h3>
          <div className="terminal mb-4">
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
                  ollama run qwen2.5-coder:7b &quot;Write a Python function to reverse a string&quot;
                </span>
              </div>
              <div className="pl-2 text-green-400/80">
                def reverse_string(s: str) -&gt; str:
              </div>
              <div className="pl-2 text-green-400/80">
                &nbsp;&nbsp;&nbsp;&nbsp;return s[::-1]
              </div>
            </div>
          </div>
        </section>

        {/* Install an AI Coding Agent */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            2. Install an AI coding agent
          </h2>
          <p className="mb-6 text-sm text-surface-400">
            Ollama provides the model, but you need a coding agent that knows
            how to use it. Here are three options:
          </p>

          <div className="space-y-4">
            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <h3 className="mb-2 text-sm font-medium text-surface-200">
                Option A: Aider (recommended for local models)
              </h3>
              <div className="terminal mb-2">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">linux / macOS</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      pip install aider-chat
                    </span>
                  </div>
                  <div className="h-px bg-surface-800/60" />
                  <div className="text-surface-500"># Configure to use Ollama</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      export OLLAMA_API_BASE=http://localhost:11434
                    </span>
                  </div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      aider --model ollama/qwen2.5-coder:7b
                    </span>
                  </div>
                </div>
              </div>
              <div className="terminal mb-3">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">windows (powershell)</span>
                </div>
                <div className="terminal-body space-y-2 text-[13px]">
                  <div>
                    <span className="text-surface-400">&gt;</span>{" "}
                    <span className="text-surface-200 select-all">
                      pip install aider-chat
                    </span>
                  </div>
                  <div className="h-px bg-surface-800/60" />
                  <div className="text-surface-500"># Configure to use Ollama</div>
                  <div>
                    <span className="text-surface-400">&gt;</span>{" "}
                    <span className="text-surface-200 select-all">
                      $env:OLLAMA_API_BASE = &quot;http://localhost:11434&quot;
                    </span>
                  </div>
                  <div>
                    <span className="text-surface-400">&gt;</span>{" "}
                    <span className="text-surface-200 select-all">
                      aider --model ollama/qwen2.5-coder:7b
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-surface-500">
                Learn more at{" "}
                <a
                  href="https://aider.chat"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  aider.chat
                </a>
              </p>
            </div>

            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <h3 className="mb-2 text-sm font-medium text-surface-200">
                Option B: Continue (VS Code extension)
              </h3>
              <ul className="space-y-2 text-sm text-surface-400">
                <li className="flex gap-3">
                  <span className="text-surface-500">&#8226;</span>
                  <span>Install the Continue extension in VS Code</span>
                </li>
                <li className="flex gap-3">
                  <span className="text-surface-500">&#8226;</span>
                  <span>Configure Ollama as the model provider</span>
                </li>
              </ul>
              <p className="mt-3 text-xs text-surface-500">
                Learn more at{" "}
                <a
                  href="https://continue.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  continue.dev
                </a>
              </p>
            </div>

            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <h3 className="mb-2 text-sm font-medium text-surface-200">
                Option C: OpenCode
              </h3>
              <div className="terminal mb-3">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">terminal</span>
                </div>
                <div className="terminal-body text-[13px]">
                  <div className="text-surface-500"># OpenCode supports Ollama out of the box</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      go install github.com/opencode-ai/opencode@latest
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-surface-500">
                Learn more at{" "}
                <a
                  href="https://github.com/opencode-ai/opencode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  github.com/opencode-ai/opencode
                </a>
              </p>
            </div>
          </div>
        </section>

        {/* Install Yaver CLI */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            3. Install Yaver CLI
          </h2>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Windows (Scoop)
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">powershell</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">&gt;</span>{" "}
                <span className="text-surface-200 select-all">
                  scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver
                </span>
              </div>
              <div>
                <span className="text-surface-400">&gt;</span>{" "}
                <span className="text-surface-200 select-all">
                  scoop install yaver
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Linux &amp; macOS (Homebrew)
          </h3>
          <div className="terminal mb-4">
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
                  brew install kivanccakmak/yaver/yaver
                </span>
              </div>
            </div>
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-surface-200">
            Authenticate and configure
          </h3>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-3 text-[13px]">
              <div className="text-surface-500"># Sign in (opens your browser)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">yaver auth</span>
              </div>
              <div className="pl-2 text-green-400/80">Signed in as you@gmail.com</div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Configure the runner to use your local agent</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  {`yaver set-runner custom "aider --model ollama/qwen2.5-coder:7b {prompt}"`}
                </span>
              </div>
              <div className="h-px bg-surface-800/60" />
              <div className="text-surface-500"># Start the agent (no relay needed for local/Tailscale)</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">
                  yaver serve --no-relay
                </span>
              </div>
              <div className="pl-2 text-green-400/80">Agent started on :18080</div>
            </div>
          </div>
        </section>

        {/* Set Up Tailscale */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            4. Set up Tailscale (for remote access)
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            If you only use Yaver on the same WiFi, skip this step &mdash; Yaver
            discovers your machine automatically via LAN beacon. For remote
            access from anywhere, set up Tailscale:
          </p>

          <div className="mb-6 rounded-lg border border-surface-800 bg-surface-900/50 p-5">
            <ul className="space-y-2 text-sm text-surface-400">
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">1.</span>
                <span>
                  Install Tailscale on your dev machine:{" "}
                  <a
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                  >
                    tailscale.com/download
                  </a>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">2.</span>
                <span>Install Tailscale on your phone (App Store / Play Store)</span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">3.</span>
                <span>Sign in to the same Tailscale account on both devices</span>
              </li>
            </ul>
          </div>

          <div className="terminal mb-2">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">linux / macOS</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div className="text-surface-500"># Check your dev machine&apos;s Tailscale IP</div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">tailscale ip -4</span>
              </div>
              <div className="pl-2 text-surface-300">100.64.1.23</div>
            </div>
          </div>
          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">windows (powershell)</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div className="text-surface-500"># Check your dev machine&apos;s Tailscale IP</div>
              <div>
                <span className="text-surface-400">&gt;</span>{" "}
                <span className="text-surface-200 select-all">tailscale ip -4</span>
              </div>
              <div className="pl-2 text-surface-300">100.64.1.23</div>
            </div>
          </div>

          <p className="mb-4 text-sm text-surface-400">
            No relay server needed. Yaver connects directly over the Tailscale
            network.
          </p>

          <div className="rounded-lg border border-surface-800 bg-surface-900/50 p-5">
            <h3 className="mb-2 text-sm font-semibold text-surface-200">
              About DERP
            </h3>
            <p className="text-sm text-surface-400">
              If your network blocks direct WireGuard connections (very
              restrictive NAT or corporate firewalls), Tailscale automatically
              falls back to its DERP relay servers. These work over HTTPS, so
              they get through any firewall. You don&apos;t need to configure
              anything &mdash; it&apos;s automatic.
            </p>
          </div>
        </section>

        {/* Connect from Your Phone */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            5. Connect from your phone
          </h2>
          <div className="rounded-lg border border-surface-800 bg-surface-900/50 p-5">
            <ul className="space-y-2 text-sm text-surface-400">
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">1.</span>
                <span>Open the Yaver app</span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">2.</span>
                <span>Sign in with the same account</span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">3.</span>
                <span>Your dev machine appears in the device list</span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">4.</span>
                <span>If using Tailscale, the connection goes over your tailnet</span>
              </li>
              <li className="flex gap-3">
                <span className="text-surface-300 font-medium">5.</span>
                <span>Send a coding task &mdash; it runs on your local Ollama model</span>
              </li>
            </ul>
          </div>
        </section>

        {/* Cost Breakdown */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            6. Cost breakdown
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-800 text-left">
                  <th className="pb-3 pr-6 font-medium text-surface-300">Component</th>
                  <th className="pb-3 font-medium text-surface-300">Cost</th>
                </tr>
              </thead>
              <tbody className="text-surface-400">
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Ollama</td>
                  <td className="py-3">Free, open source</td>
                </tr>
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Qwen 2.5 Coder</td>
                  <td className="py-3">Free, open weight</td>
                </tr>
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Aider</td>
                  <td className="py-3">Free, open source</td>
                </tr>
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Yaver CLI</td>
                  <td className="py-3">Free, open source</td>
                </tr>
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Yaver Mobile</td>
                  <td className="py-3">Free</td>
                </tr>
                <tr className="border-b border-surface-800/60">
                  <td className="py-3 pr-6 text-surface-300">Tailscale</td>
                  <td className="py-3">Free for personal use (up to 100 devices)</td>
                </tr>
                <tr>
                  <td className="py-3 pr-6 font-semibold text-surface-100">Total</td>
                  <td className="py-3 font-semibold text-green-400/80">$0/month</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Performance Tips */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            7. Performance tips
          </h2>
          <ul className="space-y-3 text-sm text-surface-400">
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">7B models</strong> run well
                on 8GB+ RAM (CPU) or any modern GPU
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                <strong className="text-surface-300">32B models</strong> need
                32GB+ RAM or a GPU with 24GB+ VRAM
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                For best results, run on a machine with a GPU (even an older one helps)
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-surface-500">&#8226;</span>
              <span>
                Keep Ollama running in the background:{" "}
                <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">ollama serve</code>
              </span>
            </li>
          </ul>
        </section>

        {/* Alternative: Cloud Models */}
        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold text-surface-100">
            8. Alternative: cloud models with Yaver
          </h2>
          <p className="mb-4 text-sm text-surface-400">
            If you prefer cloud models, Yaver works with any AI coding agent:
          </p>

          <div className="space-y-4 mb-6">
            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <code className="text-sm font-semibold text-surface-100">Claude Code</code>
              <p className="mt-1 text-sm text-surface-400">
                Needs an Anthropic API key.{" "}
                <a
                  href="https://docs.anthropic.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  docs.anthropic.com
                </a>
              </p>
            </div>
            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <code className="text-sm font-semibold text-surface-100">Codex CLI</code>
              <p className="mt-1 text-sm text-surface-400">
                Needs an OpenAI API key.{" "}
                <a
                  href="https://platform.openai.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-surface-300 underline underline-offset-2 hover:text-surface-100"
                >
                  platform.openai.com
                </a>
              </p>
            </div>
            <div className="rounded-lg border border-surface-800 bg-surface-900/30 p-4">
              <code className="text-sm font-semibold text-surface-100">Aider with cloud models</code>
              <p className="mt-1 text-sm text-surface-400">
                Works with any OpenAI-compatible API
              </p>
            </div>
          </div>

          <div className="terminal mb-4">
            <div className="terminal-header">
              <div className="terminal-dot bg-[#ff5f57]" />
              <div className="terminal-dot bg-[#febc2e]" />
              <div className="terminal-dot bg-[#28c840]" />
              <span className="ml-3 text-xs text-surface-500">terminal</span>
            </div>
            <div className="terminal-body space-y-2 text-[13px]">
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">yaver set-runner claude</span>
                <span className="ml-2 text-surface-500"># Claude Code</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">yaver set-runner codex</span>
                <span className="ml-2 text-surface-500"># Codex CLI</span>
              </div>
              <div>
                <span className="text-surface-400">$</span>{" "}
                <span className="text-surface-200 select-all">yaver set-runner aider</span>
                <span className="ml-2 text-surface-500"># Aider (uses your configured API keys)</span>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <div className="rounded-lg border border-surface-800 bg-surface-900/50 p-6">
          <h3 className="mb-2 text-sm font-semibold text-surface-200">
            Need more?
          </h3>
          <p className="text-sm text-surface-400">
            Check the{" "}
            <Link href="/manuals/cli-setup" className="text-surface-300 underline underline-offset-2 hover:text-surface-100">
              CLI setup guide
            </Link>{" "}
            for all available commands, or the{" "}
            <Link href="/manuals/relay-setup" className="text-surface-300 underline underline-offset-2 hover:text-surface-100">
              relay setup guide
            </Link>{" "}
            if you want to self-host a relay server instead of using Tailscale.
          </p>
        </div>

        <div className="mt-12 flex items-center justify-between">
          <Link
            href="/manuals"
            className="text-xs text-surface-500 hover:text-surface-50"
          >
            &larr; All manuals
          </Link>
          <Link
            href="/manuals/auto-boot"
            className="text-xs text-surface-500 hover:text-surface-50"
          >
            Auto-boot guide &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
