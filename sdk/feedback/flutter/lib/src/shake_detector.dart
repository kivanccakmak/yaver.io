import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

/// Simple shake detection based on device accelerometer.
///
/// Listens for rapid acceleration changes that indicate a shake gesture.
/// If the `sensors_plus` package is not available, [start] is a no-op.
///
/// Usage:
/// ```dart
/// final detector = ShakeDetector();
/// detector.start(() => print('Shake detected!'));
/// // Later:
/// detector.stop();
/// ```
class ShakeDetector {
  /// Minimum acceleration magnitude (in m/s^2) to count as a shake event.
  final double shakeThreshold;

  /// Number of shake events required within [shakeDuration] to trigger.
  final int shakeCount;

  /// Time window within which [shakeCount] shakes must occur.
  final Duration shakeDuration;

  StreamSubscription<dynamic>? _subscription;
  final List<DateTime> _shakeTimestamps = [];

  /// Creates a new [ShakeDetector].
  ///
  /// [shakeThreshold] defaults to 15.0 m/s^2.
  /// [shakeCount] defaults to 3 shakes.
  /// [shakeDuration] defaults to 1 second.
  ShakeDetector({
    this.shakeThreshold = 15.0,
    this.shakeCount = 3,
    this.shakeDuration = const Duration(seconds: 1),
  });

  /// Starts listening for shake events.
  ///
  /// Calls [onShake] when a shake gesture is detected. This implementation
  /// provides a stub that can be extended with `sensors_plus` accelerometer
  /// events. Without `sensors_plus`, this is a no-op.
  void start(VoidCallback onShake) {
    // Stub implementation — users should integrate with sensors_plus
    // accelerometerEvents stream and call _onAccelerometerEvent.
    //
    // Example with sensors_plus:
    //   _subscription = accelerometerEventStream().listen((event) {
    //     _onAccelerometerEvent(event.x, event.y, event.z, onShake);
    //   });
    debugPrint(
      'ShakeDetector: started (integrate sensors_plus for real detection)',
    );
  }

  /// Processes an accelerometer reading and triggers [onShake] if the
  /// shake threshold is met.
  ///
  /// Call this from your accelerometer event stream:
  /// ```dart
  /// accelerometerEventStream().listen((event) {
  ///   shakeDetector.onAccelerometerEvent(event.x, event.y, event.z, callback);
  /// });
  /// ```
  void onAccelerometerEvent(
    double x,
    double y,
    double z,
    VoidCallback onShake,
  ) {
    final magnitude = sqrt(x * x + y * y + z * z);

    if (magnitude > shakeThreshold) {
      final now = DateTime.now();
      _shakeTimestamps.add(now);

      // Remove timestamps outside the time window
      _shakeTimestamps.removeWhere(
        (t) => now.difference(t) > shakeDuration,
      );

      if (_shakeTimestamps.length >= shakeCount) {
        _shakeTimestamps.clear();
        onShake();
      }
    }
  }

  /// Stops listening for shake events and cleans up resources.
  void stop() {
    _subscription?.cancel();
    _subscription = null;
    _shakeTimestamps.clear();
  }
}
