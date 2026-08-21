import type { CredentialHandoffRequest } from "./credentialHandoff";

export interface DirectoryDevice {
  deviceId: string;
  publicKey: string;
  platform: string;
  updatedAt: number;
}

export function directoryContainsReceiver(devices: readonly DirectoryDevice[], request: CredentialHandoffRequest): boolean {
  return devices.some((device) => device.deviceId === request.targetDeviceId && device.publicKey === request.targetPublicKey);
}
