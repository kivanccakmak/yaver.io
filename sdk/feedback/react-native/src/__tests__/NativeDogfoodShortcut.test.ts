import { readFileSync } from 'fs';
import { join } from 'path';

const plugin = require('../../app.plugin.js') as {
  __test: { patchDogfoodAppShortcut(contents: string): string };
};

describe('native Dogfood shortcut contract', () => {
  it('patches cold and warm iOS shortcut delivery idempotently', () => {
    const source = `
public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    setupYaverHotReload()
    return true
  }
}
`;
    const once = plugin.__test.patchDogfoodAppShortcut(source);
    expect(once).toContain('launchOptions?[.shortcutItem]');
    expect(once).toContain('performActionFor shortcutItem');
    expect(once).toContain('markDogfoodShortcutPending()');
    expect(plugin.__test.patchDogfoodAppShortcut(once)).toBe(once);
  });

  it('uses dynamic native shortcuts on both platforms', () => {
    const ios = readFileSync(join(__dirname, '../../ios/YaverHotReload.swift'), 'utf8');
    const android = readFileSync(join(__dirname, '../../android/src/main/java/io/yaver/feedback/YaverHotReloadModule.java'), 'utf8');
    expect(ios).toContain('UIApplication.shared.shortcutItems');
    expect(ios).toContain('setDogfoodShortcut');
    expect(android).toContain('ShortcutManager');
    expect(android).toContain('addDynamicShortcuts');
    expect(android).toContain('consumeDogfoodShortcut');
  });
});
