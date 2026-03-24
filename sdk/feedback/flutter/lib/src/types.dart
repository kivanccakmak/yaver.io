/// How the feedback report was triggered.
enum FeedbackTrigger {
  /// Triggered by shaking the device.
  shake,

  /// Triggered via the floating action button.
  floatingButton,

  /// Triggered programmatically via [YaverFeedback.startReport].
  manual,
}

/// Feedback delivery mode.
enum FeedbackMode {
  /// Events are streamed to the agent in real-time as they occur.
  live,

  /// Events are collected locally and the user narrates before sending.
  /// This is the default mode.
  narrated,

  /// Events are collected silently and uploaded as a batch.
  batch,
}

/// Configuration for the Yaver Feedback SDK.
class FeedbackConfig {
  /// The URL of the Yaver agent HTTP server (e.g. `http://192.168.1.100:18080`).
  final String agentUrl;

  /// Auth token for the Yaver agent.
  final String authToken;

  /// How to trigger the feedback flow.
  final FeedbackTrigger trigger;

  /// Whether feedback collection is enabled.
  final bool enabled;

  /// Maximum voice recording duration in seconds.
  final int maxRecordingDuration;

  /// Feedback delivery mode. Defaults to [FeedbackMode.narrated].
  final FeedbackMode mode;

  /// Agent commentary verbosity level (0-10).
  ///
  /// `0` disables commentary, `10` shows everything. Default is `5`.
  final int agentCommentaryLevel;

  /// Creates a new [FeedbackConfig].
  const FeedbackConfig({
    required this.agentUrl,
    required this.authToken,
    this.trigger = FeedbackTrigger.floatingButton,
    this.enabled = true,
    this.maxRecordingDuration = 60,
    this.mode = FeedbackMode.narrated,
    this.agentCommentaryLevel = 5,
  });

  /// Returns a copy of this config with the given fields replaced.
  FeedbackConfig copyWith({
    String? agentUrl,
    String? authToken,
    FeedbackTrigger? trigger,
    bool? enabled,
    int? maxRecordingDuration,
    FeedbackMode? mode,
    int? agentCommentaryLevel,
  }) {
    return FeedbackConfig(
      agentUrl: agentUrl ?? this.agentUrl,
      authToken: authToken ?? this.authToken,
      trigger: trigger ?? this.trigger,
      enabled: enabled ?? this.enabled,
      maxRecordingDuration: maxRecordingDuration ?? this.maxRecordingDuration,
      mode: mode ?? this.mode,
      agentCommentaryLevel:
          agentCommentaryLevel ?? this.agentCommentaryLevel,
    );
  }
}

/// A single event in the feedback timeline.
class TimelineEvent {
  /// Timestamp in seconds from the start of the feedback session.
  final double time;

  /// Event type: `"voice"`, `"screenshot"`, or `"annotation"`.
  final String type;

  /// Optional text content (e.g. annotation text or transcription).
  final String? text;

  /// Optional path to an associated file (screenshot image, audio clip).
  final String? filePath;

  /// Creates a new [TimelineEvent].
  const TimelineEvent({
    required this.time,
    required this.type,
    this.text,
    this.filePath,
  });

  /// Deserializes a [TimelineEvent] from a JSON map.
  factory TimelineEvent.fromJson(Map<String, dynamic> json) => TimelineEvent(
        time: (json['time'] as num).toDouble(),
        type: json['type'] as String,
        text: json['text'] as String?,
        filePath: json['filePath'] as String?,
      );

  /// Serializes this event to a JSON map.
  Map<String, dynamic> toJson() => {
        'time': time,
        'type': type,
        if (text != null) 'text': text,
        if (filePath != null) 'filePath': filePath,
      };
}

/// Information about the device that generated the feedback.
class DeviceInfo {
  /// Platform identifier (e.g. `"ios"`, `"android"`).
  final String platform;

  /// Device model (e.g. `"iPhone 15 Pro"`, `"Pixel 8"`).
  final String model;

  /// OS version string (e.g. `"17.4"`, `"14"`).
  final String osVersion;

  /// Optional application name.
  final String? appName;

  /// Creates a new [DeviceInfo].
  const DeviceInfo({
    required this.platform,
    required this.model,
    required this.osVersion,
    this.appName,
  });

  /// Deserializes a [DeviceInfo] from a JSON map.
  factory DeviceInfo.fromJson(Map<String, dynamic> json) => DeviceInfo(
        platform: json['platform'] as String,
        model: json['model'] as String,
        osVersion: json['osVersion'] as String,
        appName: json['appName'] as String?,
      );

  /// Serializes this info to a JSON map.
  Map<String, dynamic> toJson() => {
        'platform': platform,
        'model': model,
        'osVersion': osVersion,
        if (appName != null) 'appName': appName,
      };
}

/// A complete feedback report bundle ready for upload.
class FeedbackBundle {
  /// Arbitrary metadata (e.g. user ID, app version, screen name).
  final Map<String, dynamic> metadata;

  /// Path to a screen recording video, if captured.
  final String? videoPath;

  /// Path to a voice annotation audio file, if recorded.
  final String? audioPath;

  /// Paths to captured screenshots.
  final List<String> screenshotPaths;

  /// Chronological timeline of feedback events.
  final List<TimelineEvent> timeline;

  /// Device information.
  final DeviceInfo deviceInfo;

  /// Creates a new [FeedbackBundle].
  const FeedbackBundle({
    required this.metadata,
    this.videoPath,
    this.audioPath,
    this.screenshotPaths = const [],
    this.timeline = const [],
    required this.deviceInfo,
  });

  /// Serializes this bundle's metadata to a JSON map.
  ///
  /// File paths are included as references; actual files are uploaded
  /// separately via multipart request.
  Map<String, dynamic> toJson() => {
        'metadata': metadata,
        if (videoPath != null) 'videoPath': videoPath,
        if (audioPath != null) 'audioPath': audioPath,
        'screenshotPaths': screenshotPaths,
        'timeline': timeline.map((e) => e.toJson()).toList(),
        'deviceInfo': deviceInfo.toJson(),
      };
}
