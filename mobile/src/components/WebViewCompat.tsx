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

/** Mirrors the web twin. On NATIVE the ready-probe always runs (a real WebView
 *  can inject regardless of origin), so this is never emitted here — but the
 *  constant must exist on both sides or a caller importing it from the wrong
 *  twin is a runtime crash Metro picks per platform and tsc cannot see. The
 *  parity test pins it. */
export const WEBVIEW_PROBE_UNSUPPORTED = "yaver.webview.probe_unsupported";

/** Why not, when unsupported. Empty on native — it IS supported. */
export const WEBVIEW_UNSUPPORTED_REASON = "";
