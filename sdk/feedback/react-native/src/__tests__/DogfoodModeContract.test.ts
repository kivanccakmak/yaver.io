import { readFileSync } from 'fs';
import { join } from 'path';

describe('Dogfood Settings and Usage contract', () => {
  it('exports separate embeddable settings and usage surfaces', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    expect(index).toContain('DogfoodSettings');
    expect(index).toContain('DogfoodUsage');
  });

  it('hides SDK chat in reload-only mode while retaining reload and setup', () => {
    const usage = readFileSync(join(__dirname, '../DogfoodQuickControls.tsx'), 'utf8');
    expect(usage).toContain("usageMode === 'reload-and-chat'");
    expect(usage).toContain('yaver-dogfood-fast-reload');
    expect(usage).toContain('Dogfood Settings');
    expect(usage).toContain('<DogfoodSettings showExit={false} />');
    expect(usage).toContain('Back to native app');
    expect(usage).toContain('yaverFeedback:dogfoodUsageRequested');
  });

  it('states that both choices use OAuth and installation approval', () => {
    const settings = readFileSync(join(__dirname, '../DogfoodSettings.tsx'), 'utf8');
    expect(settings).toContain('full Yaver OAuth account and approved installation');
    expect(settings).toContain('Reload Only');
    expect(settings).toContain('Reload + Chat');
    expect(settings).toContain('Vibe first');
    expect(settings).toContain('Tap Render updates');
    expect(settings).toContain('Runner sessions');
    expect(settings).toContain('completeDogfoodSession');
    expect(settings).toContain('deleteDogfoodSession');
  });

  it('restores durable sessions without globally locking other topics', () => {
    const chat = readFileSync(join(__dirname, '../VibeChatScreen.tsx'), 'utf8');
    expect(chat).toContain('Each topic owns its own runner/tmux seat');
    expect(chat).toContain("const codingLocked = status === 'running'");
    expect(chat).toContain("event.type !== 'runtime_render_requested'");
    expect(chat).toContain("renderBehavior === 'auto-on-request'");
  });

  it('targets the current app command channel and requires an exact checkout', () => {
    const feedback = readFileSync(join(__dirname, '../YaverFeedback.ts'), 'utf8');
    expect(feedback).toContain("if (!selection.projectPath?.trim())");
    expect(feedback).toContain('BlackBox.currentDeviceId');
    expect(feedback).toContain('BlackBox.isCommandChannelConnected');
  });

  it('offers an authenticated in-place update when the selected agent is old', () => {
    const usage = readFileSync(join(__dirname, '../DogfoodQuickControls.tsx'), 'utf8');
    expect(usage).toContain('Update Yaver agent');
    expect(usage).toContain('updateDogfoodRenderAgent');
  });

  it('never renders on entry by default and safely drains the explicit render-on-open choice', () => {
    const usage = readFileSync(join(__dirname, '../DogfoodQuickControls.tsx'), 'utf8');
    expect(usage).toContain("behavior === 'render-on-open'");
    expect(usage).toContain('entryRenderPending');
    expect(usage).toContain("session.status === 'running' || session.status === 'queued'");
    expect(usage).toContain('await fastReload()');
  });
});
