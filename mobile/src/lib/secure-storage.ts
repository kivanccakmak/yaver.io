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

// Keep the SecureStore-shaped names so existing callers remain unchanged.
export const getItemAsync = getItem;
export const setItemAsync = setItem;
export const deleteItemAsync = deleteItem;
