import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

const REMOTE_RUNTIME_CLIENT_ID_KEY = "yaver.remoteRuntime.clientId";

/** Stable viewer identity for remote-runtime ownership and lease attribution. */
export async function getRemoteRuntimeClientId(): Promise<string> {
  const id = `mobile-${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = (await AsyncStorage.getItem(REMOTE_RUNTIME_CLIENT_ID_KEY))?.trim();
    if (existing) return existing;
    await AsyncStorage.setItem(REMOTE_RUNTIME_CLIENT_ID_KEY, id);
  } catch {
    // Attribution must never become a new availability dependency. The
    // session still gets a unique in-memory id when storage is unavailable.
  }
  return id;
}
