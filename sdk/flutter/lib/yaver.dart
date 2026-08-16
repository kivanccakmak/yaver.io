/// Yaver SDK for Flutter & Dart.
///
/// Embed Yaver's P2P AI agent connectivity into your apps.
///
/// ```dart
/// import 'package:yaver/yaver.dart';
///
/// final client = YaverClient('http://localhost:18080', 'your-token');
/// final task = await client.createTask('Fix the login bug');
/// await for (final chunk in client.streamOutput(task.id)) {
///   stdout.write(chunk);
/// }
/// ```
library yaver;

export 'src/client.dart' show YaverClient, YaverException;
export 'src/auth.dart' show YaverAuthClient;
export 'src/speech.dart' show transcribe, speechProviders;
export 'src/types.dart';
