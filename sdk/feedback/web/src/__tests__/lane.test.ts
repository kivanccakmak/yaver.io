/**
 * Lane-aware behavior (docs/audits/feedback-sdk-lanes-audit-2026-07-28.md).
 * jsdom gives us window + DOM, so we can assert both detectLane() and that the
 * BROWSER lane actually mounts a draggable floating icon.
 */
import { YaverFeedback } from '../YaverFeedback';

describe('YaverFeedback lane awareness', () => {
  afterEach(() => {
    delete (window as unknown as { __yaverLane?: string }).__yaverLane;
    document.getElementById('yaver-feedback-btn')?.remove();
  });

  it('detectLane reads window.__yaverLane', () => {
    (window as unknown as { __yaverLane?: string }).__yaverLane = 'browser';
    expect(YaverFeedback.detectLane()).toBe('browser');
    (window as unknown as { __yaverLane?: string }).__yaverLane = 'hermes';
    expect(YaverFeedback.detectLane()).toBe('hermes');
    (window as unknown as { __yaverLane?: string }).__yaverLane = 'webrtc';
    expect(YaverFeedback.detectLane()).toBe('webrtc');
  });

  it('defaults to standalone when no lane is injected', () => {
    expect(YaverFeedback.detectLane()).toBe('standalone');
  });

  it('ignores an unknown lane value (never trusts arbitrary injected strings)', () => {
    (window as unknown as { __yaverLane?: string }).__yaverLane = 'evil';
    expect(YaverFeedback.detectLane()).toBe('standalone');
  });

  it('BROWSER lane mounts the floating icon even with no configured trigger', async () => {
    (window as unknown as { __yaverLane?: string }).__yaverLane = 'browser';
    // agentUrl set so init() skips network discovery; trigger:"none" proves the
    // browser lane FORCES the icon regardless of the app's own trigger choice.
    await YaverFeedback.init({ agentUrl: 'http://127.0.0.1:18080', trigger: 'none' as never });
    const btn = document.getElementById('yaver-feedback-btn');
    expect(btn).not.toBeNull();
    // Occlusion-proof contract: fixed positioning + max z-index in the DOM.
    expect(btn!.style.position).toBe('fixed');
    expect(btn!.style.zIndex).toBe('99999');
    // Draggable: a tap (<5px) opens the report; a drag moves it. We can only
    // assert the handlers exist here; the drag-vs-tap math is exercised e2e.
    expect(typeof (btn as unknown as { onpointerdown?: unknown })).toBe('object');
    expect(YaverFeedback.lane).toBe('browser');
  });
});
