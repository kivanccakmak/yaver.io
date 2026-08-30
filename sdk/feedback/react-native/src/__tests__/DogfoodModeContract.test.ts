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
    expect(usage).toContain('Session setup');
    expect(usage).toContain('Back to native app');
    expect(usage).toContain('yaverFeedback:dogfoodUsageRequested');
  });

  it('states that both choices use OAuth and installation approval', () => {
    const settings = readFileSync(join(__dirname, '../DogfoodSettings.tsx'), 'utf8');
    expect(settings).toContain('full Yaver OAuth account and approved installation');
    expect(settings).toContain('Reload Only');
    expect(settings).toContain('Reload + Chat');
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
});
