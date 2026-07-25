/**
 * WebViewCompat — native side. Re-exports the real thing, unchanged.
 *
 * The web sibling (WebViewCompat.web.tsx) implements the same surface with an
 * <iframe>, because `react-native-webview` has NO web build and throws
 *
 *   React Native WebView does not support this platform.
 *
 * observed 2026-07-25 when Yaver's own app was served as RN-web: every screen
 * rendered except the preview, which is the one screen the browser lane exists
 * to show.
 *
 * Importing this module instead of `react-native-webview` costs a device
 * nothing — same component, same props, same behaviour — and makes the screen
 * renderable in Chromium, which is what lets Playwright drive the real app.
 *
 * Per the browser transport contract in CLAUDE.md: additive only, native path
 * untouched, and the pair carries a parity test.
 */

export { WebView } from "react-native-webview";
export type { WebViewProps } from "react-native-webview";

/** Native can always render an embedded browser. */
export const WEBVIEW_SUPPORTED = true;

/** Why not, when unsupported. Empty on native — it IS supported. */
export const WEBVIEW_UNSUPPORTED_REASON = "";
