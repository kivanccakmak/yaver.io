"use client";

/**
 * PendingSignInsPanel — approve a waiting tvOS/headless device-code sign-in
 * from the web dashboard (and therefore the Electron GUI, which loads the
 * dashboard).
 *
 * Two paths, matching the two ways a waiting code exists:
 *  1. The waiting device REMEMBERS its owner (ownerUserIdHint): its pending
 *     code shows up in GET /auth/device-code/pending and gets a one-tap
 *     Approve row — same proactive feed the phone app uses.
 *  2. First-time device (no owner hint — a fresh Apple TV): the code is not
 *     in that feed, so there is a manual "enter the code" box. Same
 *     /auth/device-code/authorize call, same result.
 *
 * The authorize call is the same route the /auth/device approve page uses
 * (/api/auth/device/authorize → Convex), so error codes map identically.
 * Never blocks the page: a failed fetch hides the panel silently.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CONVEX_URL } from "@/lib/constants";

type PendingApproval = {
  userCode: string;
  machineName: string | null;
  platform: string | null;
  environment: string | null;
  createdAt: number;
  expiresAt: number;
};

function platformLabel(platform: string | null): string {
  switch ((platform || "").toLowerCase()) {
    case "tvos": return "tvOS";
    case "visionos": return "visionOS";
    case "darwin": return "macOS";
    case "linux": return "Linux";
    case "windows": return "Windows";
    case "ios": return "iOS";
    case "android": return "Android";
    default: return platform || "";
  }
}

export default function PendingSignInsPanel({ token }: { token: string | null | undefined }) {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // userCode being approved, or "manual"
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setPending([]);
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch(`${CONVEX_URL}/auth/device-code/pending`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setPending([]);
        setLoaded(true);
        return;
      }
      const data = await res.json().catch(() => null);
      const rows = Array.isArray(data?.pending) ? data.pending : [];
      setPending(rows.filter((r: PendingApproval) => r?.userCode && r.expiresAt > Date.now()));
      setLoaded(true);
    } catch {
      setPending([]);
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const authorize = async (userCode: string) => {
    if (!token) {
      setMessage({ ok: false, text: "You are signed out in this browser — sign in to approve." });
      return;
    }
    setBusy(userCode);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/device/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userCode, convexUrl: CONVEX_URL }),
      });
      if (res.ok) {
        setMessage({ ok: true, text: `Approved ${userCode}. The TV picks up the session automatically.` });
        setManualCode("");
        void refresh();
      } else {
        const data = await res.json().catch(() => ({ error: "Something went wrong." }));
        const code = typeof (data as { code?: unknown })?.code === "string"
          ? (data as { code: string }).code
          : "";
        if (code === "invalid_code" || res.status === 404) {
          setMessage({ ok: false, text: `Invalid code ${userCode} — check the TV screen and try again.` });
        } else if (code === "code_expired" || res.status === 410) {
          setMessage({ ok: false, text: `Code ${userCode} expired — the TV is generating a fresh one.` });
        } else if (code === "code_already_used" || res.status === 409) {
          setMessage({ ok: false, text: `Code ${userCode} was already approved.` });
        } else if (code === "too_many_attempts" || res.status === 429) {
          setMessage({ ok: false, text: `Too many attempts on ${userCode} — wait and use the fresh code on the TV.` });
        } else {
          setMessage({ ok: false, text: (data as { error?: string }).error || "Something went wrong." });
        }
      }
    } catch {
      setMessage({ ok: false, text: "Could not reach Yaver. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const visible = pending.length > 0 || loaded;
  if (!visible || !token) return null;

  const handleCodeChange = (val: string) => {
    const stripped = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
    setManualCode(stripped.length <= 4 ? stripped : `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`);
  };

  return (
    <section className="rounded-2xl border border-indigo-500/25 bg-indigo-500/[0.06] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-surface-100">
          Pending sign-ins
          {pending.length > 0 ? (
            <span className="ml-2 rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300">
              {pending.length}
            </span>
          ) : null}
        </h3>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[11px] font-semibold text-surface-400 hover:text-surface-200"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-surface-400">
        A TV or headless machine is waiting for you to approve its sign-in. Approve here — no need to scan the QR with your phone.
      </p>

      {pending.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {pending.map((row) => (
            <li
              key={row.userCode}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-700/60 bg-surface-950/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-surface-100">
                    {row.machineName || "Unnamed device"}
                  </span>
                  <span className="font-mono text-[11px] font-bold tracking-[0.2em] text-indigo-300">{row.userCode}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-surface-500">
                  {[platformLabel(row.platform), row.environment ? `env ${row.environment}` : null]
                    .filter(Boolean)
                    .join(" · ") || "Waiting device"}
                  {" · "}
                  expires in {Math.max(0, Math.ceil((row.expiresAt - Date.now()) / 60_000))} min
                </div>
              </div>
              <button
                type="button"
                disabled={busy === row.userCode}
                onClick={() => void authorize(row.userCode)}
                className="rounded-lg bg-indigo-500 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-50"
              >
                {busy === row.userCode ? "Approving…" : "Approve"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[11px] text-surface-500">
          No waiting codes are linked to your account yet. If a TV is showing a code, enter it below.
        </p>
      )}

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const cleaned = manualCode.replace(/-/g, "");
          if (cleaned.length === 8) void authorize(manualCode);
          else setMessage({ ok: false, text: "Enter the 8-character code shown on the TV (e.g. ABCD-1234)." });
        }}
      >
        <input
          type="text"
          value={manualCode}
          onChange={(e) => handleCodeChange(e.target.value)}
          placeholder="ABCD-1234"
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          className="w-44 rounded-lg border border-surface-700 bg-surface-950 px-3 py-1.5 font-mono text-[13px] font-bold tracking-[0.2em] text-surface-100 placeholder-surface-600 outline-none focus:border-indigo-400"
        />
        <button
          type="submit"
          disabled={busy === "manual" || manualCode.replace(/-/g, "").length < 8}
          className="rounded-lg border border-surface-600 bg-surface-900 px-3 py-1.5 text-[12px] font-semibold text-surface-200 transition-colors hover:border-indigo-400 hover:text-surface-50 disabled:opacity-50"
        >
          {busy === "manual" ? "Approving…" : "Enter code"}
        </button>
        <span className="text-[11px] text-surface-500">First-time TV? Type the code from the TV screen here.</span>
      </form>

      {message ? (
        <p
          className={`mt-2 text-[11px] font-medium ${
            message.ok ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
