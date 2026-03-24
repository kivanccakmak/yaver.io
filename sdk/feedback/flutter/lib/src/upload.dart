import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'types.dart';

/// Uploads a [FeedbackBundle] as a multipart POST to the Yaver agent.
///
/// Attaches video, audio, and screenshot files as multipart file fields,
/// and includes metadata as a JSON string field.
///
/// Returns the feedback report ID assigned by the agent.
///
/// Throws an [HttpException] if the server returns a non-2xx status.
Future<String> uploadFeedbackBundle(
  String agentUrl,
  String authToken,
  FeedbackBundle bundle,
) async {
  final uri = Uri.parse('$agentUrl/feedback');
  final request = http.MultipartRequest('POST', uri);

  // Auth header
  request.headers['Authorization'] = 'Bearer $authToken';

  // Metadata as JSON field
  request.fields['metadata'] = jsonEncode(bundle.toJson());

  // Attach video file if present
  if (bundle.videoPath != null) {
    final file = File(bundle.videoPath!);
    if (await file.exists()) {
      request.files.add(
        await http.MultipartFile.fromPath('video', bundle.videoPath!),
      );
    }
  }

  // Attach audio file if present
  if (bundle.audioPath != null) {
    final file = File(bundle.audioPath!);
    if (await file.exists()) {
      request.files.add(
        await http.MultipartFile.fromPath('audio', bundle.audioPath!),
      );
    }
  }

  // Attach screenshots
  for (final path in bundle.screenshotPaths) {
    final file = File(path);
    if (await file.exists()) {
      request.files.add(
        await http.MultipartFile.fromPath('screenshots', path),
      );
    }
  }

  final response = await request.send();
  final body = await response.stream.bytesToString();

  if (response.statusCode >= 400) {
    throw HttpException(
      'Upload failed: HTTP ${response.statusCode}: $body',
    );
  }

  final json = jsonDecode(body) as Map<String, dynamic>;
  return json['feedbackId'] as String? ?? json['id'] as String? ?? '';
}
