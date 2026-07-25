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
      runInFrame(
        frame,
        `window.ReactNativeWebView = window.ReactNativeWebView || { postMessage: function (m) { parent.postMessage(m, "*"); } };\n${injectedJavaScript}`,
      );
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

function runInFrame(frame: HTMLIFrameElement | null, js: string) {
  if (!frame) return;
  try {
    const win = frame.contentWindow as any;
    if (!win) return;
    // Same-origin only. Cross-origin throws SecurityError, which we swallow on
    // purpose: the caller learns nothing ran because its probe never fires,
    // which beats a fabricated "ready".
    win.eval(js);
  } catch {
    /* cross-origin frame — cannot inject, by browser design */
  }
}

export default WebView;
