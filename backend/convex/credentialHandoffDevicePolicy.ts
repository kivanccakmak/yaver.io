const DEVICE_ID = /^[a-zA-Z0-9._:-]{8,160}$/;
const BASE64_X25519 = /^[A-Za-z0-9+/]{43}=$/;

export function validateHandoffDevicePublicMetadata(value: {
  deviceId?: unknown;
  publicKey?: unknown;
  platform?: unknown;
}): { deviceId: string; publicKey: string; platform: string } {
  const deviceId = typeof value.deviceId === "string" ? value.deviceId.trim() : "";
  const publicKey = typeof value.publicKey === "string" ? value.publicKey.trim() : "";
  const platform = typeof value.platform === "string" ? value.platform.trim().slice(0, 32) : "";
  if (!DEVICE_ID.test(deviceId)) throw new Error("HANDOFF_DEVICE_ID_INVALID");
  if (!BASE64_X25519.test(publicKey)) throw new Error("HANDOFF_PUBLIC_KEY_INVALID");
  if (!platform) throw new Error("HANDOFF_PLATFORM_INVALID");
  return { deviceId, publicKey, platform };
}
