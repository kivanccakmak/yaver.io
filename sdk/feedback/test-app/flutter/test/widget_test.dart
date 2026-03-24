import 'package:flutter_test/flutter_test.dart';
import 'package:yaver_feedback/yaver_feedback.dart';

void main() {
  test('SDK initializes', () {
    YaverFeedback.init(FeedbackConfig(
      agentUrl: 'http://localhost:18080',
      authToken: 'test',
    ));
    expect(YaverFeedback.isInitialized, true);
  });

  test('FeedbackConfig defaults', () {
    final config = FeedbackConfig(agentUrl: 'http://test', authToken: 'tok');
    expect(config.mode, FeedbackMode.narrated);
    expect(config.agentCommentaryLevel, 5);
  });

  test('Discovery result', () {
    final r = DiscoveryResult(url: 'http://localhost:18080', hostname: 'mac', version: '1.0', latencyMs: 5);
    expect(r.hostname, 'mac');
  });

  test('Timeline event serialization', () {
    final e = TimelineEvent(time: 1.5, type: 'voice', text: 'bug here');
    final json = e.toJson();
    expect(json['type'], 'voice');
    final decoded = TimelineEvent.fromJson(json);
    expect(decoded.text, 'bug here');
  });
}
