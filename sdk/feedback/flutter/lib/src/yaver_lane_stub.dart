/// Non-web stub. A Flutter app only ever runs *inside* Yaver as flutter-web in
/// the browser-lane WebView (devserver_kind.go classes Flutter as
/// DevServerKindWeb), so off the web there is nothing to detect: a mobile or
/// desktop build is always the real installed app.
///
/// The real implementation lives in yaver_lane_web.dart and is selected by a
/// conditional import, the same pattern web_launch_listener_stub.dart uses.
library;

/// Which Yaver lane this app is running in. Always 'standalone' off the web.
String detectYaverLane() => 'standalone';
