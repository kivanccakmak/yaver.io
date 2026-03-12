import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-surface-800 bg-surface-950">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-4">
          <div className="md:col-span-1">
            <span className="text-lg font-bold tracking-tight text-surface-50">
              yaver<span className="font-normal text-surface-500">.io</span>
            </span>
            <p className="mt-4 text-sm leading-relaxed text-surface-500">
              Use Claude from anywhere. Peer-to-peer encrypted, real-time streaming across all your devices.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-400">Product</h3>
            <ul className="mt-4 space-y-3">
              <li><Link href="/#features" className="text-sm text-surface-500 hover:text-surface-50">Features</Link></li>
              <li><Link href="/pricing" className="text-sm text-surface-500 hover:text-surface-50">Pricing</Link></li>
              <li><Link href="/download" className="text-sm text-surface-500 hover:text-surface-50">Download</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-400">Resources</h3>
            <ul className="mt-4 space-y-3">
              <li><a href="https://docs.yaver.io" className="text-sm text-surface-500 hover:text-surface-50">Documentation</a></li>
              <li><a href="https://github.com/yaver-io" className="text-sm text-surface-500 hover:text-surface-50">GitHub</a></li>
              <li><Link href="/changelog" className="text-sm text-surface-500 hover:text-surface-50">Changelog</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-400">Legal</h3>
            <ul className="mt-4 space-y-3">
              <li><Link href="/privacy" className="text-sm text-surface-500 hover:text-surface-50">Privacy Policy</Link></li>
              <li><Link href="/terms" className="text-sm text-surface-500 hover:text-surface-50">Terms of Service</Link></li>
              <li><a href="mailto:hello@yaver.io" className="text-sm text-surface-500 hover:text-surface-50">Contact</a></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-surface-800 pt-8">
          <p className="text-center text-xs text-surface-600">
            &copy; {new Date().getFullYear()} SIMKAB ELEKTRIK. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
