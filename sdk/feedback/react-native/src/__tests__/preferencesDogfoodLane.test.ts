const values = new Map<string, string>();
let releaseWrite: (() => void) | null = null;

const mockAsyncStorage = {
  getItem: jest.fn(async (key: string) => values.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    values.set(key, value);
    if (releaseWrite) await new Promise<void>((resolve) => { releaseWrite = resolve; });
  }),
  removeItem: jest.fn(async (key: string) => { values.delete(key); }),
};

jest.mock('@react-native-async-storage/async-storage', () => ({ default: mockAsyncStorage }));

import {
  getDogfoodRenderBehavior,
  getDogfoodSessionBehavior,
  getDogfoodStartBehavior,
  getDogfoodUsageMode,
  getPreferredDogfoodLane,
  setDogfoodRenderBehavior,
  setDogfoodSessionBehavior,
  setDogfoodStartBehavior,
  setDogfoodUsageMode,
  setPreferredDogfoodLane,
} from '../preferences';

describe('Dogfood lane preference handoff', () => {
  test('a new install has no stale v2 Hermes preference', async () => {
    values.set('yaver_feedback_dogfood_lane_reload_v2_io.example.old', 'hermes');
    await expect(getPreferredDogfoodLane('io.example.old')).resolves.toBeNull();
  });

  test('Settings publishes the selected lane before its storage write finishes', async () => {
    releaseWrite = () => {};
    const write = setPreferredDogfoodLane('io.example.race', 'browser');
    await expect(getPreferredDogfoodLane('io.example.race')).resolves.toBe('browser');
    releaseWrite?.();
    releaseWrite = null;
    await write;
  });

  test('every launch policy is visible before its storage write finishes', async () => {
    const assertImmediate = async <T>(write: () => Promise<void>, read: () => Promise<T>, expected: T) => {
      releaseWrite = () => {};
      const pending = write();
      await expect(read()).resolves.toBe(expected);
      releaseWrite?.();
      releaseWrite = null;
      await pending;
    };

    await assertImmediate(
      () => setDogfoodUsageMode('reload-and-chat', 'io.example.policy'),
      () => getDogfoodUsageMode('io.example.policy'),
      'reload-and-chat',
    );
    await assertImmediate(
      () => setDogfoodStartBehavior('render-on-open', 'io.example.policy'),
      () => getDogfoodStartBehavior('io.example.policy'),
      'render-on-open',
    );
    await assertImmediate(
      () => setDogfoodRenderBehavior('auto-on-request', 'io.example.policy'),
      () => getDogfoodRenderBehavior('io.example.policy'),
      'auto-on-request',
    );
    await assertImmediate(
      () => setDogfoodSessionBehavior('new-session', 'io.example.policy'),
      () => getDogfoodSessionBehavior('io.example.policy'),
      'new-session',
    );
  });
});
