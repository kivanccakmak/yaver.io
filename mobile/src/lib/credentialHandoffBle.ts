import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { BleManager, type Device } from "react-native-ble-plx";

import {
  encodeCredentialHandoffQr,
  parseCredentialHandoffQr,
  type CredentialHandoffEnvelope,
  type CredentialHandoffRequest,
} from "./credentialHandoff";

const SERVICE = "59415645-1001-4d65-7368-0000000000a0";
const REQUEST = "59415645-1002-4d65-7368-0000000000a0";
const ENVELOPE = "59415645-1003-4d65-7368-0000000000a0";
const HEADER_BYTES = 4;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let manager: BleManager | null = null;
let senderDevice: Device | null = null;
let messageId = 1;

function bleManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

function toBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    output += B64[a >> 2];
    output += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : "=";
    output += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return output;
}

function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const output: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) |
      (B64.indexOf(clean[i + 2]) << 6) | B64.indexOf(clean[i + 3]);
    output.push((n >> 16) & 0xff);
    if (clean[i + 2] !== undefined) output.push((n >> 8) & 0xff);
    if (clean[i + 3] !== undefined) output.push(n & 0xff);
  }
  return new Uint8Array(output);
}

async function ensureCentralPermissions(): Promise<void> {
  if (Platform.OS !== "android") return;
  const permissions = Platform.Version >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(
    permissions as Parameters<typeof PermissionsAndroid.requestMultiple>[0],
  );
  if (!Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error("Nearby devices permission is required for BLE secure handoff.");
  }
}

export function canReceiveCredentialHandoffOverBle(): boolean {
  return Platform.OS === "android" && !!NativeModules.YaverCredentialBle;
}

export async function startCredentialHandoffBleReceiver(
  request: CredentialHandoffRequest,
  onEnvelope: (envelope: CredentialHandoffEnvelope) => void,
): Promise<() => void> {
  const native = NativeModules.YaverCredentialBle;
  if (Platform.OS !== "android" || !native) {
    throw new Error("BLE receiving currently requires the Yaver Android app.");
  }
  if (Platform.Version >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ] as Parameters<typeof PermissionsAndroid.requestMultiple>[0]);
    if (!Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED)) {
      throw new Error("Nearby devices permission is required to advertise a secure handoff.");
    }
  }
  const emitter = new NativeEventEmitter(native);
  const subscription = emitter.addListener("YaverCredentialBleEnvelope", (event: { value?: string }) => {
    const parsed = parseCredentialHandoffQr(event?.value ?? "");
    if (parsed?.type === "yaver-credential-envelope") onEnvelope(parsed);
  });
  try {
    await native.startReceiver(encodeCredentialHandoffQr(request));
  } catch (error) {
    subscription.remove();
    throw error;
  }
  return () => {
    subscription.remove();
    native.stopReceiver();
  };
}

export async function findCredentialHandoffBleReceiver(timeoutMs = 12_000): Promise<CredentialHandoffRequest> {
  await ensureCentralPermissions();
  senderDevice = null;
  const found = await new Promise<Device>((resolve, reject) => {
    const timeout = setTimeout(() => {
      bleManager().stopDeviceScan();
      reject(new Error("No nearby Yaver secure-handoff receiver was found."));
    }, timeoutMs);
    bleManager().startDeviceScan([SERVICE], null, (error, device) => {
      if (error) {
        clearTimeout(timeout);
        bleManager().stopDeviceScan();
        reject(error);
      } else if (device) {
        clearTimeout(timeout);
        bleManager().stopDeviceScan();
        resolve(device);
      }
    });
  });
  let connected = await found.connect();
  connected = await connected.discoverAllServicesAndCharacteristics();
  if (Platform.OS === "android") {
    try { connected = await connected.requestMTU(247); } catch { /* use negotiated MTU */ }
  }
  const characteristic = await connected.readCharacteristicForService(SERVICE, REQUEST);
  if (!characteristic.value) throw new Error("The nearby device did not expose a secure-handoff request.");
  const parsed = parseCredentialHandoffQr(new TextDecoder().decode(fromBase64(characteristic.value)));
  if (parsed?.type !== "yaver-credential-request") {
    await connected.cancelConnection().catch(() => {});
    throw new Error("The nearby device returned an invalid secure-handoff request.");
  }
  senderDevice = connected;
  return parsed;
}

export async function sendCredentialHandoffEnvelopeOverBle(envelope: CredentialHandoffEnvelope): Promise<void> {
  const device = senderDevice;
  if (!device || !(await device.isConnected())) throw new Error("The receiving device is no longer connected over BLE.");
  const payload = new TextEncoder().encode(encodeCredentialHandoffQr(envelope));
  const mtu = Math.max(23, Number((device as Device & { mtu?: number }).mtu ?? 23));
  const chunkSize = Math.max(16, mtu - 3 - HEADER_BYTES);
  const id = messageId++ & 0xff;
  const total = Math.max(1, Math.ceil(payload.length / chunkSize));
  for (let sequence = 0; sequence < total; sequence++) {
    const part = payload.slice(sequence * chunkSize, (sequence + 1) * chunkSize);
    const frame = new Uint8Array(HEADER_BYTES + part.length);
    frame[0] = id;
    frame[1] = (sequence >> 8) & 0xff;
    frame[2] = sequence & 0xff;
    frame[3] = sequence === total - 1 ? 1 : 0;
    frame.set(part, HEADER_BYTES);
    // Credentials are tiny and correctness matters more than throughput. An
    // acknowledged write prevents a fast iPhone from overrunning the Android
    // GATT server's receive queue and silently losing a middle frame.
    await device.writeCharacteristicWithResponseForService(SERVICE, ENVELOPE, toBase64(frame));
  }
  await device.cancelConnection().catch(() => {});
  senderDevice = null;
}

export async function disconnectCredentialHandoffBle(): Promise<void> {
  const device = senderDevice;
  senderDevice = null;
  if (device) await device.cancelConnection().catch(() => {});
}
