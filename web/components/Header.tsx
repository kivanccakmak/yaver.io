"use client";

import Link from "next/link";
import { useState } from "react";

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-surface-800/60 bg-surface-950/80 backdrop-blur-xl">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="text-xl font-bold tracking-tight text-white">
            yaver<span className="font-normal text-surface-500">.io</span>
          </span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <Link href="/#features" className="text-sm text-surface-400 transition-colors hover:text-white">
            Features
          </Link>
          <Link href="/pricing" className="text-sm text-surface-400 transition-colors hover:text-white">
            Pricing
          </Link>
          <Link href="/download" className="text-sm text-surface-400 transition-colors hover:text-white">
            Download
          </Link>
          <Link href="/auth" className="text-sm text-surface-400 transition-colors hover:text-white">
            Log in
          </Link>
          <Link href="/auth?signup=true" className="btn-primary px-5 py-2 text-sm">
            Sign up
          </Link>
        </div>

        <button
          className="text-surface-400 hover:text-white md:hidden"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            )}
          </svg>
        </button>
      </nav>

      {open && (
        <div className="border-t border-surface-800 bg-surface-950 px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <Link href="/#features" className="text-sm text-surface-400 hover:text-white" onClick={() => setOpen(false)}>Features</Link>
            <Link href="/pricing" className="text-sm text-surface-400 hover:text-white" onClick={() => setOpen(false)}>Pricing</Link>
            <Link href="/download" className="text-sm text-surface-400 hover:text-white" onClick={() => setOpen(false)}>Download</Link>
            <Link href="/auth" className="text-sm text-surface-400 hover:text-white" onClick={() => setOpen(false)}>Log in</Link>
            <Link href="/auth?signup=true" className="btn-primary text-center text-sm" onClick={() => setOpen(false)}>Sign up</Link>
          </div>
        </div>
      )}
    </header>
  );
}
