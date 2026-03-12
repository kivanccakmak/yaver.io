"use client";

import Link from "next/link";
import { useState } from "react";
import { useTheme } from "./ThemeProvider";

export default function Header() {
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();

  return (
    <header className="sticky top-0 z-50 border-b border-surface-800/60 bg-surface-950/80 backdrop-blur-xl">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="text-xl font-bold tracking-tight text-surface-50">
              yaver<span className="font-normal text-surface-500">.io</span>
            </span>
          </Link>
          <span className="hidden rounded-full border border-green-800/60 bg-green-950/50 px-2.5 py-0.5 text-[10px] font-semibold tracking-wide text-green-400 sm:inline-flex">
            Early Access
          </span>
        </div>

        <div className="hidden items-center gap-8 md:flex">
          <Link href="/#features" className="text-sm text-surface-400 transition-colors hover:text-surface-50">
            Features
          </Link>
          <Link href="/pricing" className="text-sm text-surface-400 transition-colors hover:text-surface-50">
            Pricing
          </Link>
          <Link href="/download" className="text-sm text-surface-400 transition-colors hover:text-surface-50">
            Download
          </Link>
          <button
            onClick={toggle}
            className="rounded-lg p-2 text-surface-400 transition-colors hover:bg-surface-900 hover:text-surface-50"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
              </svg>
            )}
          </button>
          <Link href="/auth" className="text-sm text-surface-400 transition-colors hover:text-surface-50">
            Log in
          </Link>
          <Link href="/auth?signup=true" className="btn-primary px-5 py-2 text-sm">
            Sign up
          </Link>
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <button
            onClick={toggle}
            className="rounded-lg p-2 text-surface-400 transition-colors hover:text-surface-50"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
              </svg>
            )}
          </button>
          <button
            className="text-surface-400 hover:text-surface-50"
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
        </div>
      </nav>

      {open && (
        <div className="border-t border-surface-800 bg-surface-950 px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <Link href="/#features" className="text-sm text-surface-400 hover:text-surface-50" onClick={() => setOpen(false)}>Features</Link>
            <Link href="/pricing" className="text-sm text-surface-400 hover:text-surface-50" onClick={() => setOpen(false)}>Pricing</Link>
            <Link href="/download" className="text-sm text-surface-400 hover:text-surface-50" onClick={() => setOpen(false)}>Download</Link>
            <Link href="/auth" className="text-sm text-surface-400 hover:text-surface-50" onClick={() => setOpen(false)}>Log in</Link>
            <Link href="/auth?signup=true" className="btn-primary text-center text-sm" onClick={() => setOpen(false)}>Sign up</Link>
          </div>
        </div>
      )}
    </header>
  );
}
