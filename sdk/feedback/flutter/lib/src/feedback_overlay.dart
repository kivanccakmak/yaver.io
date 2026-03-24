import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'types.dart';
import 'upload.dart';

/// Overlay UI for collecting feedback — screenshots, voice notes, and
/// a timeline of captured items.
///
/// Shown as a bottom sheet when the user triggers a feedback report.
class FeedbackOverlay extends StatefulWidget {
  /// The global key wrapping the app's [RepaintBoundary] for screenshots.
  final GlobalKey? repaintBoundaryKey;

  /// Agent URL for uploading the feedback bundle.
  final String agentUrl;

  /// Auth token for the Yaver agent.
  final String authToken;

  /// Maximum voice recording duration in seconds.
  final int maxRecordingDuration;

  /// Creates a new [FeedbackOverlay].
  const FeedbackOverlay({
    super.key,
    this.repaintBoundaryKey,
    required this.agentUrl,
    required this.authToken,
    this.maxRecordingDuration = 60,
  });

  @override
  State<FeedbackOverlay> createState() => _FeedbackOverlayState();
}

class _FeedbackOverlayState extends State<FeedbackOverlay> {
  final List<TimelineEvent> _timeline = [];
  final List<String> _screenshotPaths = [];
  bool _isRecording = false;
  bool _isSending = false;
  String? _audioPath;
  final Stopwatch _sessionTimer = Stopwatch();

  @override
  void initState() {
    super.initState();
    _sessionTimer.start();
  }

  @override
  void dispose() {
    _sessionTimer.stop();
    super.dispose();
  }

  double get _elapsedSeconds => _sessionTimer.elapsedMilliseconds / 1000.0;

  Future<void> _captureScreenshot() async {
    try {
      if (widget.repaintBoundaryKey?.currentContext == null) {
        _addAnnotation('Screenshot failed: no repaint boundary available');
        return;
      }

      final boundary = widget.repaintBoundaryKey!.currentContext!
          .findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 2.0);
      final byteData = await image.toByteData(format: ui.ImageByteFormat.png);

      if (byteData == null) return;

      final tempDir = Directory.systemTemp;
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      final path = '${tempDir.path}/yaver_screenshot_$timestamp.png';
      final file = File(path);
      await file.writeAsBytes(byteData.buffer.asUint8List());

      setState(() {
        _screenshotPaths.add(path);
        _timeline.add(TimelineEvent(
          time: _elapsedSeconds,
          type: 'screenshot',
          filePath: path,
        ));
      });
    } catch (e) {
      _addAnnotation('Screenshot error: $e');
    }
  }

  void _toggleRecording() {
    setState(() {
      if (_isRecording) {
        // Stop recording — in a real implementation, this would stop the
        // audio recorder and save the file path.
        _isRecording = false;
        _timeline.add(TimelineEvent(
          time: _elapsedSeconds,
          type: 'voice',
          text: 'Voice note recorded',
          filePath: _audioPath,
        ));
      } else {
        // Start recording — stub for audio recording integration.
        // Integrate with record, audio_recorder, or similar package.
        _isRecording = true;
        debugPrint(
          'FeedbackOverlay: voice recording started '
          '(integrate audio recorder package for real recording)',
        );
      }
    });
  }

  void _addAnnotation(String text) {
    setState(() {
      _timeline.add(TimelineEvent(
        time: _elapsedSeconds,
        type: 'annotation',
        text: text,
      ));
    });
  }

  Future<void> _sendFeedback() async {
    setState(() => _isSending = true);

    try {
      final bundle = FeedbackBundle(
        metadata: {
          'sessionDuration': _elapsedSeconds,
          'capturedAt': DateTime.now().toIso8601String(),
        },
        audioPath: _audioPath,
        screenshotPaths: _screenshotPaths,
        timeline: _timeline,
        deviceInfo: DeviceInfo(
          platform: Platform.operatingSystem,
          model: Platform.localHostname,
          osVersion: Platform.operatingSystemVersion,
        ),
      );

      await uploadFeedbackBundle(
        widget.agentUrl,
        widget.authToken,
        bundle,
      );

      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to send feedback: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Feedback Report',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.of(context).pop(false),
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Action buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              // Screenshot button
              _ActionButton(
                icon: Icons.camera_alt,
                label: 'Screenshot',
                onPressed: _isSending ? null : _captureScreenshot,
              ),
              // Voice note button
              _ActionButton(
                icon: _isRecording ? Icons.stop : Icons.mic,
                label: _isRecording ? 'Stop' : 'Voice',
                color: _isRecording ? Colors.red : null,
                onPressed: _isSending ? null : _toggleRecording,
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Timeline
          if (_timeline.isNotEmpty) ...[
            Text(
              'Timeline (${_timeline.length} events)',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 200),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: _timeline.length,
                itemBuilder: (context, index) {
                  final event = _timeline[index];
                  return ListTile(
                    dense: true,
                    leading: Icon(
                      event.type == 'screenshot'
                          ? Icons.image
                          : event.type == 'voice'
                              ? Icons.mic
                              : Icons.note,
                      size: 18,
                    ),
                    title: Text(
                      '${event.time.toStringAsFixed(1)}s — ${event.type}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    subtitle: event.text != null
                        ? Text(
                            event.text!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          )
                        : null,
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
          ],

          // Recording indicator
          if (_isRecording)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Colors.red,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Text('Recording...'),
                ],
              ),
            ),

          // Send / Cancel buttons
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _isSending
                      ? null
                      : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _isSending ? null : _sendFeedback,
                  icon: _isSending
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send),
                  label: Text(_isSending ? 'Sending...' : 'Send'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A compact action button used in the feedback overlay.
class _ActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color? color;
  final VoidCallback? onPressed;

  const _ActionButton({
    required this.icon,
    required this.label,
    this.color,
    this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton.filled(
          onPressed: onPressed,
          icon: Icon(icon),
          color: color,
          iconSize: 28,
        ),
        const SizedBox(height: 4),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}
