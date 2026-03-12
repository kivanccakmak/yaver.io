import Link from "next/link";

function TerminalMockup() {
  return (
    <div className="terminal mx-auto max-w-2xl">
      <div className="terminal-header">
        <div className="terminal-dot bg-[#ff5f57]" />
        <div className="terminal-dot bg-[#febc2e]" />
        <div className="terminal-dot bg-[#28c840]" />
        <span className="ml-3 text-xs text-surface-500">terminal</span>
      </div>
      <div className="terminal-body space-y-2 text-[13px]">
        <div>
          <span className="text-surface-400">$</span>{" "}
          <span className="text-surface-200">yaver connect</span>
        </div>
        <div className="text-surface-500">Discovering peers...</div>
        <div className="text-surface-300">
          Connected to MacBook Pro via QUIC (P2P encrypted)
        </div>
        <div className="mt-3">
          <span className="text-surface-400">$</span>{" "}
          <span className="text-surface-200">
            claude &quot;refactor the auth module to use JWT&quot;
          </span>
        </div>
        <div className="text-surface-500">Streaming from MacBook Pro...</div>
        <div className="text-surface-300">
          I&apos;ll refactor the auth module. Let me start by reading the current
          implementation...
          <span className="ml-0.5 inline-block h-4 w-[2px] animate-blink bg-surface-300" />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="card">
      <h3 className="mb-2 text-sm font-semibold text-white">{title}</h3>
      <p className="text-sm leading-relaxed text-surface-500">{description}</p>
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
            <div className="mb-6 inline-flex items-center rounded-full border border-surface-800 bg-surface-900 px-4 py-1.5 text-xs text-surface-400">
              <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Now in early access
            </div>
            <h1 className="mb-6 text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl">
              Use Claude from anywhere
            </h1>
            <p className="mx-auto max-w-xl text-base leading-relaxed text-surface-400 md:text-lg">
              Connect your mobile device directly to your dev machine over P2P.
              Run Claude SDK tasks remotely with real-time streaming.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/download" className="btn-primary px-8 py-3.5 text-sm">
                Get started
              </Link>
              <Link href="/#features" className="btn-secondary px-8 py-3.5 text-sm">
                Learn more
              </Link>
            </div>
          </div>

          <TerminalMockup />
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-white md:text-3xl">
            How it works
          </h2>
          <p className="mb-16 text-center text-sm text-surface-500">
            Up and running in under a minute.
          </p>
          <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
            {[
              {
                step: "01",
                title: "Install the agent",
                desc: "Download Yaver for macOS, Windows, or Linux. The installer sets up a lightweight CLI agent on your dev machine.",
              },
              {
                step: "02",
                title: "Sign in",
                desc: "Authenticate with Google or Microsoft. Your devices discover each other automatically via encrypted peer discovery.",
              },
              {
                step: "03",
                title: "Send tasks from your phone",
                desc: "Open the mobile app, type a task, and Claude runs it directly on your machine. Output streams back in real-time.",
              },
            ].map((item) => (
              <div key={item.step} className="text-center">
                <div className="mb-4 text-xs font-semibold tracking-widest text-surface-600">
                  {item.step}
                </div>
                <h3 className="mb-2 text-base font-semibold text-white">{item.title}</h3>
                <p className="text-sm leading-relaxed text-surface-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-white md:text-3xl">
            Built for developers
          </h2>
          <p className="mb-16 text-center text-sm text-surface-500">
            Security, speed, and simplicity.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              title="P2P encrypted"
              description="End-to-end encrypted connections between your devices using QUIC protocol. Your data never touches our servers."
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
              title="QUIC transport"
              description="Built on QUIC for ultra-low latency. Handles network transitions seamlessly between Wi-Fi and cellular."
            />
            <FeatureCard
              title="tmux integration"
              description="Each task runs in its own tmux session. Attach from your terminal to inspect or continue any task."
            />
            <FeatureCard
              title="Zero config"
              description="Install, sign in, done. No port forwarding, no SSH keys, no VPN. Devices find each other automatically."
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-surface-800/60 px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-white md:text-3xl">
            Ready to get started?
          </h2>
          <p className="mb-8 text-sm text-surface-500">
            Download Yaver and connect your devices in under a minute.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/download" className="btn-primary px-8 py-3.5 text-sm">
              Download for free
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
