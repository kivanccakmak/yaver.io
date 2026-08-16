/**
 * WebViewCompat — web side. An <iframe> wearing the WebView API.
 *
 * `react-native-webview` has no web implementation; rendering it in a browser
 * throws "React Native WebView does not support this platform." That is exactly
 * what blocked the preview screen when Yaver's own app ran as RN-web — every
 * other screen drew, and the one screen the browser lane exists to show was the
 * one that could not.
 *
 * An <iframe> IS the browser's WebView: same job, native API, no shim library.
 * What differs is honest and bounded, and callers are told rather than left to
 * discover it:
 *
 *   • injectedJavaScript only runs on a SAME-ORIGIN frame. Cross-origin, the
 *     browser forbids reaching in — so the ready-probe cannot fire and this
 *     component reports `unsupported: cross-origin` instead of pretending the
 *     page never loaded. (The dev-preview case IS same-origin: the agent
 *     proxies the app at /dev-web/ under its own origin.)
 *   • window.ReactNativeWebView.postMessage is provided to the frame so guest
 *     pages written for the native container keep working unchanged.
 *   • No cookie/storage isolation control, no native gesture handling. Neither
 *     matters for a dev preview.
 *
 * NATIVE IS UNTOUCHED: this file is only ever loaded for the web target.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export const WEBVIEW_SUPPORTED = true;

/** Message `type` emitted when the ready-probe cannot run (cross-origin frame).
 *  A caller MUST treat this as "stop waiting for the probe", not as an error:
 *  the frame is fine, only the confirmation channel is unavailable. */
export const WEBVIEW_PROBE_UNSUPPORTED = "yaver.webview.probe_unsupported";
export const WEBVIEW_UNSUPPORTED_REASON = "";

export interface WebViewProps {
  source?: { uri?: string; html?: string };
  injectedJavaScript?: string;
  onMessage?: (e: { nativeEvent: { data: string } }) => void;
  onLoadEnd?: () => void;
  onError?: (e: unknown) => void;
  onLoadStart?: () => void;
  style?: any;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  allowsInlineMediaPlayback?: boolean;
  [key: string]: any;
}

export const WebView = forwardRef<any, WebViewProps>(function WebView(props, ref) {
  const { source, injectedJavaScript, onMessage, onLoadEnd, onError, onLoadStart, style } = props;
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // reload() is the one imperative method the preview screen calls.
  useImperativeHandle(ref, () => ({
    reload() {
      const f = frameRef.current;
      if (!f) return;
      // Re-assigning src is the portable reload; touching contentWindow.location
      // throws on a cross-origin frame.
      const src = f.getAttribute("src");
      if (src) f.setAttribute("src", src);
    },
    injectJavaScript(js: string) {
      runInFrame(frameRef.current, js);
    },
  }));

  // Guest pages written for the native container post through
  // window.ReactNativeWebView.postMessage. Bridge that to onMessage so the
  // SAME guest code works in both places.
  useEffect(() => {
    if (!onMessage) return;
    const handler = (ev: MessageEvent) => {
      if (frameRef.current && ev.source !== frameRef.current.contentWindow) return;
      const data = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
      onMessage({ nativeEvent: { data } });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);

  const handleLoad = () => {
    const frame = frameRef.current;
    // Give the frame the postMessage shim, then run the injected probe. Both
    // require same-origin; a cross-origin frame simply skips them and the
    // caller's ready-probe never fires — which is the truthful outcome, not a
    // silent success.
    if (frame && injectedJavaScript) {
      const ran = runInFrame(
        frame,
        `window.ReactNativeWebView = window.ReactNativeWebView || { postMessage: function (m) { parent.postMessage(m, "*"); } };\n${injectedJavaScript}`,
      );
      if (!ran) {
        // Report the impossibility on the SAME channel the probe would have
        // used, so a caller that is waiting for a probe result gets an answer
        // instead of silence. It must stop gating on a signal that cannot come.
        onMessage?.({
          nativeEvent: {
            data: JSON.stringify({
              type: WEBVIEW_PROBE_UNSUPPORTED,
              reason: "cross-origin",
              detail:
                "the preview is served from a different origin than the app, so the browser forbids " +
                "injecting the ready-probe. The frame is rendering; readiness simply cannot be confirmed this way.",
            }),
          },
        });
      }
    }
    onLoadEnd?.();
  };

  const uri = source?.uri;
  const srcDoc = source?.html;

  return (
    <iframe
      ref={frameRef}
      src={uri}
      srcDoc={srcDoc}
      onLoad={handleLoad}
      onLoadStart={onLoadStart as any}
      onError={onError as any}
      title="preview"
      style={{ border: "none", width: "100%", height: "100%", background: "#000", ...(style || {}) }}
      allow="autoplay; clipboard-read; clipboard-write"
    />
  );
});

/** Returns true when the script actually ran. False means cross-origin. */
function runInFrame(frame: HTMLIFrameElement | null, js: string): boolean {
  if (!frame) return false;
  try {
    const win = frame.contentWindow as any;
    if (!win) return false;
    // Same-origin only. Cross-origin throws SecurityError by browser design.
    win.eval(js);
    return true;
  } catch {
    // SWALLOWING THIS WAS THE BUG. The old comment argued that a silent skip
    // "beats a fabricated ready" — true, and a false dichotomy. The third option
    // is to SAY SO, which is what the caller needs: with the probe unable to
    // fire, DevPreview waited forever on "The dev server reported ready. The
    // WebView has not confirmed the first rendered frame yet." while the iframe
    // was displaying the app perfectly. Measured 2026-08-05 driving sfmg on the
    // RN-web browser lane, where the app is served from :8099 and the bundle
    // from the box — cross-origin by construction, so the wait could NEVER end.
    return false;
  }
}

export default WebView;
