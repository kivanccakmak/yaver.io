/// Yaver Feedback SDK — Flutter Example
///
/// Shows all three modes: Full Interactive, Semi Interactive, Post Mode.
/// The user selects the mode at runtime from within their app.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
// import 'package:yaver_feedback/yaver_feedback.dart';

void main() {
  // Initialize in debug mode only
  if (kDebugMode) {
    // YaverFeedback.init(FeedbackConfig(
    //   agentUrl: 'http://192.168.1.100:18080', // or auto-discovers
    //   authToken: 'your-token',
    //   trigger: FeedbackTrigger.floatingButton,
    //   mode: FeedbackMode.narrated, // default, user can change at runtime
    //   agentCommentaryLevel: 5,     // 0=silent, 10=comments on everything
    // ));
  }
  runApp(const FeedbackExampleApp());
}

class FeedbackExampleApp extends StatelessWidget {
  const FeedbackExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData.dark(),
      home: const FeedbackExampleHome(),
    );
  }
}

class FeedbackExampleHome extends StatefulWidget {
  const FeedbackExampleHome({super.key});

  @override
  State<FeedbackExampleHome> createState() => _FeedbackExampleHomeState();
}

class _FeedbackExampleHomeState extends State<FeedbackExampleHome> {
  String _selectedMode = 'narrated';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Yaver Feedback Demo')),
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Select Feedback Mode:', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                const SizedBox(height: 12),

                // Mode selector
                _modeCard(
                  'Full Interactive',
                  'live',
                  'Agent sees your screen live. Hot reload fixes bugs as you speak. '
                  'Vision model detects issues proactively.',
                  Colors.red,
                ),
                _modeCard(
                  'Semi Interactive',
                  'narrated',
                  'Agent sees your screen and comments, but doesn\'t auto-fix. '
                  'Conversation mode — say "fix it now" for specific issues.',
                  Colors.orange,
                ),
                _modeCard(
                  'Post Mode',
                  'batch',
                  'Record everything offline. No streaming. Submit compressed '
                  'bundle when done. Agent analyzes the full session afterwards.',
                  Colors.green,
                ),

                const SizedBox(height: 20),
                const Divider(color: Colors.grey),
                const SizedBox(height: 12),
                const Text('Your App Content Here', style: TextStyle(fontSize: 14)),
                const SizedBox(height: 8),
                ElevatedButton(
                  onPressed: () {},
                  child: const Text('Login (this button has a bug)'),
                ),
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(12),
                  color: Colors.red.withOpacity(0.3),
                  child: const Text('This overlapping element is a bug the agent should detect'),
                ),
              ],
            ),
          ),

          // Yaver floating button (from SDK)
          // const YaverFeedbackButton(),

          // Or use the connection widget:
          // Positioned(
          //   bottom: 80,
          //   right: 16,
          //   child: YaverConnectionWidget(
          //     onConnected: (result) => print('Connected: ${result.hostname}'),
          //   ),
          // ),
        ],
      ),
    );
  }

  Widget _modeCard(String title, String mode, String description, Color color) {
    final selected = _selectedMode == mode;
    return GestureDetector(
      onTap: () {
        setState(() => _selectedMode = mode);
        // YaverFeedback.setMode(FeedbackMode.values.byName(mode));
      },
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border: Border.all(color: selected ? color : Colors.grey.shade800),
          borderRadius: BorderRadius.circular(8),
          color: selected ? color.withOpacity(0.1) : Colors.transparent,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 10, height: 10,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: color),
                ),
                const SizedBox(width: 8),
                Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                if (selected) ...[
                  const Spacer(),
                  Icon(Icons.check_circle, color: color, size: 18),
                ],
              ],
            ),
            const SizedBox(height: 4),
            Text(description, style: TextStyle(fontSize: 12, color: Colors.grey.shade400)),
          ],
        ),
      ),
    );
  }
}
