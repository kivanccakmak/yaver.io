import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FEEDBACK_DOGFOOD_CONSOLE_COLORS,
  FEEDBACK_DOGFOOD_LIGHT_COLORS,
} from '../FeedbackModalTheme';

const SOURCE_PATH = join(__dirname, '..', 'FeedbackModal.tsx');

describe('FeedbackModal authenticated chat contract', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it('themes every shared Dogfood surface for the light feedback sheet', () => {
    expect(source).toMatch(/<DogfoodStatusRail[\s\S]*?colors=\{FEEDBACK_DOGFOOD_LIGHT_COLORS\}/);
    expect(source).toMatch(/<DogfoodLanePicker[\s\S]*?colors=\{FEEDBACK_DOGFOOD_LIGHT_COLORS\}/);
    expect(source).toMatch(/<DogfoodLiveConsole[\s\S]*?colors=\{FEEDBACK_DOGFOOD_CONSOLE_COLORS\}/);
  });

  it('keeps normal light-sheet copy at WCAG AA contrast', () => {
    const rgb = (hex: string) => hex.match(/[a-f\d]{2}/gi)!.map((part) => parseInt(part, 16) / 255);
    const luminance = (hex: string) => {
      const channels = rgb(hex).map((channel) => channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground: string, background: string) => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };

    for (const foreground of [
      FEEDBACK_DOGFOOD_LIGHT_COLORS.text,
      FEEDBACK_DOGFOOD_LIGHT_COLORS.muted,
      FEEDBACK_DOGFOOD_LIGHT_COLORS.accent,
      FEEDBACK_DOGFOOD_LIGHT_COLORS.ready,
      FEEDBACK_DOGFOOD_LIGHT_COLORS.attention,
      FEEDBACK_DOGFOOD_LIGHT_COLORS.blocked,
    ]) {
      expect(ratio(foreground, FEEDBACK_DOGFOOD_LIGHT_COLORS.background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(FEEDBACK_DOGFOOD_CONSOLE_COLORS.text, FEEDBACK_DOGFOOD_CONSOLE_COLORS.console))
      .toBeGreaterThanOrEqual(4.5);
    expect(ratio(FEEDBACK_DOGFOOD_CONSOLE_COLORS.muted, FEEDBACK_DOGFOOD_CONSOLE_COLORS.console))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('uses Chat as the authenticated entry surface without legacy command buttons', () => {
    expect(source).toContain("setActiveTab(authenticated ? 'chat' : 'settings')");
    expect(source).toContain('setShowVibeInput(authenticated || directDogfood)');
    expect(source).not.toContain('Screenshot & Fix');
    expect(source).not.toContain('<DeployPanel');
  });

  it('has one iOS keyboard inset owner and no gesture-stealing sheet Pressable', () => {
    expect(source).toContain('automaticallyAdjustKeyboardInsets={Platform.OS === \'ios\'}');
    expect(source).not.toContain('<KeyboardAvoidingView');
    expect(source).not.toContain('keyboardInset');
    expect(source).toContain('<Pressable style={styles.backdrop} onPress={handleClose}');
    expect(source).toMatch(/<View[\s\S]{0,300}?style=\{\[\s*styles\.modal/);
  });
});
