"use client";

import { usePathname } from "next/navigation";
import { isAppSurfacePath } from "@/lib/app-surface";

export default function Footer() {
  const pathname = usePathname();
  // Sign-in → app only: no marketing chrome on the auth flow or app surfaces
  // (mirrors Header). The dashboard additionally hides this via CSS.
  if (isAppSurfacePath(pathname ?? "/")) return null;
  return (
    <footer className="border-t border-surface-800 bg-surface-950">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-center text-xs text-surface-600">
          &copy; {new Date().getFullYear()}{" "}
          <a href="https://simkab.com" target="_blank" rel="noopener noreferrer" className="hover:text-surface-400">SIMKAB ELEKTRIK</a>.
          All rights reserved.
          {" "}&middot;{" "}
          <a href="mailto:kivanc.cakmak@simkab.com" className="hover:text-surface-400">kivanc.cakmak@simkab.com</a>
        </p>
      </div>
    </footer>
  );
}
