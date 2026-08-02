/// The polite "you're running inside Yaver" mark for Flutter apps.
///
/// ── Why a Flutter app needs this ────────────────────────────────────────────
///
/// A Flutter app previewed through Yaver runs as flutter-web in the browser
/// lane and looks exactly like the real thing. Testers have chased "bugs" that
/// were only unbuilt work, and have been unable to find their way back to the
/// installed app because nothing on screen said there was anywhere to go.
///
/// So: one small Y, low contrast, in a corner. Tapping it says what you're in
/// and how to leave. Nothing else — the surface belongs to the app being
/// previewed, and this earns a few pixels and no more.
///
/// ── What it is NOT ──────────────────────────────────────────────────────────
///
/// It is NOT the escape. Yaver's host owns that (shake → overlay). This badge
/// only tells you the gesture exists. Making it the exit would put the way out
/// inside the previewed app, where the app could paint over it — the trap the
/// escape-ownership rules exist to prevent.
library;

import 'package:flutter/material.dart';

import 'yaver_lane_stub.dart' if (dart.library.html) 'yaver_lane_web.dart';

/// Corner for [YaverModeBadge].
enum YaverModeBadgeCorner {
  /// Default. Bottom-right is where [YaverFeedbackButton] sits, and the two
  /// must not overlap.
  bottomLeft,
  bottomRight,
  topLeft,
  topRight,
}

/// A small "Y" shown only while this app is running inside Yaver.
///
/// Place it in the same [Stack] as [YaverFeedbackButton]:
///
/// ```dart
/// MaterialApp(
///   builder: (context, child) => Stack(
///     children: [child!, const YaverFeedbackButton(), const YaverModeBadge()],
///   ),
/// );
/// ```
///
/// Renders [SizedBox.shrink] in a normal build, so leaving it in costs your
/// real users nothing.
class YaverModeBadge extends StatelessWidget {
  /// Which corner to sit in.
  final YaverModeBadgeCorner corner;

  /// Render even outside Yaver. Development aid only — the badge is meaningless
  /// in a standalone build and would be wallpaper.
  final bool force;

  /// Creates the badge.
  const YaverModeBadge({
    super.key,
    this.corner = YaverModeBadgeCorner.bottomLeft,
    this.force = false,
  });

  static const Color _accent = Color(0xFF7C5CFF);

  @override
  Widget build(BuildContext context) {
    final lane = detectYaverLane();
    if (!force && lane == 'standalone') return const SizedBox.shrink();

    final positioned = switch (corner) {
      YaverModeBadgeCorner.bottomLeft => const (bottom: 28.0, left: 12.0, top: null, right: null),
      YaverModeBadgeCorner.bottomRight => const (bottom: 28.0, left: null, top: null, right: 12.0),
      YaverModeBadgeCorner.topLeft => const (bottom: null, left: 12.0, top: 44.0, right: null),
      YaverModeBadgeCorner.topRight => const (bottom: null, left: null, top: 44.0, right: 12.0),
    };

    return Positioned(
      top: positioned.top,
      bottom: positioned.bottom,
      left: positioned.left,
      right: positioned.right,
      child: Semantics(
        button: true,
        label: 'Running inside Yaver',
        child: GestureDetector(
          onTap: () => _explain(context, lane),
          child: Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _accent.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: _accent.withValues(alpha: 0.45)),
            ),
            child: const Text(
              'Y',
              style: TextStyle(
                color: _accent,
                fontSize: 12,
                height: 1.0,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _explain(BuildContext context, String lane) {
    final detail = lane == 'browser'
        ? 'This is a Yaver preview of your app, served from your box — not the version '
            'installed on this device. Anything unfinished here is work in progress, '
            'not a released bug.'
        : 'This app is running inside Yaver rather than as the build you installed.';
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Row(
          children: [
            Text('Y', style: TextStyle(color: _accent, fontWeight: FontWeight.w800)),
            SizedBox(width: 8),
            Flexible(child: Text('Running inside Yaver')),
          ],
        ),
        content: Text(
          '$detail\n\nUse Yaver\'s own controls — shake the device, or close the '
          'preview — to return to the installed app.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Close')),
        ],
      ),
    );
  }
}
