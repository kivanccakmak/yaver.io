// attachClient.ts — talks to the agent's /attach/* endpoints.
//
// The capability itself is an HttpOnly cookie the agent sets; this module never
// sees it and must never try to. Everything here works in terms of the SESSION
// ID, which is not a secret.
//
// Keeping that split honest is the point: if this file ever gains a
// `getAttachToken()`, the security model (page JS can use the authority but
// cannot read or move it) has been quietly reverted. See
// desktop/agent/attach_session.go.

import { connectionManager } from "./connectionManager";
import { appLog } from "./logger";
import type { AttachSessionResult } from "./quic";

export type { AttachSessionResult };

function clientFor(deviceId?: string | null) {
  const client = deviceId ? connectionManager.clientFor(deviceId) : connectionManager.active();
  if (!client?.isConnected) return null;
  return client;
}

const NOT_CONNECTED: AttachSessionResult = {
  ok: false,
  code: "ATTACH_BOX_OFFLINE",
  error: "That box isn't connected right now.",
  remedy: "Reconnect to the box, then turn Attach Mode on again.",
};

/**
 * Ask the agent to verify a directory really is Yaver's own checkout.
 *
 * The AGENT decides, from the project's declared identity (package.json name,
 * bundle id, monorepo layout). The phone cannot see the box's disk, and a
 * client-side path guess is exactly the "is it inside a folder called
 * yaver.io" heuristic that misfires on third-party fixtures under demo/.
 *
 * Fails CLOSED: anything we could not confirm is treated as "not Yaver", so a
 * network blip can never open Attach Mode on an unverified directory.
 */
export async function verifyYaverCheckout(deviceId: string, workDir: string): Promise<boolean> {
  const client = clientFor(deviceId);
  if (!client) return false;
  try {
    const caps = await client.getProjectPreviewCapabilities(workDir);
    return !!caps?.selfDevelopment;
  } catch (err) {
    appLog("warn", `attach: could not verify checkout: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function startAttachSession(deviceId: string, workDir: string): Promise<AttachSessionResult> {
  const client = clientFor(deviceId);
  if (!client) return NOT_CONNECTED;
  try {
    return await client.startAttachSession(workDir);
  } catch (err: any) {
    return {
      ok: false,
      code: "ATTACH_START_FAILED",
      error: err?.message || "Could not start Attach Mode.",
      remedy: "Check the box is reachable, then try again.",
    };
  }
}

export async function refreshAttachSession(deviceId: string, sessionId: string): Promise<AttachSessionResult> {
  const client = clientFor(deviceId);
  if (!client) return NOT_CONNECTED;
  try {
    return await client.refreshAttachSession(sessionId);
  } catch (err: any) {
    return { ok: false, code: "ATTACH_REFRESH_FAILED", error: err?.message || "Could not refresh Attach Mode." };
  }
}

/**
 * Detach. Revokes SERVER-SIDE; the caller also clears local state.
 *
 * Both halves matter. Clearing only the client would leave a live capability
 * on the box — the inventory says detached while the operation says still
 * attached, which is the false-green shape this repo keeps finding.
 */
export async function stopAttachSession(deviceId: string, sessionId?: string | null): Promise<boolean> {
  const client = clientFor(deviceId);
  if (!client) return false;
  try {
    return await client.stopAttachSession(sessionId);
  } catch (err) {
    appLog("warn", `attach: detach failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** How often the host re-mints while the surface is open. Comfortably inside
 *  the agent's 10-minute token TTL so a slow network cannot let it lapse. */
export const ATTACH_REFRESH_MS = 4 * 60 * 1000;
