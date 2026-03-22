import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'types.dart';

/// Yaver client — connects to a Yaver agent's HTTP API.
///
/// Works in Flutter (iOS, Android, Web, Desktop) and pure Dart.
///
/// ```dart
/// final client = YaverClient('http://localhost:18080', 'your-token');
/// final task = await client.createTask('Fix the login bug');
/// await for (final chunk in client.streamOutput(task.id)) {
///   stdout.write(chunk);
/// }
/// ```
class YaverClient {
  final String baseURL;
  final String authToken;
  final Duration timeout;
  final http.Client _httpClient;

  YaverClient(
    this.baseURL,
    this.authToken, {
    this.timeout = const Duration(seconds: 30),
    http.Client? httpClient,
  }) : _httpClient = httpClient ?? http.Client();

  /// Check if the agent is reachable.
  Future<Map<String, dynamic>> health() => _get('/health');

  /// Measure round-trip time in milliseconds.
  Future<int> ping() async {
    final sw = Stopwatch()..start();
    await health();
    return sw.elapsedMilliseconds;
  }

  /// Get agent status information.
  Future<AgentInfo> info() async {
    final result = await _get('/info');
    return AgentInfo.fromJson(result['info'] as Map<String, dynamic>);
  }

  /// Create a new task on the remote agent.
  Future<Task> createTask(String prompt, [CreateTaskOptions? opts]) async {
    final body = <String, dynamic>{'title': prompt};
    if (opts != null) {
      if (opts.model != null) body['model'] = opts.model;
      if (opts.runner != null) body['runner'] = opts.runner;
      if (opts.customCommand != null) body['customCommand'] = opts.customCommand;
      if (opts.speechContext != null) {
        body['speechContext'] = opts.speechContext!.toJson();
      }
      if (opts.images != null && opts.images!.isNotEmpty) {
        body['images'] = opts.images!.map((i) => i.toJson()).toList();
      }
    }

    final result = await _post('/tasks', body);
    if (result['ok'] != true) {
      throw YaverException(result['error'] as String? ?? 'Failed to create task');
    }

    return Task(
      id: result['taskId'] as String,
      title: prompt,
      status: TaskStatus.values.firstWhere(
        (s) => s.name == result['status'],
        orElse: () => TaskStatus.queued,
      ),
      runnerId: result['runnerId'] as String?,
      createdAt: DateTime.now().toIso8601String(),
    );
  }

  /// Get task details by ID.
  Future<Task> getTask(String taskId) async {
    final result = await _get('/tasks/$taskId');
    return Task.fromJson(result['task'] as Map<String, dynamic>);
  }

  /// List all tasks.
  Future<List<Task>> listTasks() async {
    final result = await _get('/tasks');
    return (result['tasks'] as List)
        .map((t) => Task.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  /// Stop a running task.
  Future<void> stopTask(String taskId) async {
    final result = await _post('/tasks/$taskId/stop');
    if (result['ok'] != true) {
      throw YaverException(result['error'] as String? ?? 'Failed to stop task');
    }
  }

  /// Delete a task.
  Future<void> deleteTask(String taskId) => _delete('/tasks/$taskId');

  /// Send a follow-up message to a running task.
  Future<void> continueTask(
    String taskId,
    String message, [
    List<ImageAttachment>? images,
  ]) async {
    final body = <String, dynamic>{'input': message};
    if (images != null && images.isNotEmpty) {
      body['images'] = images.map((i) => i.toJson()).toList();
    }
    final result = await _post('/tasks/$taskId/continue', body);
    if (result['ok'] != true) {
      throw YaverException(
          result['error'] as String? ?? 'Failed to continue task');
    }
  }

  /// Clean up old tasks, images, and logs on the agent.
  Future<CleanResult> clean({int days = 30}) async {
    final result = await _post('/agent/clean', {'days': days});
    return CleanResult.fromJson(result['result'] as Map<String, dynamic>);
  }

  /// Stream task output. Yields new output chunks as they arrive.
  Stream<String> streamOutput(
    String taskId, {
    Duration pollInterval = const Duration(milliseconds: 500),
  }) async* {
    var lastLen = 0;
    while (true) {
      final task = await getTask(taskId);
      final output = task.output ?? '';
      if (output.length > lastLen) {
        yield output.substring(lastLen);
        lastLen = output.length;
      }
      if (task.status == TaskStatus.completed ||
          task.status == TaskStatus.failed ||
          task.status == TaskStatus.stopped) {
        return;
      }
      await Future.delayed(pollInterval);
    }
  }

  /// Start a command on the remote agent.
  Future<({String execId, int pid})> startExec(
    String command, [
    ExecOptions? opts,
  ]) async {
    final body = <String, dynamic>{'command': command};
    if (opts?.workDir != null) body['workDir'] = opts!.workDir;
    if (opts?.timeout != null) body['timeout'] = opts!.timeout;
    if (opts?.env != null) body['env'] = opts!.env;
    final result = await _post('/exec', body);
    if (result['ok'] != true) {
      throw YaverException(result['error'] as String? ?? 'Failed to start exec');
    }
    return (execId: result['execId'] as String, pid: (result['pid'] as num).toInt());
  }

  /// Get exec session details.
  Future<ExecSession> getExec(String execId) async {
    final result = await _get('/exec/$execId');
    return ExecSession.fromJson(result['exec'] as Map<String, dynamic>);
  }

  /// List all exec sessions.
  Future<List<ExecSession>> listExecs() async {
    final result = await _get('/exec');
    return (result['execs'] as List)
        .map((e) => ExecSession.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Send stdin input to a running exec session.
  Future<void> sendExecInput(String execId, String input) =>
      _post('/exec/$execId/input', {'input': input});

  /// Send a signal to a running exec session.
  Future<void> signalExec(String execId, String signal) =>
      _post('/exec/$execId/signal', {'signal': signal});

  /// Kill and remove an exec session.
  Future<void> killExec(String execId) => _delete('/exec/$execId');

  /// Stream exec output. Yields stdout/stderr chunks as they arrive.
  Stream<({String type, String text})> streamExecOutput(
    String execId, {
    Duration pollInterval = const Duration(milliseconds: 300),
  }) async* {
    var lastStdoutLen = 0;
    var lastStderrLen = 0;
    while (true) {
      final exec = await getExec(execId);
      if (exec.stdout.length > lastStdoutLen) {
        yield (type: 'stdout', text: exec.stdout.substring(lastStdoutLen));
        lastStdoutLen = exec.stdout.length;
      }
      if (exec.stderr.length > lastStderrLen) {
        yield (type: 'stderr', text: exec.stderr.substring(lastStderrLen));
        lastStderrLen = exec.stderr.length;
      }
      if (exec.status == ExecStatus.completed ||
          exec.status == ExecStatus.failed ||
          exec.status == ExecStatus.killed) {
        return;
      }
      await Future.delayed(pollInterval);
    }
  }

  /// Close the underlying HTTP client.
  void close() => _httpClient.close();

  // ── HTTP helpers ─────────────────────────────────────────────────

  Map<String, String> get _headers => {
        'Authorization': 'Bearer $authToken',
      };

  Future<Map<String, dynamic>> _get(String path) async {
    final url = Uri.parse('$baseURL$path');
    final resp = await _httpClient.get(url, headers: _headers).timeout(timeout);
    if (resp.statusCode >= 400) {
      throw YaverException('HTTP ${resp.statusCode}: ${resp.body}');
    }
    return jsonDecode(resp.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> _post(String path,
      [Map<String, dynamic>? body]) async {
    final url = Uri.parse('$baseURL$path');
    final headers = <String, String>{..._headers};
    String? encodedBody;
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      encodedBody = jsonEncode(body);
    }
    final resp = await _httpClient
        .post(url, headers: headers, body: encodedBody)
        .timeout(timeout);
    if (resp.statusCode >= 400) {
      throw YaverException('HTTP ${resp.statusCode}: ${resp.body}');
    }
    return jsonDecode(resp.body) as Map<String, dynamic>;
  }

  Future<void> _delete(String path) async {
    final url = Uri.parse('$baseURL$path');
    final resp =
        await _httpClient.delete(url, headers: _headers).timeout(timeout);
    if (resp.statusCode >= 400) {
      throw YaverException('HTTP ${resp.statusCode}');
    }
  }
}

/// Exception thrown by [YaverClient] on errors.
class YaverException implements Exception {
  final String message;
  YaverException(this.message);

  @override
  String toString() => 'YaverException: $message';
}
