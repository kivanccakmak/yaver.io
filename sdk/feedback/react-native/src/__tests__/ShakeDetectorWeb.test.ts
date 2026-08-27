// Browsers cannot provide a native shake gesture. expo-sensors still exports
// an Accelerometer facade there, and older SDK builds attempted to subscribe
// to it, crashing the host React tree through NativeEventEmitter.

const sensorAddListener = jest.fn(() => ({ remove: jest.fn() }));
const devEventAddListener = jest.fn(() => ({ remove: jest.fn() }));

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  NativeModules: {},
  DeviceEventEmitter: { addListener: devEventAddListener },
}));

jest.mock('expo-sensors', () => ({
  Accelerometer: {
    setUpdateInterval: jest.fn(),
    addListener: sensorAddListener,
  },
}), { virtual: true });

import { ShakeDetector } from '../ShakeDetector';

it('keeps explicit SDK controls alive without touching the native sensor on web', () => {
  const detector = new ShakeDetector();
  expect(() => detector.start(jest.fn())).not.toThrow();
  expect(sensorAddListener).not.toHaveBeenCalled();
  // The ordinary DeviceEventEmitter lane remains harmless and removable.
  expect(devEventAddListener).toHaveBeenCalledTimes(1);
  expect(() => detector.stop()).not.toThrow();
});
