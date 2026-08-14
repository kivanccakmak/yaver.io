import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// expo-secure-store is native-only. Expo web can still use the settings
// screens, so keep the same async API with a browser-local fallback.
const memoryFallback: Record<string, string> = {};

function webStorage(): Storage | null {
  if (Platform.OS !== "web") return null;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export async function getItem(key: string): Promise<string | null> {
  const storage = webStorage();
  if (storage) {
    try { return storage.getItem(key); } catch { return memoryFallback[key] ?? null; }
  }
  try { return await SecureStore.getItemAsync(key); } catch { return memoryFallback[key] ?? null; }
}

export async function setItem(key: string, value: string): Promise<void> {
  memoryFallback[key] = value;
  const storage = webStorage();
  if (storage) {
    try { storage.setItem(key, value); } catch { /* memory fallback */ }
    return;
  }
  try { await SecureStore.setItemAsync(key, value); } catch { /* memory fallback */ }
}

export async function deleteItem(key: string): Promise<void> {
  delete memoryFallback[key];
  const storage = webStorage();
  if (storage) {
    try { storage.removeItem(key); } catch { /* best effort */ }
    return;
  }
  try { await SecureStore.deleteItemAsync(key); } catch { /* best effort */ }
}

/**
 * Best-effort storage is suitable for non-sensitive UI state and sessions, but
 * never for a provider key or Git credential.  In particular, a tvOS Keychain
 * entitlement/configuration error must not turn a long-lived token into an
 * in-memory secret without telling the user.
 */
export async function isPersistentSecureStorageAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function requirePersistentSecureStorage(): Promise<void> {
  if (!(await isPersistentSecureStorageAvailable())) {
    throw new Error("Secure device storage is unavailable. Local model and Git credentials cannot be saved on this device.");
  }
}

export async function getSecret(key: string): Promise<string | null> {
  await requirePersistentSecureStorage();
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    throw new Error("Secure device storage could not read this credential.");
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  await requirePersistentSecureStorage();
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    throw new Error("Secure device storage could not save this credential.");
  }
}

export async function deleteSecret(key: string): Promise<void> {
  await requirePersistentSecureStorage();
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    throw new Error("Secure device storage could not remove this credential.");
  }
}

// Keep the SecureStore-shaped names so existing callers remain unchanged.
export const getItemAsync = getItem;
export const setItemAsync = setItem;
export const deleteItemAsync = deleteItem;
