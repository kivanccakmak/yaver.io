import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:yaver_feedback/yaver_feedback.dart';

void main() {
  if (kDebugMode) {
    YaverFeedback.init(FeedbackConfig(
      agentUrl: 'http://localhost:18080',
      authToken: 'test-token',
      trigger: FeedbackTrigger.floatingButton,
      mode: FeedbackMode.narrated,
      agentCommentaryLevel: 5,
    ));
  }
  runApp(const TestApp());
}

class TestApp extends StatelessWidget {
  const TestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Yaver Feedback Test')),
        body: Stack(
          children: [
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('SDK initialized: ${YaverFeedback.isInitialized}'),
                  Text('SDK enabled: ${YaverFeedback.isEnabled}'),
                  const SizedBox(height: 20),
                  ElevatedButton(
                    onPressed: () => YaverFeedback.startReport(context),
                    child: const Text('Start Feedback'),
                  ),
                ],
              ),
            ),
            const YaverFeedbackButton(),
          ],
        ),
      ),
    );
  }
}
