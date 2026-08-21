import { getConvexSiteUrl } from "./auth";
import type { CredentialHandoffRequest } from "./credentialHandoff";
import { directoryContainsReceiver, type DirectoryDevice } from "./credentialHandoffDirectoryPolicy";

async function responseJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Your session expired. Sign in again before sharing credentials." : "The secure handoff device directory is unavailable.");
  return body;
}

/** Register public routing metadata only. Never pass an envelope or secret. */
export async function registerCredentialHandoffDevice(args: {
  token: string;
  deviceId: string;
  publicKey: string;
  platform: string;
}): Promise<void> {
  const response = await fetch(`${getConvexSiteUrl()}/credential-handoff/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: args.deviceId, publicKey: args.publicKey, platform: args.platform }),
  });
  await responseJson(response);
}

/** Prove the scanned receiver key is registered under this authenticated account. */
export async function verifyCredentialHandoffReceiver(token: string, request: CredentialHandoffRequest): Promise<void> {
  const response = await fetch(`${getConvexSiteUrl()}/credential-handoff/devices`, {
    headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
  });
  const body = await responseJson(response) as { devices?: DirectoryDevice[] };
  const match = directoryContainsReceiver(body.devices || [], request);
  if (!match) {
    throw new Error("This receiver key is not registered to your signed-in Yaver account. Refresh its handoff screen and try again.");
  }
}
