/** Pure device-code parsing shared by deep links, manual entry and the camera.
 * Kept free of React Native/Expo imports so the security boundary is directly
 * testable in Node. */

/** Normalize a scanned/typed code to the canonical ABCD-1234 shape. */
export function normalizeUserCode(raw: string): string {
  const s = (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return s;
}

/** Permissive parser for a route parameter or deliberate manual entry. */
export function extractUserCode(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const q = u.searchParams.get("code");
    if (q) return normalizeUserCode(q);
  } catch {
    // Not a URL: deliberate manual code entry is allowed here.
  }
  return normalizeUserCode(raw);
}

/** Strict camera boundary. Only Yaver's canonical web/app verification links
 * may turn a QR into an approvable TV code. */
export function extractScannedDeviceCode(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const path = (u.pathname || "").replace(/\/+$/, "");
    const isWeb = u.protocol === "https:" && u.hostname.toLowerCase() === "yaver.io" && path === "/auth/device";
    const isApp = u.protocol === "yaver:" && u.hostname.toLowerCase() === "auth" && path === "/device";
    if (!isWeb && !isApp) return "";
    const code = normalizeUserCode(u.searchParams.get("code") || "");
    return code.length === 9 ? code : "";
  } catch {
    return "";
  }
}
