// pendingApprovals — the phone half of the proactive device-approval event
// ("mobil onay"). A re-authing TV/headset that remembers its last owner
// creates its device code with an ownerUserIdHint; this feed lists those
// pending codes FOR THE SIGNED-IN USER ONLY (the backend derives the user
// from the bearer session — see backend/convex/http.ts
// /auth/device-code/pending), and the app offers a one-tap approve with a
// number-match against the code on the device's screen.
//
// Unlike e-Devlet's flow, the approval authority lives entirely on the
// ALREADY-AUTHENTICATED phone: the hint grants nothing, the unauthenticated
// device types nothing, and a wrong/forged hint only produces a prompt the
// user declines (the code on their TV won't match).

import { getConvexSiteUrlSync as getConvexSiteUrl } from "./backendConfig";

export interface PendingDeviceApproval {
  userCode: string;
  machineName: string | null;
  platform: string | null;
  environment: string | null;
  createdAt: number;
  expiresAt: number;
}

export async function fetchPendingDeviceApprovals(token: string): Promise<PendingDeviceApproval[]> {
  if (!token) return [];
  try {
    const res = await fetch(`${getConvexSiteUrl()}/auth/device-code/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.pending) ? (data.pending as PendingDeviceApproval[]) : [];
  } catch {
    return [];
  }
}

/** Human label for the waiting device. */
export function pendingApprovalDeviceLabel(row: PendingDeviceApproval): string {
  if (row.machineName && row.machineName.trim()) return row.machineName.trim();
  if (row.environment === "tv") return "Apple TV";
  if (row.platform) return row.platform;
  return "a device";
}
