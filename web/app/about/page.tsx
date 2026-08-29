import type { Metadata } from "next";
import Link from "next/link";

const canonical = "https://yaver.io/about";

export const metadata: Metadata = {
  title: "About Yaver",
  description:
    "Yaver is an open-source, self-hostable remote AI runner and real-device app development platform created by Kıvanç Çakmak at SIMKAB.",
  alternates: { canonical },
  openGraph: {
    type: "website",
    url: canonical,
    title: "About Yaver",
    description: "The company and product behind Yaver's remote coding-agent and real-device development platform.",
  },
};

const organization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://yaver.io/#organization",
  name: "Yaver",
  url: "https://yaver.io/",
  description: "Open-source remote AI runner and real-device app development platform.",
  founder: { "@type": "Person", name: "Kıvanç Çakmak" },
  parentOrganization: { "@type": "Organization", name: "SIMKAB", url: "https://simkab.com/" },
  email: "kivanc.cakmak@simkab.com",
  sameAs: [
    "https://github.com/yaver-io/yaver.io",
    "https://www.npmjs.com/package/yaver-cli",
  ],
  knowsAbout: [
    "remote AI coding agents",
    "AI coding agent runners",
    "real-device app testing",
    "mobile app development",
    "self-hosted developer tools",
  ],
};

export default function AboutPage() {
  return (
    <div className="px-6 py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization).replace(/</g, "\\u003c") }} />
      <article className="mx-auto max-w-3xl">
        <Link href="/" className="mb-10 inline-block text-sm text-surface-500 hover:text-surface-100">&larr; Yaver</Link>
        <header className="border-b border-surface-800 pb-12">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">Company</p>
          <h1 className="mb-6 text-4xl font-bold leading-tight text-surface-50 sm:text-5xl">A remote runtime for people building with AI agents</h1>
          <p className="text-lg leading-relaxed text-surface-300">
            Yaver is an open-source, self-hostable remote AI runner and real-device app development platform created by Kıvanç Çakmak at SIMKAB in Istanbul.
          </p>
        </header>

        <section className="border-b border-surface-800 py-12">
          <h2 className="mb-4 text-2xl font-semibold text-surface-50">Why Yaver exists</h2>
          <p className="mb-4 text-sm leading-7 text-surface-400">
            Coding agents can edit repositories and run tools, but the useful development environment still lives on a particular machine. Yaver keeps the agent beside that environment while making sessions, approvals, builds, tests, and supported real-device previews reachable from phones, browsers, desktops, and other surfaces.
          </p>
          <p className="text-sm leading-7 text-surface-400">
            Developers can use their own machines and accounts, self-host the supporting infrastructure, or choose an optional managed workspace when they want a persistent remote runtime.
          </p>
        </section>

        <section className="py-12">
          <h2 className="mb-4 text-2xl font-semibold text-surface-50">Customers, ecosystem partners, and investors</h2>
          <p className="mb-7 text-sm leading-7 text-surface-400">
            For product evaluations, developer-tool integrations, distribution partnerships, or investment conversations, contact <a className="text-indigo-400 hover:text-indigo-300" href="mailto:kivanc.cakmak@simkab.com">kivanc.cakmak@simkab.com</a>.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/remote-ai-coding-agent" className="btn-primary px-6 py-3 text-sm">Product overview</Link>
            <a href="https://github.com/yaver-io/yaver.io" className="rounded-lg border border-surface-700 px-6 py-3 text-sm text-surface-200 hover:border-surface-500">Source repository</a>
          </div>
        </section>
      </article>
    </div>
  );
}
