import 'package:flutter/material.dart';

import 'feedback.dart';

/// A draggable floating action button that triggers the Yaver feedback flow.
///
/// Place this in a [Stack] above your main app content, typically via the
/// [MaterialApp.builder]:
///
/// ```dart
/// MaterialApp(
///   builder: (context, child) => Stack(
///     children: [child!, const YaverFeedbackButton()],
///   ),
///   home: MyApp(),
/// );
/// ```
///
/// The button is only visible when [YaverFeedback.isEnabled] is `true`.
/// It can be dragged to any position on the screen.
class YaverFeedbackButton extends StatefulWidget {
  /// Initial horizontal offset from the right edge of the screen.
  final double initialRight;

  /// Initial vertical offset from the bottom edge of the screen.
  final double initialBottom;

  /// Size of the floating button.
  final double size;

  /// Background color of the button. Defaults to the theme's primary color.
  final Color? backgroundColor;

  /// Icon displayed on the button. Defaults to [Icons.bug_report].
  final IconData icon;

  /// Creates a new [YaverFeedbackButton].
  const YaverFeedbackButton({
    super.key,
    this.initialRight = 16,
    this.initialBottom = 100,
    this.size = 48,
    this.backgroundColor,
    this.icon = Icons.bug_report,
  });

  @override
  State<YaverFeedbackButton> createState() => _YaverFeedbackButtonState();
}

class _YaverFeedbackButtonState extends State<YaverFeedbackButton> {
  late double _right;
  late double _bottom;

  @override
  void initState() {
    super.initState();
    _right = widget.initialRight;
    _bottom = widget.initialBottom;
  }

  @override
  Widget build(BuildContext context) {
    if (!YaverFeedback.isInitialized || !YaverFeedback.isEnabled) {
      return const SizedBox.shrink();
    }

    return Positioned(
      right: _right,
      bottom: _bottom,
      child: GestureDetector(
        onPanUpdate: (details) {
          setState(() {
            _right -= details.delta.dx;
            _bottom -= details.delta.dy;

            // Clamp to screen bounds
            final size = MediaQuery.of(context).size;
            _right = _right.clamp(0, size.width - widget.size);
            _bottom = _bottom.clamp(0, size.height - widget.size);
          });
        },
        onTap: () {
          if (!YaverFeedback.isRecording) {
            YaverFeedback.startReport(context);
          }
        },
        child: Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: widget.backgroundColor ??
                Theme.of(context).colorScheme.primary,
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(0.3),
                blurRadius: 8,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Icon(
            widget.icon,
            color: Colors.white,
            size: widget.size * 0.5,
          ),
        ),
      ),
    );
  }
}
