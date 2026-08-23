import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const launcherPath = new URL('./open-mobile-app.mjs', import.meta.url);

test('launcher keeps the global URL constructor available to diagnostics', async () => {
  const source = await readFile(launcherPath, 'utf8');

  assert.doesNotMatch(
    source,
    /\b(?:const|let|var)\s+URL\b/,
    'an app-address variable named URL shadows the constructor used by request handlers',
  );
  assert.match(source, /new URL\(response\.url\(\)\)/);
  assert.match(source, /new URL\(request\.url\(\)\)/);
});

test('launcher starts the local RN-web operation before opening Chromium', async () => {
  const source = await readFile(launcherPath, 'utf8');

  assert.match(source, /await ensureMobileWebApp\(\)/);
  assert.match(source, /spawn\(expoBin, \['start', '--web', '--port', selectedPort/);
  assert.match(source, /BROWSER: 'none'/);
  assert.match(source, /await appResponds\(\)/);
  assert.match(source, /await portIsFree\(port\)/);
  assert.match(source, /MOBILE_SHELL_MARKER/);
  assert.match(source, /identity\?\.product === 'yaver-mobile'/);
  assert.match(source, /await openWhenMounted\(page\)/);
  assert.match(source, /document\.getElementById\('root'\)\?\.children\.length > 0/);
  assert.match(source, /Expo is not installed for mobile\//);
});
