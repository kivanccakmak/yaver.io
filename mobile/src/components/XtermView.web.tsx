// XtermView — web side.
//
// The native XtermView renders xterm.js inside a react-native-webview
// container (the in-app glasses terminal). react-native-webview has NO web
// implementation — rendering it in a browser throws "React Native WebView
// does not support this platform." That is the exact crash this file
// prevents (2026-08-09): the browser lane of the mobile app must never die
// on a surface it cannot serve.
//
// The browser has no raw-PTY transport and no WebView container, so a
// terminal here would be a lie. We render an honest placeholder instead —
// explainNoTransport-style: named, quiet, actionable, never a spinner that
// pretends to load. Native is untouched: this file is only loaded for the
// web target (additive-only, per AGENTS.md).
//
// The handle contract (XtermHandle: write/reset/fit) is implemented as a
// no-op so any caller that holds the ref never crashes on the missing
// terminal — the same "the operation did not happen, and it says so" rule
// as the rest of the browser lane.

import { forwardRef, useImperativeHandle } from "react";
import { StyleSheet, Text, View } from "react-native";

// Defined locally (NOT imported from ./XtermView) so this file never
// self-resolves into a cycle on the web target — the import specifier
// "./XtermView" from XtermView.web.tsx would resolve back to this file.
export interface XtermHandle {
  write(bytes: Uint8Array): void;
  fit(): void;
  focus(): void;
  /** Clear the grid + scrollback (raw_replay full-snapshot replace). */
  reset(): void;
}

const WEB_TERMINAL_UNAVAILABLE =
  "Terminal isn't available in the browser — it needs the native WebView. Open Yaver on your phone or Mac for the live terminal.";

export const WEBVIEW_SUPPORTED = false;
export const WEBVIEW_UNSUPPORTED_REASON = WEB_TERMINAL_UNAVAILABLE;

const XtermViewWeb = forwardRef<XtermHandle, Record<string, unknown>>((_props, ref) => {
  useImperativeHandle(
    ref,
    () => ({
      write: () => {
        /* no-op — no terminal in the browser; the placeholder says so */
      },
      fit: () => {
        /* no-op */
      },
      focus: () => {
        /* no-op */
      },
      reset: () => {
        /* no-op */
      },
    }),
    [],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Terminal unavailable on web</Text>
      <Text style={styles.body}>{WEB_TERMINAL_UNAVAILABLE}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  title: { fontSize: 13, fontWeight: "700", color: "#94a3b8" },
  body: { fontSize: 12, lineHeight: 18, color: "#64748b", textAlign: "center" },
});

export default XtermViewWeb;
