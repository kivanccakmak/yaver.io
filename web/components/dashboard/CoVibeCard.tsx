"use client";

// CoVibeCard — who is on this machine right now, what they hold, and (for the
// owner) who may type.
//
// This is the web half of the model in desktop/agent/vibe_sessions.go. It renders
// from the SAME formatter as mobile (lib/machine-resources.ts mirrors
// mobile/src/lib/machineResources.ts), so a person looking at the dashboard and a
// person looking at their phone never get different answers about who is driving.
//
// Why it exists at all: one machine hosts several projects and several people at
// once, each possibly on a different surface (web here, a phone there, a TV in the
// room). Without a roster, two people drive one simulator and each experiences the
// other as a glitch — and a "read-only" guest has no way to know why an action
// failed. The agent enforces the roles; this makes them visible and grantable.

import { useCallback, useEffect, useRef, useState } from "react";
import { agentClient } from "@/lib/agent-client";
import {
  canDrive,
  describeMachine,
  describeResources,
  roleLabel,
  sortParticipants,
  surfaceLabel,
  type MachineResourceReport,
  type VibeParticipant,
  type VibeSession,
} from "@/lib/machine-resources";

const REFRESH_MS = 5000;

export default function CoVibeCard({ ownerUserId }: { ownerUserId?: string }) {
  const [report, setReport] = useState<MachineResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await agentClient.getVibeSessions();
      setReport(next);
      setError(null);
    } catch (e) {
      // A failed poll must SAY so — a card that silently keeps showing a stale
      // roster is worse than an empty one, because it looks authoritative.
      setError(e instanceof Error ? e.message : "Could not read this machine's sessions.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  const grant = useCallback(
    async (session: VibeSession, participant: VibeParticipant, role: "viewer" | "driver") => {
      setBusy(participant.id);
      const res = await agentClient.setVibeRole(session.id, participant.id, role);
      setBusy(null);
      if (!res.ok) {
        // Surface the agent's own reason (e.g. "only the machine owner can
        // change who may vibe") rather than a generic failure.
        setError(res.error ?? "Could not change that permission.");
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const sessions = report?.sessions ?? [];

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Who&apos;s on this machine</h3>
        <span className="text-xs text-[var(--text-muted)]">{describeMachine(report)}</span>
      </header>

      {error ? (
        <p className="mt-3 text-xs text-[var(--warn)]" role="status">
          {error}
        </p>
      ) : null}

      {sessions.length === 0 && !error ? (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          No active sessions. Start a preview or a task and it will appear here — along with the port
          and device it claims.
        </p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {sessions.map((session) => {
          const seats = sortParticipants(session.participants);
          const held = describeResources(session.resources);
          return (
            <li key={session.id} className="rounded-lg border border-[var(--border-subtle)] p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {session.project || "(unnamed project)"}
                  {session.framework ? (
                    <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                      {session.framework}
                    </span>
                  ) : null}
                </span>
                {/* The exclusive resources this session holds. Shown per session
                    because that is the boundary that matters: two sessions must
                    never appear to share a port or a simulator. */}
                {held ? <span className="text-xs text-[var(--text-muted)]">{held}</span> : null}
              </div>

              {seats.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Nobody is watching this session right now.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {seats.map((seat) => {
                    const isMe = ownerUserId && seat.userId === ownerUserId;
                    const iAmOwner = ownerUserId && ownerUserId === session.ownerUserId;
                    const showToggle = iAmOwner && seat.role !== "owner";
                    return (
                      <li key={seat.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-[var(--text-primary)]">
                          {seat.displayName || "Someone"}
                          {isMe ? " (you)" : ""}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                          {surfaceLabel(seat.surface)}
                        </span>
                        <span
                          className={
                            canDrive(seat.role)
                              ? "rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]"
                              : "rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]"
                          }
                        >
                          {roleLabel(seat.role)}
                        </span>
                        {seat.isGuest ? (
                          <span className="text-[10px] text-[var(--text-muted)]">guest</span>
                        ) : null}

                        {showToggle ? (
                          <button
                            type="button"
                            disabled={busy === seat.id}
                            onClick={() =>
                              void grant(session, seat, seat.role === "driver" ? "viewer" : "driver")
                            }
                            className="ml-auto rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                          >
                            {busy === seat.id
                              ? "…"
                              : seat.role === "driver"
                                ? "Make read-only"
                                : "Let them vibe"}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {/* Held-but-unattributed resources. Reported rather than hidden: an
          unexplained port is exactly what someone needs to see when a dev server
          refuses to start. */}
      {report?.unattributed && report.unattributed.length > 0 ? (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Also held on this machine: {describeResources(report.unattributed)}
        </p>
      ) : null}
    </section>
  );
}
