/// Web implementation. Yaver injects `window.__yaverLane` into the WebView
/// before the app boots, which is the same signal the JS SDK reads
/// (YaverFeedback.detectLane). One source of truth per lane, rather than each
/// SDK inventing its own probe.
library;

import 'dart:js' as js;

/// Returns 'browser', 'webrtc', 'hermes', or 'standalone'.
///
/// Fails CLOSED to 'standalone': if we cannot read the flag we must assume the
/// app is the real one, because claiming "you're in a preview" on someone's
/// production site is worse than staying quiet.
String detectYaverLane() {
  try {
    final lane = js.context['__yaverLane'];
    final value = lane?.toString().toLowerCase() ?? '';
    if (value == 'browser' || value == 'webrtc' || value == 'hermes') return value;
  } catch (_) {
    // No JS context / blocked — treat as standalone.
  }
  return 'standalone';
}
