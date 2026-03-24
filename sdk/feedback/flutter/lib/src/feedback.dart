import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'discovery.dart';
import 'feedback_overlay.dart';
import 'p2p_client.dart';
import 'types.dart';
import 'upload.dart';

/// Main entry point for the Yaver Feedback SDK.
///
/// Initialize once in your app's `main()` function, then use [startReport]
/// to open the feedback overlay or let [YaverFeedbackButton] handle it.
///
/// The SDK supports three feedback modes:
/// - [FeedbackMode.narrated] (default): collect events, narrate, then send.
/// - [FeedbackMode.live]: stream events to the agent in real-time.
/// - [FeedbackMode.batch]: collect events silently and upload as a batch.
///
/// If no `agentUrl` is provided in the config, the SDK will auto-discover
/// agents on the local network via [YaverDiscovery].
///
/// ```dart
/// import 'package:yaver_feedback/yaver_feedback.dart';
///
/// void main() {
///   if (kDebugMode) {
///     YaverFeedback.init(FeedbackConfig(
///       agentUrl: 'http://192.168.1.100:18080',
///       authToken: 'your-token',
///       mode: FeedbackMode.narrated,
///       agentCommentaryLevel: 5,
///     ));
///   }
///   runApp(MyApp());
/// }
/// ```
class YaverFeedback {
  YaverFeedback._();

  static FeedbackConfig? _config;
  static bool _isRecording = false;
  static GlobalKey? _repaintBoundaryKey;
  static P2PClient? _client;
  static StreamController<String>? _commentaryController;

  /// Initializes the feedback SDK with the given [config].
  ///
  /// Call this once at app startup, typically guarded by `kDebugMode`.
  /// If [FeedbackConfig.agentUrl] is empty, the SDK will attempt
  /// auto-discovery when a report is started.
  static void init(FeedbackConfig config) {
    _config = config;
    _commentaryController = StreamController<String>.broadcast();

    // Create P2PClient if we have a URL
    if (config.agentUrl.isNotEmpty) {
      _client = P2PClient(
        baseUrl: config.agentUrl,
        authToken: config.authToken,
      );
    }
  }

  /// Whether [init] has been called.
  static bool get isInitialized => _config != null;

  /// Whether feedback collection is currently enabled.
  ///
  /// Returns `false` if not initialized.
  static bool get isEnabled => _config?.enabled ?? false;

  /// Whether a feedback report is currently being recorded.
  static bool get isRecording => _isRecording;

  /// The current feedback mode, or `null` if not initialized.
  static FeedbackMode? get mode => _config?.mode;

  /// The current P2P client, if connected.
  static P2PClient? get client => _client;

  /// Stream of agent commentary messages.
  ///
  /// Subscribe to receive real-time commentary from the agent.
  static Stream<String>? get commentaryStream => _commentaryController?.stream;

  /// Enables or disables feedback collection at runtime.
  ///
  /// Throws [StateError] if [init] has not been called.
  static void setEnabled(bool enabled) {
    if (_config == null) {
      throw StateError('YaverFeedback.init() must be called before setEnabled');
    }
    _config = _config!.copyWith(enabled: enabled);
  }

  /// Sets the [GlobalKey] for the app's [RepaintBoundary] used to capture
  /// screenshots.
  ///
  /// If not set, screenshot capture will not be available.
  static void setRepaintBoundaryKey(GlobalKey key) {
    _repaintBoundaryKey = key;
  }

  /// Ensures a P2P connection is available, using auto-discovery if needed.
  ///
  /// Returns `true` if a connection is available, `false` otherwise.
  static Future<bool> ensureConnected() async {
    if (_config == null) return false;

    // Already connected — verify health
    if (_client != null) {
      if (await _client!.health()) return true;
      _client!.dispose();
      _client = null;
    }

    // Try auto-discovery
    final result = await YaverDiscovery.discover();
    if (result != null) {
      _client = P2PClient(
        baseUrl: result.url,
        authToken: _config!.authToken,
      );
      _config = _config!.copyWith(agentUrl: result.url);
      return true;
    }

    return false;
  }

  /// Manually connect to a specific agent URL.
  ///
  /// Returns the [DiscoveryResult] if successful, `null` otherwise.
  static Future<DiscoveryResult?> connectTo(String url) async {
    if (_config == null) {
      throw StateError(
          'YaverFeedback.init() must be called before connectTo');
    }

    final result = await YaverDiscovery.connect(url);
    if (result != null) {
      _client?.dispose();
      _client = P2PClient(
        baseUrl: result.url,
        authToken: _config!.authToken,
      );
      _config = _config!.copyWith(agentUrl: result.url);
    }
    return result;
  }

  /// Opens the feedback overlay as a modal bottom sheet.
  ///
  /// In [FeedbackMode.live] mode, events are streamed to the agent in
  /// real-time. In [FeedbackMode.narrated] mode (default), the user
  /// captures events and narrates before sending. In [FeedbackMode.batch]
  /// mode, events are collected silently.
  ///
  /// If no agent URL is configured, auto-discovery is attempted first.
  ///
  /// Returns `true` if the feedback was sent, `false` if cancelled.
  ///
  /// Throws [StateError] if not initialized or not enabled.
  static Future<bool> startReport(BuildContext context) async {
    if (_config == null) {
      throw StateError(
          'YaverFeedback.init() must be called before startReport');
    }
    if (!_config!.enabled) return false;
    if (_isRecording) return false;

    // Auto-discover if no URL configured
    if (_config!.agentUrl.isEmpty || _client == null) {
      final connected = await ensureConnected();
      if (!connected) {
        debugPrint('YaverFeedback: no agent found, cannot start report');
        return false;
      }
    }

    _isRecording = true;

    try {
      final result = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (context) => FeedbackOverlay(
          repaintBoundaryKey: _repaintBoundaryKey,
          agentUrl: _config!.agentUrl,
          authToken: _config!.authToken,
          maxRecordingDuration: _config!.maxRecordingDuration,
        ),
      );
      return result ?? false;
    } finally {
      _isRecording = false;
    }
  }

  /// Sends a single event to the agent in live mode.
  ///
  /// Only works when [mode] is [FeedbackMode.live] and a connection exists.
  static Future<void> streamEvent(Map<String, dynamic> event) async {
    if (_config?.mode != FeedbackMode.live) return;
    if (_client == null) return;

    try {
      await _client!.streamEvent(event);
    } catch (e) {
      debugPrint('YaverFeedback: stream event failed: $e');
    }
  }

  /// Displays an agent commentary message in the overlay.
  static void showCommentary(String message) {
    _commentaryController?.add(message);
  }

  /// Captures a screenshot of the current screen programmatically.
  ///
  /// Requires [setRepaintBoundaryKey] to have been called with a key
  /// wrapping the widget tree.
  ///
  /// In [FeedbackMode.live] mode, the screenshot event is also streamed
  /// to the agent.
  ///
  /// Returns the file path of the saved PNG, or `null` if capture failed.
  static Future<String?> captureScreenshot() async {
    if (_repaintBoundaryKey?.currentContext == null) return null;

    try {
      final boundary = _repaintBoundaryKey!.currentContext!
          .findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 2.0);
      final byteData = await image.toByteData(format: ui.ImageByteFormat.png);

      if (byteData == null) return null;

      final tempDir = Directory.systemTemp;
      final timestamp = DateTime.now().millisecondsSinceEpoch;
      final path = '${tempDir.path}/yaver_screenshot_$timestamp.png';
      final file = File(path);
      await file.writeAsBytes(byteData.buffer.asUint8List());

      // In live mode, stream the screenshot event
      if (_config?.mode == FeedbackMode.live && _client != null) {
        await streamEvent({
          'type': 'screenshot',
          'filePath': path,
          'timestamp': timestamp,
        });
      }

      return path;
    } catch (e) {
      debugPrint('YaverFeedback: screenshot capture failed: $e');
      return null;
    }
  }

  /// Uploads a pre-built [FeedbackBundle] to the Yaver agent.
  ///
  /// Uses [P2PClient] if available, otherwise falls back to direct upload.
  ///
  /// Returns the feedback report ID assigned by the agent.
  ///
  /// Throws [StateError] if not initialized.
  static Future<String> uploadFeedback(FeedbackBundle bundle) async {
    if (_config == null) {
      throw StateError(
          'YaverFeedback.init() must be called before uploadFeedback');
    }

    // Prefer P2PClient
    if (_client != null) {
      return _client!.uploadFeedback(bundle);
    }

    // Fallback to direct upload
    return uploadFeedbackBundle(
      _config!.agentUrl,
      _config!.authToken,
      bundle,
    );
  }

  /// Cleans up resources. Call when the SDK is no longer needed.
  static void dispose() {
    _client?.dispose();
    _client = null;
    _commentaryController?.close();
    _commentaryController = null;
    _config = null;
    _isRecording = false;
  }
}
