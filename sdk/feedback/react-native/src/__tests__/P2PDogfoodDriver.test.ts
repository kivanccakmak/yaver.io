import { DogfoodController } from '../DogfoodRuntime';
import { createP2PDogfoodDriver } from '../P2PDogfoodDriver';
import type { P2PClient } from '../P2PClient';

describe('createP2PDogfoodDriver', () => {
  it('keeps the browser lane compiling until the ordinary Projects status reports a URL', async () => {
    const stop = jest.fn(async () => {});
    const status = jest.fn()
      .mockResolvedValueOnce({ building: true, framework: 'flutter' })
      .mockResolvedValueOnce({ running: true, serving: true, framework: 'flutter', bundleUrl: '/dev/' });
    const client = {
      subscribeDogfoodDevEvents: (onEvent: (event: unknown) => void) => {
        onEvent({ type: 'log', logLine: '$ flutter run -d web-server' });
        return jest.fn();
      },
      startDogfoodDevServer: jest.fn(async () => ({ starting: true, framework: 'flutter' })),
      getDogfoodDevServerStatus: status,
      stopDogfoodDevServer: stop,
      resolveDogfoodUrl: (path: string) => `http://agent.test${path}`,
    } as unknown as P2PClient;
    const snapshots: string[][] = [];
    const controller = new DogfoodController(
      { name: 'Flutter app', framework: 'flutter', workDir: '/workspace/app', lane: 'browser' },
      createP2PDogfoodDriver(client, { pollIntervalMs: 1, startupTimeoutMs: 100 }),
      { onChange: (snapshot) => snapshots.push(snapshot.logs.map((line) => line.text)) },
    );

    const result = await controller.trigger();

    expect(result.url).toBe('http://agent.test/dev/');
    expect(status).toHaveBeenCalledTimes(2);
    expect(snapshots.flat()).toContain('$ flutter run -d web-server');
    expect(stop).not.toHaveBeenCalled();
    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('starts and cleans up an available native WebRTC runtime', async () => {
    const closeRuntime = jest.fn(async () => {});
    const client = {
      subscribeDogfoodDevEvents: () => jest.fn(),
      getDogfoodRemoteRuntimeCapabilities: jest.fn(async () => ({
        targets: [
          { id: 'browser-window', label: 'Browser', enabled: true },
          { id: 'ios-simulator', label: 'iPhone simulator', enabled: true },
        ],
      })),
      startDogfoodRemoteRuntime: jest.fn(async () => ({
        id: 'runtime-1', status: 'starting', targetId: 'ios-simulator',
      })),
      stopDogfoodRemoteRuntime: closeRuntime,
    } as unknown as P2PClient;
    const snapshots: string[][] = [];
    const controller = new DogfoodController(
      { name: 'Native app', framework: 'flutter', workDir: '/workspace/app', lane: 'webrtc' },
      createP2PDogfoodDriver(client),
      { onChange: (snapshot) => snapshots.push(snapshot.logs.map((line) => line.text)) },
    );

    await expect(controller.trigger()).resolves.toMatchObject({ lane: 'webrtc', sessionId: 'runtime-1' });
    expect(snapshots.flat()).toContain('[runtime] source · iPhone simulator');
    expect(snapshots.flat()).toContain('[runtime] starting');
    expect(closeRuntime).not.toHaveBeenCalled();
    await controller.stop();
    expect(closeRuntime).toHaveBeenCalledWith('runtime-1');
  });

  it('delivers Hermes without stopping an unrelated dev server on exit', async () => {
    const stop = jest.fn(async () => {});
    const client = {
      subscribeDogfoodDevEvents: () => jest.fn(),
      startDogfoodDevServer: jest.fn(async () => ({ running: true, framework: 'expo', workDir: '/workspace/app' })),
      stopDogfoodDevServer: stop,
    } as unknown as P2PClient;
    const controller = new DogfoodController(
      { name: 'RN app', framework: 'expo', workDir: '/workspace/app', lane: 'hermes' },
      createP2PDogfoodDriver(client),
    );

    await expect(controller.trigger()).resolves.toMatchObject({ lane: 'hermes', metadata: { delivered: true } });
    await controller.stop();
    expect(stop).not.toHaveBeenCalled();
  });
});
