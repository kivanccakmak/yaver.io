/// Task status values returned by the agent.
enum TaskStatus { queued, running, ready, review, completed, failed, stopped }

/// A conversation turn within a task.
class Turn {
  final String role;
  final String content;
  final String? timestamp;

  Turn({required this.role, required this.content, this.timestamp});

  factory Turn.fromJson(Map<String, dynamic> json) => Turn(
        role: json['role'] as String,
        content: json['content'] as String,
        timestamp: json['timestamp'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'role': role,
        'content': content,
        if (timestamp != null) 'timestamp': timestamp,
      };
}

/// An image attachment for task creation or continuation.
class ImageAttachment {
  final String base64;
  final String mimeType;
  final String filename;

  ImageAttachment({
    required this.base64,
    required this.mimeType,
    required this.filename,
  });

  Map<String, dynamic> toJson() => {
        'base64': base64,
        'mimeType': mimeType,
        'filename': filename,
      };
}

/// Speech context metadata sent with task creation.
class SpeechContext {
  final bool? inputFromSpeech;
  final String? sttProvider;
  final bool? ttsEnabled;
  final String? ttsProvider;
  final int? verbosity;

  SpeechContext({
    this.inputFromSpeech,
    this.sttProvider,
    this.ttsEnabled,
    this.ttsProvider,
    this.verbosity,
  });

  Map<String, dynamic> toJson() => {
        if (inputFromSpeech != null) 'inputFromSpeech': inputFromSpeech,
        if (sttProvider != null) 'sttProvider': sttProvider,
        if (ttsEnabled != null) 'ttsEnabled': ttsEnabled,
        if (ttsProvider != null) 'ttsProvider': ttsProvider,
        if (verbosity != null) 'verbosity': verbosity,
      };
}

/// Options for creating a new task.
class CreateTaskOptions {
  final String? model;
  final String? runner;
  final String? customCommand;
  final SpeechContext? speechContext;
  final List<ImageAttachment>? images;

  CreateTaskOptions({
    this.model,
    this.runner,
    this.customCommand,
    this.speechContext,
    this.images,
  });
}

/// A task returned by the agent.
class Task {
  final String id;
  final String title;
  final TaskStatus status;
  final String? runnerId;
  final String? model;
  final String? reasoningEffort;
  final String? sessionId;
  final String? output;
  final String? resultText;
  final double? costUsd;
  final List<Turn>? turns;
  final String? source;
  final String? tmuxSession;
  final bool? isAdopted;
  final String createdAt;
  final String? startedAt;
  final String? finishedAt;

  Task({
    required this.id,
    required this.title,
    required this.status,
    this.runnerId,
    this.model,
    this.reasoningEffort,
    this.sessionId,
    this.output,
    this.resultText,
    this.costUsd,
    this.turns,
    this.source,
    this.tmuxSession,
    this.isAdopted,
    required this.createdAt,
    this.startedAt,
    this.finishedAt,
  });

  factory Task.fromJson(Map<String, dynamic> json) => Task(
        id: json['id'] as String,
        title: json['title'] as String,
        status: _parseStatus(json['status'] as String),
        runnerId: json['runnerId'] as String?,
        model: json['model'] as String?,
        reasoningEffort: json['reasoningEffort'] as String?,
        sessionId: json['sessionId'] as String?,
        output: json['output'] as String?,
        resultText: json['resultText'] as String?,
        costUsd: (json['costUsd'] as num?)?.toDouble(),
        turns: (json['turns'] as List?)
            ?.map((t) => Turn.fromJson(t as Map<String, dynamic>))
            .toList(),
        source: json['source'] as String?,
        tmuxSession: json['tmuxSession'] as String?,
        isAdopted: json['isAdopted'] as bool?,
        createdAt: json['createdAt'] as String,
        startedAt: json['startedAt'] as String?,
        finishedAt: json['finishedAt'] as String?,
      );

  static TaskStatus _parseStatus(String s) => switch (s) {
        'queued' => TaskStatus.queued,
        'running' => TaskStatus.running,
        'ready' => TaskStatus.ready,
        'review' => TaskStatus.review,
        'completed' => TaskStatus.completed,
        'failed' => TaskStatus.failed,
        'stopped' => TaskStatus.stopped,
        _ => TaskStatus.queued,
      };
}

class TaskRunnerReasoningEffort {
  final String reasoningEffort;
  final String? description;
  TaskRunnerReasoningEffort({required this.reasoningEffort, this.description});
  factory TaskRunnerReasoningEffort.fromJson(Map<String, dynamic> json) => TaskRunnerReasoningEffort(
        reasoningEffort: json['reasoningEffort'] as String,
        description: json['description'] as String?,
      );
}

class TaskRunnerControlModel {
  final String id;
  final String? name;
  final bool isDefault;
  final String? defaultReasoningEffort;
  final List<TaskRunnerReasoningEffort> supportedReasoningEfforts;
  TaskRunnerControlModel({required this.id, this.name, this.isDefault = false, this.defaultReasoningEffort, this.supportedReasoningEfforts = const []});
  factory TaskRunnerControlModel.fromJson(Map<String, dynamic> json) => TaskRunnerControlModel(
        id: json['id'] as String,
        name: json['name'] as String?,
        isDefault: json['isDefault'] == true,
        defaultReasoningEffort: json['defaultReasoningEffort'] as String?,
        supportedReasoningEfforts: (json['supportedReasoningEfforts'] as List? ?? const [])
            .map((item) => TaskRunnerReasoningEffort.fromJson(item as Map<String, dynamic>)).toList(),
      );
}

class TaskRunnerControlCatalog {
  final String taskId;
  final String runnerId;
  final String? model;
  final String? reasoningEffort;
  final List<TaskRunnerControlModel> models;
  final bool isAdopted;
  TaskRunnerControlCatalog({required this.taskId, required this.runnerId, this.model, this.reasoningEffort, required this.models, this.isAdopted = false});
  factory TaskRunnerControlCatalog.fromJson(Map<String, dynamic> json) => TaskRunnerControlCatalog(
        taskId: json['taskId'] as String,
        runnerId: json['runnerId'] as String,
        model: json['model'] as String?,
        reasoningEffort: json['reasoningEffort'] as String?,
        models: (json['models'] as List? ?? const []).map((item) => TaskRunnerControlModel.fromJson(item as Map<String, dynamic>)).toList(),
        isAdopted: json['isAdopted'] == true,
      );
}

/// Agent information returned by /info.
class AgentInfo {
  final String hostname;
  final String platform;
  final String agentVersion;
  final int runningTasks;
  final int totalTasks;

  AgentInfo({
    required this.hostname,
    required this.platform,
    required this.agentVersion,
    required this.runningTasks,
    required this.totalTasks,
  });

  factory AgentInfo.fromJson(Map<String, dynamic> json) => AgentInfo(
        hostname: json['hostname'] as String,
        platform: json['platform'] as String,
        agentVersion: json['agentVersion'] as String,
        runningTasks: json['runningTasks'] as int,
        totalTasks: json['totalTasks'] as int,
      );
}

/// User information from Convex auth.
class User {
  final String id;
  final String email;
  final String fullName;
  final String provider;
  final bool? surveyCompleted;

  User({
    required this.id,
    required this.email,
    required this.fullName,
    required this.provider,
    this.surveyCompleted,
  });

  factory User.fromJson(Map<String, dynamic> json) => User(
        id: json['id'] as String,
        email: json['email'] as String,
        fullName: json['fullName'] as String,
        provider: json['provider'] as String,
        surveyCompleted: json['surveyCompleted'] as bool?,
      );
}

/// A registered device.
class Device {
  final String deviceId;
  final String name;
  final String platform;
  final String quicHost;
  final int quicPort;
  final bool isOnline;
  final String lastHeartbeat;

  Device({
    required this.deviceId,
    required this.name,
    required this.platform,
    required this.quicHost,
    required this.quicPort,
    required this.isOnline,
    required this.lastHeartbeat,
  });

  factory Device.fromJson(Map<String, dynamic> json) => Device(
        deviceId: json['deviceId'] as String,
        name: json['name'] as String,
        platform: json['platform'] as String,
        quicHost: json['quicHost'] as String,
        quicPort: json['quicPort'] as int,
        isOnline: json['isOnline'] as bool,
        lastHeartbeat: json['lastHeartbeat'] as String,
      );
}

/// User settings stored in Convex.
class UserSettings {
  final bool? forceRelay;
  final String? runnerId;
  final String? customRunnerCommand;
  final String? speechProvider;
  final String? speechApiKey;
  final bool? ttsEnabled;
  final int? verbosity;

  UserSettings({
    this.forceRelay,
    this.runnerId,
    this.customRunnerCommand,
    this.speechProvider,
    this.speechApiKey,
    this.ttsEnabled,
    this.verbosity,
  });

  factory UserSettings.fromJson(Map<String, dynamic> json) => UserSettings(
        forceRelay: json['forceRelay'] as bool?,
        runnerId: json['runnerId'] as String?,
        customRunnerCommand: json['customRunnerCommand'] as String?,
        speechProvider: json['speechProvider'] as String?,
        speechApiKey: json['speechApiKey'] as String?,
        ttsEnabled: json['ttsEnabled'] as bool?,
        verbosity: json['verbosity'] as int?,
      );

  Map<String, dynamic> toJson() => {
        if (forceRelay != null) 'forceRelay': forceRelay,
        if (runnerId != null) 'runnerId': runnerId,
        if (customRunnerCommand != null)
          'customRunnerCommand': customRunnerCommand,
        if (speechProvider != null) 'speechProvider': speechProvider,
        if (speechApiKey != null) 'speechApiKey': speechApiKey,
        if (ttsEnabled != null) 'ttsEnabled': ttsEnabled,
        if (verbosity != null) 'verbosity': verbosity,
      };
}

/// Speech-to-text provider identifier.
enum SpeechProvider { onDevice, openai, deepgram, assemblyai }

/// Information about a speech provider.
class SpeechProviderInfo {
  final SpeechProvider id;
  final String name;
  final String description;
  final bool requiresKey;
  final String? keyPlaceholder;
  final String? keyHint;
  final String? pricePerMin;

  const SpeechProviderInfo({
    required this.id,
    required this.name,
    required this.description,
    required this.requiresKey,
    this.keyPlaceholder,
    this.keyHint,
    this.pricePerMin,
  });
}

/// Result of a speech transcription.
class TranscriptionResult {
  final String text;
  final int durationMs;
  final String provider;

  TranscriptionResult({
    required this.text,
    required this.durationMs,
    required this.provider,
  });
}

/// Result of agent cleanup.
class CleanResult {
  final int tasksRemoved;
  final int imagesRemoved;
  final int bytesFreed;

  CleanResult({
    required this.tasksRemoved,
    required this.imagesRemoved,
    required this.bytesFreed,
  });

  factory CleanResult.fromJson(Map<String, dynamic> json) => CleanResult(
        tasksRemoved: json['tasksRemoved'] as int,
        imagesRemoved: json['imagesRemoved'] as int,
        bytesFreed: json['bytesFreed'] as int,
      );
}

/// Status of an exec session.
enum ExecStatus { running, completed, failed, killed }

/// A remote command execution session.
class ExecSession {
  final String id;
  final String command;
  final ExecStatus status;
  final int? exitCode;
  final String stdout;
  final String stderr;
  final int? pid;
  final String startedAt;
  final String? finishedAt;

  ExecSession({
    required this.id,
    required this.command,
    required this.status,
    this.exitCode,
    required this.stdout,
    required this.stderr,
    this.pid,
    required this.startedAt,
    this.finishedAt,
  });

  factory ExecSession.fromJson(Map<String, dynamic> json) => ExecSession(
        id: json['id'] as String,
        command: json['command'] as String,
        status: _parseExecStatus(json['status'] as String),
        exitCode: json['exitCode'] as int?,
        stdout: json['stdout'] as String? ?? '',
        stderr: json['stderr'] as String? ?? '',
        pid: json['pid'] as int?,
        startedAt: json['startedAt'] as String,
        finishedAt: json['finishedAt'] as String?,
      );

  static ExecStatus _parseExecStatus(String s) => switch (s) {
        'running' => ExecStatus.running,
        'completed' => ExecStatus.completed,
        'failed' => ExecStatus.failed,
        'killed' => ExecStatus.killed,
        _ => ExecStatus.running,
      };
}

/// Options for starting a remote command.
class ExecOptions {
  final String? workDir;
  final int? timeout;
  final Map<String, String>? env;

  ExecOptions({this.workDir, this.timeout, this.env});
}
