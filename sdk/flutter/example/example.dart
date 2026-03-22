import 'dart:io';

import 'package:yaver/yaver.dart';

void main() async {
  // Connect to a Yaver agent
  final client = YaverClient('http://localhost:18080', 'your-auth-token');

  // Check agent health
  final rtt = await client.ping();
  print('Agent reachable, RTT: ${rtt}ms');

  // Get agent info
  final info = await client.info();
  print('Connected to ${info.hostname} (${info.platform})');

  // Create a task
  final task = await client.createTask(
    'Fix the login bug in auth.ts',
    CreateTaskOptions(model: 'sonnet', runner: 'claude'),
  );
  print('Task created: ${task.id}');

  // Stream output
  await for (final chunk in client.streamOutput(task.id)) {
    stdout.write(chunk);
  }

  // Create a task with images
  final imageBytes = await File('screenshot.png').readAsBytes();
  final taskWithImage = await client.createTask(
    'What is wrong with this UI?',
    CreateTaskOptions(
      images: [
        ImageAttachment(
          base64: Uri.encodeFull(String.fromCharCodes(imageBytes)),
          mimeType: 'image/png',
          filename: 'screenshot.png',
        ),
      ],
    ),
  );
  print('Task with image: ${taskWithImage.id}');

  // List and manage tasks
  final tasks = await client.listTasks();
  print('Total tasks: ${tasks.length}');

  // Auth client — validate token and list devices
  final auth = YaverAuthClient('your-auth-token');
  final user = await auth.validateToken();
  print('Logged in as ${user.fullName} (${user.email})');

  final devices = await auth.listDevices();
  for (final d in devices) {
    print('  ${d.name} (${d.platform}) — ${d.isOnline ? "online" : "offline"}');
  }

  client.close();
  auth.close();
}
