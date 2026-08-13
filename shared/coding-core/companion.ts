import type { CompanionCommand, CodingSession, SurfaceKind } from "./runtime";

/** Companion surfaces are command and review clients. They never receive
 * provider tokens and never expose a shell/repository editor while driving. */
export const COMPANION_SURFACES: SurfaceKind[] = ["watch", "car", "tv", "xr"];

export function validateCompanionCommand(surface: SurfaceKind, command: CompanionCommand): CompanionCommand {
  if (surface === "car" && ["approve", "review"].includes(command.type)) {
    throw new Error("Complex approvals and diff review must be completed on a parked phone, tablet, desktop, or web surface.");
  }
  if (surface === "watch" && command.type === "review") {
    throw new Error("Review is handed off to the phone.");
  }
  return command;
}

export function summarizeForCompanion(session: CodingSession): string {
  const last = session.messages[session.messages.length - 1]?.content || "No update yet.";
  const capability = session.capabilities.nativeBuild ? "full execution" : "review/edit only";
  return `${session.state} · ${session.runtime} · ${capability}\n${last.slice(0, 240)}`;
}
