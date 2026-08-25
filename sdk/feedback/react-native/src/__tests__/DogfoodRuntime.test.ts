import {
  DogfoodController,
  DogfoodRuntimeError,
  defaultDogfoodLane,
  dogfoodLaneOptions,
  dogfoodLogLinesFromDevEvent,
  validateDogfoodProject,
  type DogfoodDriver,
  type DogfoodProject,
} from '../DogfoodRuntime';

const expo: DogfoodProject = {
  name: 'Example', workDir: '/workspace/example', framework: 'expo', lane: 'browser',
};

describe('DogfoodController', () => {
  test('does no work before the explicit trigger', () => {
    const driver: DogfoodDriver = { start: jest.fn(async () => ({ lane: 'browser' as const })) };
    const controller = new DogfoodController(expo, driver);
    expect(driver.start).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe('idle');
  });

  test('preserves raw npm output and hands a live session to the host', async () => {
    const stop = jest.fn();
    const closeLogs = jest.fn();
    const controller = new DogfoodController(expo, {
      async start(ctx) {
        ctx.registerCleanup(stop, 'session');
        ctx.registerCleanup(closeLogs, 'transient');
        ctx.log('$ npm install --legacy-peer-deps');
        ctx.log('npm warn deprecated example@1.0.0');
        return { lane: 'browser', sessionId: 's1', url: 'http://agent/dev/' };
      },
    });

    await controller.trigger();
    expect(controller.snapshot().logs.map((line) => line.text)).toEqual([
      '$ npm install --legacy-peer-deps',
      'npm warn deprecated example@1.0.0',
    ]);
    expect(await controller.handoff()).toMatchObject({ sessionId: 's1' });
    expect(closeLogs).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  test('cleans a partial session before exposing a structured failure', async () => {
    const stop = jest.fn();
    const controller = new DogfoodController(expo, {
      async start(ctx) {
        ctx.registerCleanup(stop);
        throw new DogfoodRuntimeError({
          code: 'DOGFOOD_RENDER_FAILED', error: 'Metro exited', remedy: 'Fix Metro and retry.', retryable: true,
        });
      },
    });
    await expect(controller.trigger()).rejects.toThrow('Metro exited');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ phase: 'failed', failure: { code: 'DOGFOOD_RENDER_FAILED' } });
  });
});

describe('Dogfood lanes and console events', () => {
  test('Flutter is first-class on browser but cannot be mislabeled Hermes', () => {
    expect(validateDogfoodProject({ ...expo, framework: 'flutter', lane: 'browser' })).toBeNull();
    expect(validateDogfoodProject({ ...expo, framework: 'flutter', lane: 'hermes' })?.code)
      .toBe('DOGFOOD_HERMES_FRAMEWORK_UNSUPPORTED');
  });

  test('uses one three-lane matrix with browser default for React Native and Flutter', () => {
    const rn = dogfoodLaneOptions('expo', { nativeRuntimeAvailable: true });
    expect(defaultDogfoodLane('expo')).toBe('browser');
    expect(rn.map((option) => [option.lane, option.supported])).toEqual([
      ['browser', true], ['hermes', true], ['webrtc', true],
    ]);
    const flutter = dogfoodLaneOptions('flutter', { nativeRuntimeAvailable: true });
    expect(defaultDogfoodLane('flutter')).toBe('browser');
    expect(flutter.find((option) => option.lane === 'hermes')?.supported).toBe(false);
  });

  test('keeps self-development Hermes visible but safely unavailable', () => {
    const options = dogfoodLaneOptions('expo', { nativeRuntimeAvailable: true, selfDevelopment: true });
    expect(options).toHaveLength(3);
    expect(options.find((option) => option.lane === 'hermes')).toMatchObject({ supported: false });
    expect(options.find((option) => option.lane === 'webrtc')).toMatchObject({ supported: true });
  });

  test('reads raw and replayed package-manager logs from /dev/events', () => {
    expect(dogfoodLogLinesFromDevEvent({ type: 'log', logLine: '$ npm ci\u001b[0m' }))
      .toEqual(['$ npm ci\u001b[0m']);
    expect(dogfoodLogLinesFromDevEvent({ type: 'snapshot', snapshot: { recentLogs: ['npm warn x', 'Metro ready'] } }))
      .toEqual(['npm warn x', 'Metro ready']);
  });
});
