import { readFileSync } from 'fs';
import { join } from 'path';

describe('Vibe chat overlay dismissal', () => {
  it('clears Close but lets Minimize preserve the live chat route', () => {
    const source = readFileSync(join(__dirname, '..', 'FeedbackModal.tsx'), 'utf8');
    expect(source).toMatch(/onClose=\{\(\) => \{\s*setActiveVibe\(null\);\s*handleClose\(\);\s*\}\}/);
    expect(source).toContain('onMinimize={handleClose}');
  });
});
