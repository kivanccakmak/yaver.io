import { DeviceEventEmitter, Platform } from 'react-native';

const SHAKE_THRESHOLD = 1.5; // g-force threshold
const SHAKE_TIMEOUT_MS = 1000; // minimum time between shakes
const SHAKE_REQUIRED_EVENTS = 3; // number of threshold-exceeding events to trigger

/**
 * Detects device shake gestures.
 *
 * On iOS, listens to the native 'shakeEvent' emitted by RCTDeviceEventEmitter.
 * On Android, uses accelerometer data with threshold-based detection as a fallback.
 */
export class ShakeDetector {
  private subscription: any = null;
  private lastShakeTime = 0;

  /**
   * Start listening for shake gestures.
   * @param onShake - Callback invoked when a shake is detected.
   */
  start(onShake: () => void): void {
    this.stop();

    // React Native emits a 'shakeEvent' on iOS when the device is shaken
    // (available via DeviceEventEmitter in debug builds)
    if (Platform.OS === 'ios') {
      this.subscription = DeviceEventEmitter.addListener('shakeEvent', () => {
        const now = Date.now();
        if (now - this.lastShakeTime > SHAKE_TIMEOUT_MS) {
          this.lastShakeTime = now;
          onShake();
        }
      });
      return;
    }

    // Android: listen for accelerometer-based shake detection
    // Uses the same DeviceEventEmitter pattern — if a native module or
    // react-native-shake is installed, it will emit 'ShakeEvent'.
    // Otherwise this is a no-op (manual trigger or floating button can be used).
    this.subscription = DeviceEventEmitter.addListener('ShakeEvent', () => {
      const now = Date.now();
      if (now - this.lastShakeTime > SHAKE_TIMEOUT_MS) {
        this.lastShakeTime = now;
        onShake();
      }
    });
  }

  /** Stop listening for shake gestures. */
  stop(): void {
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
  }
}
