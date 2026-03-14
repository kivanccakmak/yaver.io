import Link from "next/link";

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="card">
      <h3 className="mb-2 text-sm font-semibold text-surface-50">{title}</h3>
      <p className="text-sm leading-relaxed text-surface-400">{description}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="px-6 pb-24 pt-20 md:pt-32">
        <div className="mx-auto max-w-6xl">
          <div className="mb-16 text-center">
            <div className="mb-6 inline-flex items-center rounded-full border border-green-300 bg-green-50 px-4 py-1.5 text-xs font-semibold text-green-700 dark:border-green-800/60 dark:bg-green-950/50 dark:text-green-400">
              <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Early Access &mdash; Free to use
            </div>
            <h1 className="mb-6 text-4xl font-bold tracking-tight text-surface-50 sm:text-5xl md:text-6xl">
              Claude Code on your phone
            </h1>
            <p className="mx-auto max-w-2xl text-base leading-relaxed text-surface-400 md:text-lg">
              You pay $200/mo for Claude Code. It runs on your PC.
              But when you leave your desk, it just sits there.
              Yaver lets you send tasks to your dev machine from your phone &mdash; from
              anywhere, over any network. Your code never leaves your devices.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/download" className="btn-primary px-8 py-3.5 text-sm">
                Get started free
              </Link>
              <Link href="/#how-it-works" className="btn-secondary px-8 py-3.5 text-sm">
                See how it works
              </Link>
            </div>
          </div>

          {/* Use case visual */}
          <div className="mx-auto max-w-3xl">
            <div className="card p-8">
              <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-surface-600 bg-surface-800">
                    <span className="text-2xl">&#128241;</span>
                  </div>
                  <span className="text-sm font-medium text-surface-200">Your phone</span>
                  <p className="mt-1 text-xs text-surface-500">WiFi, 4G, 5G</p>
                </div>

                <div className="flex flex-col items-center gap-1.5 sm:flex-1">
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-surface-500 to-transparent" />
                  <span className="whitespace-nowrap text-[11px] font-semibold tracking-wide text-surface-300">
                    Encrypted P2P
                  </span>
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-surface-500 to-transparent" />
                </div>

                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-surface-600 bg-surface-800">
                    <span className="text-2xl">&#128187;</span>
                  </div>
                  <span className="text-sm font-medium text-surface-200">Your dev machine</span>
                  <p className="mt-1 text-xs text-surface-500">Claude Code runs here</p>
                </div>
              </div>
              <p className="mt-6 text-center text-xs text-surface-500">
                Tasks flow directly between your devices. We never see your code.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How it works — detailed setup */}
      <section id="how-it-works" className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Set up in 2 minutes
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Two things to set up: the agent on your dev machine, and the app on your phone.
          </p>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {/* Left: Dev machine setup */}
            <div>
              <div className="mb-6 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-800 text-xs font-bold text-surface-300">
                  A
                </span>
                <h3 className="text-base font-semibold text-surface-50">
                  On your dev machine
                </h3>
              </div>

              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot bg-[#ff5f57]" />
                  <div className="terminal-dot bg-[#febc2e]" />
                  <div className="terminal-dot bg-[#28c840]" />
                  <span className="ml-3 text-xs text-surface-500">terminal</span>
                </div>
                <div className="terminal-body space-y-3 text-[13px]">
                  <div className="text-surface-500"># 1. Install the agent</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200 select-all">
                      brew install kivanccakmak/yaver/yaver
                    </span>
                  </div>
                  <div className="h-px bg-surface-800/60" />
                  <div className="text-surface-500"># 2. Sign in (opens browser)</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">yaver auth</span>
                  </div>
                  <div className="text-surface-500 pl-2">Opening browser...</div>
                  <div className="text-green-400/80 pl-2">Signed in as you@gmail.com</div>
                  <div className="h-px bg-surface-800/60" />
                  <div className="text-surface-500"># 3. Start the agent</div>
                  <div>
                    <span className="text-surface-400">$</span>{" "}
                    <span className="text-surface-200">yaver serve</span>
                  </div>
                  <div className="text-surface-500 pl-2">Agent listening on :19835</div>
                  <div className="text-surface-500 pl-2">Connected to relay (eu-hel)</div>
                  <div className="text-green-400/80 pl-2">
                    Ready. Waiting for tasks...
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <p className="text-xs text-surface-500">
                  Also available via <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">curl -fsSL https://get.yaver.io | sh</code> or{" "}
                  <Link href="/download" className="text-surface-300 underline underline-offset-2 hover:text-surface-100">
                    direct download
                  </Link>{" "}
                  for macOS, Windows, and Linux.
                </p>
                <p className="text-xs text-surface-500">
                  The agent runs in the background. Your Claude Code subscription runs locally on this machine &mdash; Yaver just makes it reachable.
                </p>
              </div>
            </div>

            {/* Right: Mobile app setup */}
            <div>
              <div className="mb-6 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-800 text-xs font-bold text-surface-300">
                  B
                </span>
                <h3 className="text-base font-semibold text-surface-50">
                  On your phone
                </h3>
              </div>

              <div className="space-y-4">
                <div className="card">
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-800 text-[11px] font-bold text-surface-400">
                      1
                    </span>
                    <div>
                      <h4 className="text-sm font-medium text-surface-200">Download the app</h4>
                      <p className="mt-1 text-xs text-surface-500">
                        Get Yaver from the App Store or Google Play. It&apos;s free.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-800 text-[11px] font-bold text-surface-400">
                      2
                    </span>
                    <div>
                      <h4 className="text-sm font-medium text-surface-200">Sign in</h4>
                      <p className="mt-1 text-xs text-surface-500">
                        Use the same Apple, Google, or Microsoft account you used on your dev machine. One-tap sign in.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-800 text-[11px] font-bold text-surface-400">
                      3
                    </span>
                    <div>
                      <h4 className="text-sm font-medium text-surface-200">Start sending tasks</h4>
                      <p className="mt-1 text-xs text-surface-500">
                        Your dev machine appears automatically. Tap it, type a task, and Claude starts working. Output streams back live to your phone.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="card border-surface-700 bg-surface-850">
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 text-lg">&#9889;</span>
                    <div>
                      <h4 className="text-sm font-medium text-surface-200">Works everywhere</h4>
                      <p className="mt-1 text-xs text-surface-500">
                        Switch between WiFi and cellular seamlessly &mdash; like WhatsApp.
                        On the same network? Direct connection. Out and about? Automatic relay.
                        You don&apos;t have to think about it.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <p className="text-xs text-surface-500">
                  You can also connect from another terminal with <code className="rounded bg-surface-900 px-1.5 py-0.5 text-surface-400">yaver connect</code> for a remote CLI experience.
                </p>
              </div>
            </div>
          </div>

          {/* What you can do */}
          <div className="mt-16">
            <h3 className="mb-6 text-center text-sm font-semibold uppercase tracking-wider text-surface-500">
              What you can do from your phone
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { task: "\"Refactor the auth module to use JWT\"", context: "Large codebase change" },
                { task: "\"Fix the failing CI tests on main\"", context: "Debug & fix remotely" },
                { task: "\"Add dark mode to the settings page\"", context: "Feature development" },
                { task: "\"Review the last 3 PRs and summarize\"", context: "Code review on the go" },
              ].map((item) => (
                <div key={item.task} className="rounded-lg border border-surface-800 bg-surface-900/50 px-4 py-3">
                  <p className="text-xs font-medium text-surface-200">{item.task}</p>
                  <p className="mt-1 text-[11px] text-surface-500">{item.context}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Privacy-first architecture */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Privacy-first architecture
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Your data stays on your devices. We never see it.
          </p>

          <div className="mx-auto max-w-3xl">
            {/* P2P diagram */}
            <div className="card mb-6 p-8">
              <div className="flex items-center justify-center gap-4 sm:gap-6">
                <div className="text-center">
                  <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-lg border border-surface-600 bg-surface-800 sm:h-16 sm:w-16">
                    <span className="text-lg font-medium text-surface-200">M</span>
                  </div>
                  <span className="text-xs text-surface-400">Mobile</span>
                </div>

                <div className="flex flex-1 flex-col items-center gap-1.5">
                  <div className="h-px w-full bg-surface-600" />
                  <span className="whitespace-nowrap text-[11px] font-semibold tracking-wide text-surface-300">
                    P2P Encrypted
                  </span>
                  <div className="h-px w-full bg-surface-600" />
                </div>

                <div className="text-center">
                  <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-lg border border-surface-600 bg-surface-800 sm:h-16 sm:w-16">
                    <span className="text-lg font-medium text-surface-200">D</span>
                  </div>
                  <span className="text-xs text-surface-400">Desktop</span>
                </div>
              </div>

              <div className="mt-6 text-center">
                <span className="text-xs text-surface-400">
                  Direct peer-to-peer &mdash; no servers in the middle
                </span>
              </div>
            </div>

            {/* We store nothing */}
            <div className="card p-8">
              <h3 className="mb-4 text-base font-semibold text-surface-50">
                We store nothing
              </h3>
              <ul className="space-y-3">
                {[
                  "No code stored on our servers",
                  "No task data in the cloud",
                  "No logs or output captured",
                  "Auth-only backend \u2014 just to find your devices",
                ].map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm text-surface-400"
                  >
                    <span className="mt-0.5 text-surface-400">&#10003;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Built for developers
          </h2>
          <p className="mb-16 text-center text-sm text-surface-400">
            Privacy, speed, and simplicity.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              title="MCP standard"
              description="Built on the Model Context Protocol. Connect any MCP-compatible client to your agent — IDE plugins, CLI tools, or custom integrations."
            />
            <FeatureCard
              title="Zero-knowledge"
              description="We never see your code. All task data flows P2P between your devices."
            />
            <FeatureCard
              title="P2P encrypted"
              description="End-to-end encrypted connections between your mobile app and agent machine. Your data never touches our servers."
            />
            <FeatureCard
              title="Real-time streaming"
              description="Claude responses stream token-by-token across devices. No buffering, no delays."
            />
            <FeatureCard
              title="Multi-device"
              description="Connect from your phone, tablet, or any device. Manage multiple dev machines from one app."
            />
            <FeatureCard
              title="Agent-to-agent"
              description="Expose your dev machine as an MCP server. Other agents and tools can discover and interact with it using the open standard."
            />
          </div>
        </div>
      </section>

      {/* Pricing — Early Access */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-surface-50 md:text-3xl">
            Pricing
          </h2>
          <p className="mb-4 text-center text-sm text-surface-400">
            Free during early access. All features included.
          </p>
          <div className="mb-12 flex justify-center">
            <div className="inline-flex items-center rounded-full border border-green-300 bg-green-50 px-4 py-2 text-xs font-semibold text-green-700 dark:border-green-800/60 dark:bg-green-950/50 dark:text-green-400">
              Early Access &mdash; All plans are free for a limited time
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Free */}
            <div className="card flex flex-col">
              <div className="mb-6">
                <h3 className="mb-1 text-sm font-semibold text-surface-400">Free</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-surface-50">$0</span>
                  <span className="text-sm text-surface-400">forever</span>
                </div>
                <p className="mt-2 text-xs text-surface-400">For individual developers trying it out.</p>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {["1 device connection", "5 tasks per day", "P2P encrypted", "Community support"].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-surface-300">
                    <span className="mt-0.5 text-surface-400">&#10003;</span>{f}
                  </li>
                ))}
              </ul>
              <Link href="/auth?signup=true" className="btn-secondary w-full py-3 text-center text-sm">
                Get started
              </Link>
            </div>

            {/* Pro */}
            <div className="card relative flex flex-col border-surface-600">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-green-600 px-3 py-0.5 text-[10px] font-bold tracking-wider text-white dark:bg-green-500 dark:text-surface-950">
                FREE IN EARLY ACCESS
              </div>
              <div className="mb-6">
                <h3 className="mb-1 text-sm font-semibold text-surface-400">Pro</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-surface-50">$0</span>
                  <span className="text-sm text-surface-400 line-through">$12/mo</span>
                </div>
                <p className="mt-2 text-xs text-surface-400">For developers who use Claude daily.</p>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {["Unlimited devices", "Unlimited tasks", "P2P encrypted", "Priority support", "Task history & search", "Team sharing (coming soon)"].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-surface-300">
                    <span className="mt-0.5 text-surface-400">&#10003;</span>{f}
                  </li>
                ))}
              </ul>
              <Link href="/auth?signup=true" className="btn-primary w-full py-3 text-center text-sm">
                Get started free
              </Link>
            </div>

            {/* Enterprise */}
            <div className="card flex flex-col">
              <div className="mb-6">
                <h3 className="mb-1 text-sm font-semibold text-surface-400">Enterprise</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-surface-50">Custom</span>
                </div>
                <p className="mt-2 text-xs text-surface-400">For teams with security and compliance needs.</p>
              </div>
              <ul className="mb-8 flex-1 space-y-3">
                {["Everything in Pro", "SSO / SAML", "Audit logs", "Dedicated support", "Custom deployment", "SLA guarantee"].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-surface-300">
                    <span className="mt-0.5 text-surface-400">&#10003;</span>{f}
                  </li>
                ))}
              </ul>
              <a href="mailto:sales@yaver.io" className="btn-secondary w-full py-3 text-center text-sm">
                Contact sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-surface-50 md:text-3xl">
            Stop wasting your Claude subscription
          </h2>
          <p className="mb-8 text-sm leading-relaxed text-surface-400">
            Install the agent on your dev machine, get the app on your phone.
            <br />
            Claude keeps working while you&apos;re away from your desk.
          </p>
          <code className="mb-8 inline-block rounded-lg bg-surface-900 px-5 py-2.5 text-sm text-surface-300">
            brew install kivanccakmak/yaver/yaver
          </code>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/download" className="btn-primary px-8 py-3.5 text-sm">
              Get started free
            </Link>
            <Link href="/pricing" className="btn-secondary px-8 py-3.5 text-sm">
              View pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
