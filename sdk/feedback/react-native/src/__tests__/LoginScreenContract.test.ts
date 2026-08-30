import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'LoginScreen.tsx'), 'utf8');

describe('LoginScreen keyboard contract', () => {
  it('makes the iOS scroll view the only keyboard-inset owner', () => {
    expect(source).toContain("automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}");
    expect(source).toContain("behavior={Platform.OS === 'android' ? 'height' : undefined}");
    expect(source).not.toContain("behavior={Platform.OS === 'ios' ? 'padding' : undefined}");
  });

  it('reveals the mounted email controls and focused password fields', () => {
    expect(source).toContain('ref={scrollRef}');
    expect(source).toContain('scrollRef.current?.scrollToEnd({ animated: true })');
    expect(source).toContain('onFocus={revealEmailControls}');
  });
});
