// machineResources.ts — the client-side half of the agent's co-vibe model.
//
// ONE module, deliberately RN-free and dependency-free, so the same code renders:
//
//   • mobile / tablet / car / glass  (they share DeviceContext — free)
//   • web dashboard                 (mirrored at web/lib/machine-resources.ts)
//   • tvOS / watchOS                (ported; the SHAPE here is the contract)
//
// It formats three questions a shared machine has to answer out loud, and which
// every surface previously answered differently or not at all:
//
//   1. "Which port am I actually on?"   — the agent brokers ports (Metro 8081 may
//      be taken by anything, on one real box a four-day-old freeswitch), so the
//      framework default is a guess. The agent sends the truth in /dev/status and
//      in the `resources` SSE frame.
//   2. "Who else is here?"              — a joint session can hold people on web,
//      phone and TV at once. Not seeing them is how two people fight over one
//      simulator and each thinks the other is a glitch.
//   3. "What may I do?"                 — viewer vs driver, granted by the owner.
//      The AGENT enforces it (a greyed-out button is not a permission); this
//      formats it so the user is never surprised by a 403.
//
// Wire contract: desktop/agent/vibe_sessions.go + runtime_devices.go.

export type VibeRole = "owner" | "driver" | "viewer";

export interface VibeResource {
  type: "port" | "device";
  kind: string; // "metro" | "flutter" | "ios-simulator" | …
  value: string; // "8083" | "323C65E7-…"
  label: string; // agent-provided human label
  since?: string;
}

export interface VibeParticipant {
  id: string;
  userId: string;
  displayName: string;
  surface: string; // web | mobile | tablet | tv | watch | car | glass | cli | unknown
  role: VibeRole;
  isGuest: boolean;
  joinedAt?: string;
  lastSeenAt?: string;
}

export interface VibeSession {
  id: string;
  ownerUserId: string;
  project: string; // basename only — the agent never sends absolute paths
  framework?: string;
  participants: VibeParticipant[];
  resources: VibeResource[];
  createdAt?: string;
}

export interface MachineResourceReport {
  hostname?: string;
  sessions: VibeSession[];
  unattributed?: VibeResource[];
  generatedAt?: string;
}

/** Port/device facts as they arrive on /dev/status (same fields, flat). */
export interface DevStatusResources {
  port?: number;
  preferredPort?: number;
  portSubstituted?: boolean;
  resources?: VibeResource[];
  vibeSessionId?: string;
}

// ─── ports ───────────────────────────────────────────────────────────────────

/**
 * One line describing where this dev server is actually served.
 *
 * The substitution case is the one that matters: silently binding a different
 * port than the framework's default leaves the user reading logs that mention a
 * port they never chose. Say it, once, plainly.
 */
export function describePort(status: DevStatusResources | null | undefined): string | null {
  if (!status || !status.port) return null;
  if (status.portSubstituted && status.preferredPort && status.preferredPort !== status.port) {
    return `serving on :${status.port} (:${status.preferredPort} was already in use on this machine)`;
  }
  return `serving on :${status.port}`;
}

/** "flutter on :9100 · ios-simulator 323C65E7" — resources in one short line. */
export function describeResources(resources: VibeResource[] | null | undefined): string {
  if (!resources || resources.length === 0) return "";
  return resources.map((r) => r.label).join(" · ");
}

// ─── people ──────────────────────────────────────────────────────────────────

const SURFACE_LABELS: Record<string, string> = {
  web: "Web",
  mobile: "Phone",
  tablet: "Tablet",
  tv: "TV",
  watch: "Watch",
  car: "Car",
  glass: "Glasses",
  cli: "Terminal",
  unknown: "Unknown",
};

export function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface;
}

const ROLE_LABELS: Record<VibeRole, string> = {
  owner: "Owner",
  driver: "Can vibe",
  viewer: "Watching",
};

export function roleLabel(role: VibeRole): string {
  return ROLE_LABELS[role] ?? role;
}

/** Ordering for display: owner, then drivers, then viewers; stable by name. */
export function sortParticipants(participants: VibeParticipant[]): VibeParticipant[] {
  const rank = (r: VibeRole) => (r === "owner" ? 0 : r === "driver" ? 1 : 2);
  return [...participants].sort(
    (a, b) => rank(a.role) - rank(b.role) || (a.displayName || "").localeCompare(b.displayName || ""),
  );
}

/**
 * The roster headline.
 *
 * A solo session says nothing — narrating "1 person here (you)" is noise. The
 * moment someone else joins, that IS the news, so it leads with the count and
 * names who can actually type.
 */
export function describeParticipants(
  participants: VibeParticipant[] | null | undefined,
  meUserId?: string,
): string {
  const live = participants ?? [];
  if (live.length <= 1) return "";
  const others = live.filter((p) => p.userId !== meUserId);
  const drivers = live.filter((p) => p.role === "owner" || p.role === "driver");
  const names = others
    .map((p) => `${p.displayName || "Someone"} (${surfaceLabel(p.surface)})`)
    .join(", ");
  // Name the count of people who can actually type: on a shared machine that is
  // the fact that predicts a surprise ("why did the app just reload?").
  const driverNote = drivers.length === 1 ? "1 can vibe" : `${drivers.length} can vibe`;
  return `${live.length} here · ${names} · ${driverNote}`;
}

/** Can this participant change anything? Mirrors the agent's CanDrive. */
export function canDrive(role: VibeRole | null | undefined): boolean {
  return role === "owner" || role === "driver";
}

/**
 * What to show a viewer INSTEAD of an enabled control.
 *
 * Returning a reason (not just `disabled`) is the point: a dead button with no
 * explanation is the same defect as a spinner with no elapsed time.
 */
export function whyCannotDrive(role: VibeRole | null | undefined): string | null {
  if (canDrive(role)) return null;
  if (!role) return "You are not in this session — re-join to interact.";
  return "You are watching. Ask the machine owner for permission to vibe.";
}

/** Find my seat in a session (same person on two surfaces = two seats). */
export function mySeat(
  session: VibeSession | null | undefined,
  userId?: string,
  surface?: string,
): VibeParticipant | null {
  if (!session || !userId) return null;
  const seats = session.participants.filter((p) => p.userId === userId);
  if (seats.length === 0) return null;
  if (surface) {
    const exact = seats.find((p) => p.surface === surface);
    if (exact) return exact;
  }
  return seats[0];
}

/**
 * Summarise the whole machine for a "what is this box doing?" strip.
 * Deliberately compact — a machine hosting six sessions must not produce six
 * paragraphs.
 */
export function describeMachine(report: MachineResourceReport | null | undefined): string {
  const sessions = report?.sessions ?? [];
  if (sessions.length === 0) return "No active sessions on this machine.";
  const people = new Set<string>();
  let resourceCount = 0;
  for (const s of sessions) {
    for (const p of s.participants) people.add(p.userId || p.id);
    resourceCount += s.resources.length;
  }
  const projects = sessions.map((s) => s.project).filter(Boolean).join(", ");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // "persons" is not English. English plurals are irregular enough that a naive
  // +"s" helper produces exactly this kind of wrong-looking UI copy.
  const people_ = people.size === 1 ? "1 person" : `${people.size} people`;
  return `${plural(sessions.length, "session")} · ${projects} · ${people_} · ${plural(resourceCount, "resource")}`;
}
