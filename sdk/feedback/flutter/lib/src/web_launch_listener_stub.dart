/// Non-web stub. On mobile/desktop there is no browser window to listen on,
/// so registration is a no-op. The real implementation lives in
/// web_launch_listener_web.dart and is selected by a conditional import.
library;

/// Register a listener for Yaver's injected `yaver-feedback:launch` — no-op
/// off the web. Returns a disposer (also a no-op here).
void Function() registerWebLaunchListener(void Function() onLaunch) {
  return () {};
}
