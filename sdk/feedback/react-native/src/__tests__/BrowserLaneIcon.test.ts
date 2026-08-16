/**
 * Browser-lane DOM icon (feedback-sdk-lanes audit 2026-07-28). RN-web inside
 * Yaver's fullScreen preview WebView: native shake can't fire and the container
 * overlay is occluded, so the SDK mounts an occlusion-proof DOM icon. Node env,
 * so we stub Platform.OS='web' + a minimal DOM.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  NativeModules: {},
}));

// Minimal DOM stub — enough for mountBrowserLaneIcon's createElement/appendChild.
function installFakeDom() {
  const els: Record<string, any> = {};
  const makeEl = () => ({
    id: '',
    textContent: '',
    title: '',
    style: {} as Record<string, string>,
    _handlers: {} as Record<string, unknown>,
    setAttribute() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 44, height: 44 }),
    addEventListener(k: string, fn: unknown) { this._handlers[k] = fn; },
  });
  (globalThis as any).window = {
    innerWidth: 390, innerHeight: 844,
    addEventListener() {},
    __yaverLane: 'browser',
  };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {} };
  (globalThis as any).document = {
    body: { appendChild(el: any) { els[el.id] = el; } },
    getElementById: (id: string) => els[id] || null,
    createElement: () => makeEl(),
  };
  return { els };
}

describe('RN SDK browser-lane icon', () => {
  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).localStorage;
    jest.resetModules();
  });

  it('detectWebLane reads window.__yaverLane on web', () => {
    installFakeDom();
    const { YaverFeedback } = require('../YaverFeedback');
    expect(YaverFeedback.detectWebLane()).toBe('browser');
  });

  it('mounts a fixed, max-z-index, draggable DOM icon in the browser lane', () => {
    const { els } = installFakeDom();
    const { YaverFeedback } = require('../YaverFeedback');
    YaverFeedback.mountBrowserLaneIcon();
    const btn = els['yaver-feedback-btn'];
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Y');
    expect(btn.style.cssText).toContain('position:fixed');
    expect(btn.style.cssText).toContain('z-index:99999');
    // Draggable: pointer handlers wired.
    expect(typeof btn._handlers['pointerdown']).toBe('function');
    expect(typeof btn._handlers['pointerup']).toBe('function');
  });

  it('is idempotent — a second mount does not stack a second icon', () => {
    const { els } = installFakeDom();
    const { YaverFeedback } = require('../YaverFeedback');
    YaverFeedback.mountBrowserLaneIcon();
    const first = els['yaver-feedback-btn'];
    YaverFeedback.mountBrowserLaneIcon();
    expect(els['yaver-feedback-btn']).toBe(first);
  });

  it('no-ops when not in a browser lane', () => {
    const { els } = installFakeDom();
    (globalThis as any).window.__yaverLane = undefined;
    const { YaverFeedback } = require('../YaverFeedback');
    YaverFeedback.mountBrowserLaneIcon();
    expect(els['yaver-feedback-btn']).toBeUndefined();
  });
});
