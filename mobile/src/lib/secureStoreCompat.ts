/**
 * SecureStore, with a web implementation.
 *
 * `expo-secure-store` is native-only. On web every call lands on a stub and
 * throws
 *
 *   ExpoSecureStore.default.setValueWithKeyAsync is not a function
 *
 * which is what a correct sign-in looks like from the user's side: the
 * credentials were right, the server answered, and then the app exploded while
 * PUTTING THE TOKEN AWAY. Nothing in that message says "this build has no
 * storage backend", so it reads as a broken login.
 *
 * That blocked the whole browser lane: the mobile app can be served as RN-web
 * (`expo start`, localhost:8081) and driven by Playwright at iPhone viewport —
 * the only way to automate the REAL app rather than the web dashboard — but no
 * session could ever persist, so every automated run died on the login screen.
 *
 * ── On the security tradeoff, stated plainly ────────────────────────────────
 *
 * localStorage is NOT the Keychain/Keystore. It is readable by any script on
 * the origin and offers no hardware backing. That is an honest downgrade, and
 * it applies ONLY to `Platform.OS === "web"`, which for this app means a
 * developer's own machine serving its own dev bundle — never a shipped iOS or
 * Android build, where the native module is present and used unchanged.
 *
 * The alternative was not "web with better storage", it was "no web at all",
 * and with it no automated testing of the real app. A dev-only origin holding a
 * dev session token in localStorage is a smaller risk than shipping a mobile
 * app whose preview lanes nobody can regression-test.
 *
 * Native behaviour is bit-for-bit unchanged: the same module, the same calls.
 */

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/** Namespaced so a dev server on the same origin cannot collide with app keys. */
const WEB_PREFIX = "yaver.secure.";

function webStore(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    // Safari with cookies disabled throws on ACCESS, not on use.
    return null;
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  if (Platform.OS !== "web") return SecureStore.getItemAsync(key);
  const s = webStore();
  if (!s) return null;
  try {
    return s.getItem(WEB_PREFIX + key);
  } catch {
    return null;
  }
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.setItemAsync(key, value);
  const s = webStore();
  if (!s) {
    // Say which capability is missing. A silent no-op here reproduces the exact
    // bug this file exists to remove: a sign-in that "works" and does not stick.
    throw new Error(
      "This browser has no localStorage (private mode or blocked cookies), so the session cannot be saved.",
    );
  }
  s.setItem(WEB_PREFIX + key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (Platform.OS !== "web") return SecureStore.deleteItemAsync(key);
  const s = webStore();
  if (!s) return;
  try {
    s.removeItem(WEB_PREFIX + key);
  } catch {
    /* nothing to remove */
  }
}

/** True when tokens are in hardware-backed storage rather than localStorage. */
export const isHardwareBacked = Platform.OS !== "web";
