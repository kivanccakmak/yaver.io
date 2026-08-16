import 'package:flutter_test/flutter_test.dart';
import 'package:yaver_feedback/src/reload_actions.dart';

void main() {
  group('the release-build guard', () {
    // THIS IS THE GUARD. Prove it by breaking it: flip `if (!isDevBuild)` in
    // reload_actions.dart to `if (isDevBuild)` and this test fails while
    // every other test in this file still passes.
    test('returns NOTHING in a release build, even with a healthy dev server', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: false,
        connected: true,
      );
      expect(actions, isEmpty);
    });

    test('returns actions in a debug build', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: true,
        connected: true,
      );
      expect(actions.map((a) => a.id), [ReloadActionId.hot, ReloadActionId.full]);
      expect(actions.every((a) => a.enabled), isTrue);
    });
  });

  group('reloadFrameworkFamily', () {
    test('maps the agent framework names', () {
      expect(reloadFrameworkFamily('flutter'), ReloadFrameworkFamily.flutter);
      expect(reloadFrameworkFamily('expo'), ReloadFrameworkFamily.reactNative);
      expect(reloadFrameworkFamily('react-native'), ReloadFrameworkFamily.reactNative);
      expect(reloadFrameworkFamily('vite'), ReloadFrameworkFamily.web);
      expect(reloadFrameworkFamily('nextjs'), ReloadFrameworkFamily.web);
      expect(reloadFrameworkFamily(''), ReloadFrameworkFamily.unknown);
      expect(reloadFrameworkFamily('godot'), ReloadFrameworkFamily.unknown);
    });
  });

  group('Flutter maps r/R, not reload/reload', () {
    test('names the second action Hot Restart and mentions (R)', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: true,
        connected: true,
      );
      expect(actions[0].label, 'Hot Reload');
      expect(actions[0].hint, contains('(r)'));
      expect(actions[1].label, 'Hot Restart');
      expect(actions[1].hint, contains('(R)'));
    });

    test('calls it a Full Reload on every other framework', () {
      for (final framework in ['expo', 'vite', 'nextjs']) {
        final actions = reloadActions(
          DevServerSnapshot(running: true, framework: framework),
          isDevBuild: true,
          connected: true,
        );
        expect(actions[1].label, 'Full Reload', reason: framework);
      }
    });
  });

  group('URL / payload construction', () {
    test('both actions POST /dev/reload with fast then full', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: true,
        connected: true,
      );
      expect(actions[0].path, kReloadPath);
      expect(actions[0].body, {'mode': 'fast'});
      expect(actions[1].path, kReloadPath);
      expect(actions[1].body, {'mode': 'full'});
    });

    test('never offers the Hermes bundle path — Flutter cannot load one', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: true,
        connected: true,
      );
      expect(actions.any((a) => a.path == kReloadAppPath), isFalse);
    });
  });

  group('a blocked action NAMES the blocker', () {
    test('names the missing dev server and the command that starts it', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: false),
        isDevBuild: true,
        connected: true,
        machineLabel: 'primary',
      );
      for (final action in actions) {
        expect(action.enabled, isFalse);
        expect(action.disabledReason, contains('primary'));
        expect(action.disabledReason, contains('yaver dev start'));
      }
    });

    test('names "still building" rather than pretending nothing is running', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, building: true, framework: 'flutter'),
        isDevBuild: true,
        connected: true,
      );
      expect(actions[0].disabledReason, contains('still building'));
    });

    test('names the missing machine when disconnected', () {
      final actions = reloadActions(
        const DevServerSnapshot(running: true, framework: 'flutter'),
        isDevBuild: true,
        connected: false,
      );
      expect(actions[0].disabledReason, contains('Not connected'));
    });
  });

  group('DevServerSnapshot.fromJson degrades to "not running", never optimism', () {
    test('parses a live status', () {
      final snap = DevServerSnapshot.fromJson(
        {'running': true, 'building': false, 'framework': 'flutter'},
      );
      expect(snap.running, isTrue);
      expect(snap.framework, 'flutter');
    });

    test('an empty body is NOT running', () {
      final snap = DevServerSnapshot.fromJson({});
      expect(snap.running, isFalse);
      expect(snap.building, isFalse);
      expect(snap.framework, isNull);
    });
  });

  group('describeReloadFailure names a cause, never "failed"', () {
    test('503 → no dev server', () {
      expect(
        describeReloadFailure(503, 'dev server not available'),
        contains('No dev server is running'),
      );
    });

    test('framework cannot hot reload → says which one', () {
      final msg = describeReloadFailure(
        500,
        'vite does not support hot reload',
        snapshot: const DevServerSnapshot(running: true, framework: 'vite'),
      );
      expect(msg, contains('vite'));
    });

    test('loopback connection refused → the dev server is not listening', () {
      final msg = describeReloadFailure(
        502,
        'Get "http://127.0.0.1:9100/reload": dial tcp 127.0.0.1:9100: connect: connection refused',
      );
      expect(msg, contains('not listening'));
      expect(msg, contains('yaver dev start'));
    });

    test('401/403 → session, not server', () {
      expect(describeReloadFailure(401, ''), contains('sign in again'));
      expect(describeReloadFailure(403, ''), contains('sign in again'));
    });

    test('404 → the agent is too old, and says how to update it', () {
      expect(describeReloadFailure(404, 'not found'), contains('yaver-cli@latest'));
    });

    test('5xx → points at the agent log', () {
      expect(describeReloadFailure(500, 'boom'), contains('yaver logs'));
    });

    test('status 0 (transport never answered) → machine reachability', () {
      expect(describeReloadFailure(0, ''), contains('yaver serve'));
    });
  });
}
