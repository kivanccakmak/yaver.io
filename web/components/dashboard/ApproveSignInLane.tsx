"use client";

/**
 * ApproveSignInLane — the one tap that signs a stranded machine back in.
 *
 * A box whose Convex session has expired is stuck in a loop it cannot break by
 * itself: it needs its session to refresh the relay password, and it needs the
 * relay to be reachable to be told anything. On 2026-08-01 four machines sat in
 * "Alive · can't reach (Relay refused: account relay password missing or
 * stale)" and the only remedy was a shell on each one — including a box on a LAN
 * nobody was on.
 *
 * The box now nominates itself: on reason=dead_token it mints a device code and
 * publishes it on its heartbeat, which is outbound HTTPS and therefore the one
 * channel that still works when nothing can reach the machine. This renders that
 * code as a button. Approving it authorizes the code with THIS browser's
 * session, the box's own poller picks up a fresh token within about five
 * seconds, and it signs itself back in.
 *
 * ── Why a button and not a sentence ─────────────────────────────────────────
 *
 * A failure is only shipped when it carries a route to its fix: not prose
 * describing a remedy, but something the user can tap. The predecessor of this
 * component was a log line on an unreachable machine — a remedy that required
 * already having what you were trying to get. And it must not be crowded out:
 * advisory content never outranks the route, so this renders as an action, not
 * as another status chip in a row of status chips.
 *
 * ── Why publishing the code is safe ─────────────────────────────────────────
 *
 * The code is an invitation, not a credential. authorizeDeviceCode derives the
 * account from the APPROVER's bearer token, so a stranger holding the code can
 * authorize nothing — they would have to already be signed in as the owner, at
 * which point the code adds nothing. The minted session token never travels
 * this way; the box polls for it over the same channel `yaver auth` uses.
 */

import { useState } from "react";
import { approveFailureMessage } from "@/lib/approveFailureMessage";

export function ApproveSignInLane({
  deviceName,
  pendingAuthCode,
  token,
  convexSiteUrl,
  onApproved,
}: {
  deviceName: string;
  /** Present only while the box is offering a code. Convex has already expired
   *  anything older than 15 minutes, so a value here is approvable right now. */
  pendingAuthCode?: string;
  /** This browser's session. Approval is authorized as the signed-in owner. */
  token?: string | null;
  convexSiteUrl: string;
  onApproved?: () => void;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  if (!pendingAuthCode) return null;

  const approve = async () => {
    if (!token) {
      // Never a dead click: the button existing while the browser has no session
      // would be the same silent no-op that made the web approver's Authorize
      // button do literally nothing.
      setState("error");
      setMessage("This browser is not signed in any more. Reload the page and sign in, then approve.");
      return;
    }
    setState("working");
    setMessage("");
    // Bounded. An unbounded await here would leave the button spinning with no
    // cause on the one screen that exists to un-strand a machine.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${convexSiteUrl}/auth/device-code/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userCode: pendingAuthCode, convexUrl: convexSiteUrl }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setState("error");
        setMessage(approveFailureMessage(res.status, body));
        return;
      }
      setState("done");
      // Say what happens next, with a time. A bare "Approved" leaves the user
      // watching a card that has not changed yet and wondering if it worked.
      setMessage(`Signed in. ${deviceName} picks up its new session within about 5 seconds.`);
      onApproved?.();
    } catch (err) {
      setState("error");
      setMessage(
        (err as { name?: string })?.name === "AbortError"
          ? "The approval timed out. Check your connection and try again."
          : "Could not reach Yaver to approve this machine. Check your connection.",
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-50 px-3 py-2 dark:border-amber-400/30 dark:bg-amber-500/10">
      <div className="text-[12px] font-medium text-amber-800 dark:text-amber-200">
        {state === "done"
          ? message
          : `${deviceName} lost its sign-in and is asking to be signed back in.`}
      </div>
      {state !== "done" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void approve()}
            disabled={state === "working"}
            className="rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
          >
            {state === "working" ? "Approving…" : "Approve sign-in"}
          </button>
          {/* The code itself, so a user who would rather approve from their
              phone can read it off the screen instead of hunting for it. */}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] tracking-wider text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
            {pendingAuthCode}
          </code>
        </div>
      ) : null}
      {state === "error" && message ? (
        <div className="mt-1.5 text-[11px] text-amber-800 dark:text-amber-300">{message}</div>
      ) : null}
    </div>
  );
}
