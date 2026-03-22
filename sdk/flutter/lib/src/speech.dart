import 'dart:convert';

import 'package:http/http.dart' as http;

import 'types.dart';

/// Available speech-to-text providers.
const speechProviders = <SpeechProviderInfo>[
  SpeechProviderInfo(
    id: SpeechProvider.onDevice,
    name: 'On-Device (Free)',
    description: 'Runs locally using Whisper. No API key needed.',
    requiresKey: false,
  ),
  SpeechProviderInfo(
    id: SpeechProvider.openai,
    name: 'OpenAI',
    description: 'GPT-4o Mini Transcribe. Fast, accurate.',
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    keyHint: 'Get your key at platform.openai.com/api-keys',
    pricePerMin: r'$0.003',
  ),
  SpeechProviderInfo(
    id: SpeechProvider.deepgram,
    name: 'Deepgram',
    description: 'Nova-2. Real-time capable, top accuracy.',
    requiresKey: true,
    keyPlaceholder: 'Your Deepgram API key',
    keyHint: 'Get your key at console.deepgram.com',
    pricePerMin: r'$0.004',
  ),
  SpeechProviderInfo(
    id: SpeechProvider.assemblyai,
    name: 'AssemblyAI',
    description: 'Universal-2. Cheapest async option.',
    requiresKey: true,
    keyPlaceholder: 'Your AssemblyAI API key',
    keyHint: 'Get your key at assemblyai.com/dashboard',
    pricePerMin: r'$0.002',
  ),
];

/// Transcribe audio bytes using a cloud speech-to-text provider.
///
/// [audioBytes] — raw audio file bytes (m4a, wav, mp3, etc.)
/// [provider] — which STT provider to use
/// [apiKey] — API key for the cloud provider (not needed for onDevice)
/// [filename] — filename hint for the audio (default: 'audio.m4a')
Future<TranscriptionResult> transcribe(
  List<int> audioBytes,
  SpeechProvider provider,
  String? apiKey, {
  String filename = 'audio.m4a',
}) async {
  final sw = Stopwatch()..start();
  final String text;

  switch (provider) {
    case SpeechProvider.openai:
      text = await _transcribeOpenAI(audioBytes, apiKey!, filename);
    case SpeechProvider.deepgram:
      text = await _transcribeDeepgram(audioBytes, apiKey!);
    case SpeechProvider.assemblyai:
      text = await _transcribeAssemblyAI(audioBytes, apiKey!);
    case SpeechProvider.onDevice:
      throw UnsupportedError(
        'On-device transcription requires a native Whisper plugin. '
        'Use the Yaver mobile app or CLI for on-device STT.',
      );
  }

  return TranscriptionResult(
    text: text,
    durationMs: sw.elapsedMilliseconds,
    provider: provider.name,
  );
}

Future<String> _transcribeOpenAI(
    List<int> audioBytes, String apiKey, String filename) async {
  final request = http.MultipartRequest(
    'POST',
    Uri.parse('https://api.openai.com/v1/audio/transcriptions'),
  );
  request.headers['Authorization'] = 'Bearer $apiKey';
  request.fields['model'] = 'gpt-4o-mini-transcribe';
  request.fields['language'] = 'en';
  request.files.add(http.MultipartFile.fromBytes(
    'file',
    audioBytes,
    filename: filename,
  ));

  final streamed = await request.send();
  final resp = await http.Response.fromStream(streamed);
  if (resp.statusCode >= 400) {
    throw Exception('OpenAI STT failed (${resp.statusCode})');
  }
  final data = jsonDecode(resp.body) as Map<String, dynamic>;
  return (data['text'] as String?)?.trim() ?? '';
}

Future<String> _transcribeDeepgram(List<int> audioBytes, String apiKey) async {
  final resp = await http.post(
    Uri.parse(
        'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true'),
    headers: {
      'Authorization': 'Token $apiKey',
      'Content-Type': 'audio/m4a',
    },
    body: audioBytes,
  );
  if (resp.statusCode >= 400) {
    throw Exception('Deepgram STT failed (${resp.statusCode})');
  }
  final data = jsonDecode(resp.body) as Map<String, dynamic>;
  final channels = (data['results'] as Map?)?['channels'] as List?;
  final alt = (channels?.firstOrNull as Map?)?['alternatives'] as List?;
  return ((alt?.firstOrNull as Map?)?['transcript'] as String?)?.trim() ?? '';
}

Future<String> _transcribeAssemblyAI(
    List<int> audioBytes, String apiKey) async {
  // Upload
  final uploadResp = await http.post(
    Uri.parse('https://api.assemblyai.com/v2/upload'),
    headers: {'Authorization': apiKey},
    body: audioBytes,
  );
  if (uploadResp.statusCode >= 400) {
    throw Exception('AssemblyAI upload failed (${uploadResp.statusCode})');
  }
  final uploadUrl =
      (jsonDecode(uploadResp.body) as Map<String, dynamic>)['upload_url'];

  // Create transcription
  final txResp = await http.post(
    Uri.parse('https://api.assemblyai.com/v2/transcript'),
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: jsonEncode({'audio_url': uploadUrl, 'language_code': 'en'}),
  );
  if (txResp.statusCode >= 400) {
    throw Exception('AssemblyAI transcription failed');
  }
  final id = (jsonDecode(txResp.body) as Map<String, dynamic>)['id'];

  // Poll for result
  for (var i = 0; i < 60; i++) {
    await Future.delayed(const Duration(seconds: 1));
    final pollResp = await http.get(
      Uri.parse('https://api.assemblyai.com/v2/transcript/$id'),
      headers: {'Authorization': apiKey},
    );
    final data = jsonDecode(pollResp.body) as Map<String, dynamic>;
    if (data['status'] == 'completed') {
      return (data['text'] as String?)?.trim() ?? '';
    }
    if (data['status'] == 'error') {
      throw Exception('AssemblyAI error: ${data['error']}');
    }
  }
  throw Exception('AssemblyAI transcription timed out');
}
