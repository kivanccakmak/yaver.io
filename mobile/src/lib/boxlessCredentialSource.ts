/**
 * Credential-source contract for boxless DeepSeek surfaces.
 *
 * This is metadata only. A source may resolve a secret at the last possible
 * moment, but the source identity, status, and failure route never contain the
 * key. It lets mobile, tvOS, visionOS, and remote-agent UI agree on the truth:
 * account sign-in is not the same thing as provider-key availability.
 */

export type BoxlessCredentialSource =
  | { kind: "local-secure-store"; device: "iphone" | "ipad" | "tvos" | "visionos" }
  | { kind: "mobile-handoff"; handoffId: string; expiresAt: number }
  | { kind: "remote-vault"; deviceId: string }
  | { kind: "managed-gateway" };

export type BoxlessCredentialStatus =
  | { state: "ready"; source: BoxlessCredentialSource }
  | { state: "missing"; route: { method: "POST"; path: "/boxless/credentials/handoff" } }
  | { state: "expired"; route: { method: "POST"; path: "/boxless/credentials/handoff" } }
  | { state: "remote-runtime-required"; deviceId: string; route: { method: "GET"; path: "/devices" } };

export function describeBoxlessCredential(status: BoxlessCredentialStatus): string {
  switch (status.state) {
    case "ready":
      switch (status.source.kind) {
        case "local-secure-store": return `Saved on this ${status.source.device}`;
        case "mobile-handoff": return "Provided by your phone (temporary)";
        case "remote-vault": return "Provided by the selected Yaver machine";
        case "managed-gateway": return "Yaver managed gateway";
      }
    case "missing": return "DeepSeek access is not configured";
    case "expired": return "The phone handoff expired; approve a new one";
    case "remote-runtime-required": return "The selected machine must be online to provide DeepSeek access";
  }
}

/** A raw provider key is never a valid task/event/UI metadata value. */
export function isSafeCredentialMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return !["apiKey", "apikey", "key", "token", "secret", "authorization"].some((name) => name in record);
}
