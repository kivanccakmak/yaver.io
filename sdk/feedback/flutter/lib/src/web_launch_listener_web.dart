/// Web implementation. When a Flutter app runs as flutter-web in Yaver's
/// browser-lane WebView, the phone's shake can't reach the Flutter canvas —
/// so Yaver forwards it by dispatching a `yaver-feedback:launch` event (and
/// calling `window.__yaverFeedbackLaunch`) into the WebView (mobile
/// DevPreview/apps.tsx). This bridges that JS event to the Dart feedback flow,
/// so shake-to-report works in the browser lane exactly like the web/RN SDKs.
/// See docs/audits/feedback-sdk-lanes-audit-2026-07-28.md.
library;

import 'dart:html' as html;
import 'dart:js' as js;

/// Wire the injected browser-lane launch signal to [onLaunch]. Returns a
/// disposer that removes the listeners.
void Function() registerWebLaunchListener(void Function() onLaunch) {
  void handler(html.Event _) => onLaunch();
  html.window.addEventListener('yaver-feedback:launch', handler);
  // Some hosts also postMessage the signal; accept that shape too.
  void onMessage(html.Event e) {
    if (e is html.MessageEvent) {
      final data = e.data;
      if (data is Map && data['type'] == 'yaver-feedback:launch') onLaunch();
    }
  }
  html.window.addEventListener('message', onMessage);
  // And the direct hook the host calls via injectJavaScript.
  js.context['__yaverFeedbackLaunch'] = js.allowInterop((_) => onLaunch());
  return () {
    html.window.removeEventListener('yaver-feedback:launch', handler);
    html.window.removeEventListener('message', onMessage);
  };
}
