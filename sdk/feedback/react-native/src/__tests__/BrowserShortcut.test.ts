import {
  BrowserShortcutController,
  suggestBrowserShortcutOrigin,
  verifyBrowserShortcutAssets,
  type BrowserShortcutDriver,
  type BrowserShortcutRequest,
} from '../BrowserShortcut';

const request: BrowserShortcutRequest = {
  appId: 'com.example.sfmg',
  projectPath: '/workspace/sfmg',
  publicOrigin: 'https://sfmg.example.com',
  brand: { displayName: 'SFMG' },
};

function driver(overrides: Partial<BrowserShortcutDriver> = {}): BrowserShortcutDriver {
  return {
    preflightBrowserShortcut: jest.fn(async () => ({ ok: true, code: 'BROWSER_SHORTCUT_READY', message: 'ready' })),
    buildBrowserShortcut: jest.fn(async () => ({ ok: true, status: 'ok' })),
    publishBrowserShortcut: jest.fn(async () => ({
      version: 1, appId: request.appId, slug: 'com-example-sfmg', releaseId: 'abc',
      publicOrigin: request.publicOrigin!, installUrl: `${request.publicOrigin!}/`,
      mode: 'static-web' as const, framework: 'expo',
      publishedAt: '2026-09-06T09:00:00Z', size: 100, fileCount: 2, brand: request.brand,
    })),
    verifyBrowserShortcut: jest.fn(async () => true),
    ...overrides,
  };
}

describe('BrowserShortcutController', () => {
  test('a blocked preflight does not build, publish, or verify', async () => {
    const d = driver({
      preflightBrowserShortcut: jest.fn(async () => ({
        ok: false, code: 'BROWSER_SHORTCUT_BOX_OFFLINE', message: 'No connection', remedy: 'Reconnect.',
      })),
    });
    const result = await new BrowserShortcutController().run(d, request);
    expect(result).toMatchObject({ phase: 'blocked', activeStep: 'connection', code: 'BROWSER_SHORTCUT_BOX_OFFLINE' });
    expect(d.buildBrowserShortcut).not.toHaveBeenCalled();
    expect(d.publishBrowserShortcut).not.toHaveBeenCalled();
    expect(d.verifyBrowserShortcut).not.toHaveBeenCalled();
  });

  test('phases follow completed operations in exact order', async () => {
    const phases: string[] = [];
    const result = await new BrowserShortcutController().run(driver(), request, (snapshot) => phases.push(snapshot.phase));
    expect(phases).toEqual(['checking', 'building', 'publishing', 'verifying', 'ready']);
    expect(result.release?.installUrl).toBe('https://sfmg.example.com/');
  });

  test('uses the agent-reserved relay origin for publication', async () => {
    const d = driver({
      preflightBrowserShortcut: jest.fn(async () => ({
        ok: true, code: 'BROWSER_SHORTCUT_READY', message: 'ready',
        publicOrigin: 'https://sfmg-abcd.dev.yaver.io', relaySubdomain: 'sfmg-abcd',
      })),
    });
    const automatic = { ...request, publicOrigin: undefined };
    await new BrowserShortcutController().run(d, automatic);
    expect(d.buildBrowserShortcut).toHaveBeenCalledWith(expect.objectContaining({
      publicOrigin: 'https://sfmg-abcd.dev.yaver.io', relaySubdomain: 'sfmg-abcd',
    }), expect.any(AbortSignal));
    expect(d.publishBrowserShortcut).toHaveBeenCalledWith(expect.objectContaining({
      publicOrigin: 'https://sfmg-abcd.dev.yaver.io', relaySubdomain: 'sfmg-abcd',
    }), expect.any(AbortSignal));
  });

  test('carries the native runtime selected by preflight into build and publish', async () => {
    const d = driver({
      preflightBrowserShortcut: jest.fn(async () => ({
        ok: true, code: 'BROWSER_SHORTCUT_READY', message: 'ready',
        mode: 'remote-runtime' as const, runtimeTargetId: 'ios-simulator',
        publicOrigin: request.publicOrigin,
      })),
    });
    await new BrowserShortcutController().run(d, { ...request, mode: 'auto' });
    expect(d.buildBrowserShortcut).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'remote-runtime', runtimeTargetId: 'ios-simulator',
    }), expect.any(AbortSignal));
    expect(d.publishBrowserShortcut).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'remote-runtime', runtimeTargetId: 'ios-simulator',
    }), expect.any(AbortSignal));
  });

  test('a build failure cannot become a published false success', async () => {
    const d = driver({ buildBrowserShortcut: jest.fn(async () => ({ ok: false, error: 'Expo export ran out of memory' })) });
    const result = await new BrowserShortcutController().run(d, request);
    expect(result).toMatchObject({ phase: 'failed', activeStep: 'build', message: 'Expo export ran out of memory' });
    expect(d.publishBrowserShortcut).not.toHaveBeenCalled();
  });
});

describe('suggestBrowserShortcutOrigin', () => {
  test('never suggests an IP preview, path URL, or shared Yaver origin', () => {
    expect(suggestBrowserShortcutOrigin([
      'http://192.168.1.10:18080',
      'https://192.168.1.10',
      'https://[2001:db8::1]',
      'https://public.yaver.io/d/device',
      'https://agent.example.com/app',
      'https://sfmg.example.com/',
    ])).toBe('https://sfmg.example.com');
  });
});

describe('verifyBrowserShortcutAssets', () => {
  const response = (body: string, ok = true) => ({
    ok,
    text: async () => body,
    json: async () => JSON.parse(body),
  }) as Response;

  test('proves the manifest and service worker for a static shortcut', async () => {
    const release = await driver().publishBrowserShortcut(request) as Awaited<ReturnType<BrowserShortcutDriver['publishBrowserShortcut']>>;
    const get = jest.fn(async (url: string) => {
      if (url.endsWith('manifest.webmanifest')) return response('{"start_url":"/","display":"standalone"}');
      if (url.endsWith('sw.js')) return response("self.addEventListener('fetch',()=>{})");
      return response('<link rel="manifest" href="/manifest.webmanifest">');
    });
    await expect(verifyBrowserShortcutAssets(release, get)).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  test('native verification also proves the real WebRTC launcher asset', async () => {
    const staticRelease = await driver().publishBrowserShortcut(request) as Awaited<ReturnType<BrowserShortcutDriver['publishBrowserShortcut']>>;
    const release = { ...staticRelease, mode: 'remote-runtime' as const, framework: 'swift', runtimeTargetId: 'ios-simulator' };
    const get = jest.fn(async (url: string) => {
      if (url.endsWith('manifest.webmanifest')) return response('{"start_url":"/","display":"standalone"}');
      if (url.endsWith('sw.js')) return response("self.addEventListener('fetch',()=>{})");
      if (url.endsWith('runtime.js')) return response('new RTCPeerConnection(); command="run-project";');
      return response('<link rel="manifest" href="/manifest.webmanifest">');
    });
    await expect(verifyBrowserShortcutAssets(release, get)).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(4);
  });

  test('fails closed when a required published asset is missing', async () => {
    const release = await driver().publishBrowserShortcut(request) as Awaited<ReturnType<BrowserShortcutDriver['publishBrowserShortcut']>>;
    const get = jest.fn(async (url: string) => url.endsWith('sw.js')
      ? response('', false)
      : url.endsWith('manifest.webmanifest')
        ? response('{"start_url":"/","display":"standalone"}')
        : response('<link rel="manifest" href="/manifest.webmanifest">'));
    await expect(verifyBrowserShortcutAssets(release, get)).resolves.toBe(false);
  });
});
