/* eslint-disable no-undef */
const test = require('node:test');
const assert = require('node:assert');

const {
  RELOAD_APP_PATH,
  RELOAD_PATH,
  describeReloadFailure,
  isDevAgentUrl,
  reloadActions,
  reloadFrameworkFamily,
  reloadRequest,
} = require('../reloadActions.js');

const DEV = { isDevBuild: true, connected: true };
const running = (framework) => ({ running: true, framework });

// ─── THE GUARD ───────────────────────────────────────────────────────────────
//
// Prove it by breaking it: change `if (!options.isDevBuild) return [];` in
// reloadActions.js to `if (options.isDevBuild) return [];` and this single
// test fails while every other test in this file still passes.
test('a non-dev context gets NOTHING, even with a healthy dev server', () => {
  const actions = reloadActions(running('vite'), { isDevBuild: false, connected: true });
  assert.deepStrictEqual(actions, []);
});

test('a dev context gets hot + full', () => {
  const actions = reloadActions(running('vite'), DEV);
  assert.deepStrictEqual(actions.map((a) => a.id), ['hot', 'full']);
  assert.ok(actions.every((a) => a.enabled));
});

// ─── isDevAgentUrl is the extension's version of "is this a dev build" ───────
//
// manifest.json grants host_permissions for localhost + 127.0.0.1 ONLY, so a
// public agent URL cannot work — offering reload buttons for one would be
// offering an action that cannot succeed.
test('isDevAgentUrl accepts only hosts the manifest actually permits', () => {
  assert.strictEqual(isDevAgentUrl('http://localhost:18080'), true);
  assert.strictEqual(isDevAgentUrl('http://127.0.0.1:18080'), true);
  assert.strictEqual(isDevAgentUrl('https://localhost:18443'), true);
  assert.strictEqual(isDevAgentUrl('http://box.localhost:18080'), true);

  assert.strictEqual(isDevAgentUrl('https://public.yaver.io/d/abc'), false);
  assert.strictEqual(isDevAgentUrl('http://192.168.1.42:18080'), false);
  assert.strictEqual(isDevAgentUrl(''), false);
  assert.strictEqual(isDevAgentUrl('not a url'), false);
  assert.strictEqual(isDevAgentUrl(undefined), false);
});

test('reloadFrameworkFamily maps the agent framework names', () => {
  assert.strictEqual(reloadFrameworkFamily('flutter'), 'flutter');
  assert.strictEqual(reloadFrameworkFamily('expo'), 'react-native');
  assert.strictEqual(reloadFrameworkFamily('react-native'), 'react-native');
  assert.strictEqual(reloadFrameworkFamily('vite'), 'web');
  assert.strictEqual(reloadFrameworkFamily('nextjs'), 'web');
  assert.strictEqual(reloadFrameworkFamily(''), 'unknown');
  assert.strictEqual(reloadFrameworkFamily('godot'), 'unknown');
});

test('Flutter second action is a Hot Restart, everyone else a Full Reload', () => {
  const flutter = reloadActions(running('flutter'), DEV);
  assert.strictEqual(flutter[0].label, 'Hot Reload');
  assert.strictEqual(flutter[1].label, 'Hot Restart');
  assert.ok(flutter[1].hint.includes('(R)'));

  for (const framework of ['expo', 'vite', 'nextjs']) {
    assert.strictEqual(reloadActions(running(framework), DEV)[1].label, 'Full Reload', framework);
  }
});

test('URL / payload construction', () => {
  const actions = reloadActions(running('vite'), DEV);
  assert.deepStrictEqual(reloadRequest(actions[0]), {
    method: 'POST',
    path: RELOAD_PATH,
    body: { mode: 'fast' },
  });
  assert.deepStrictEqual(reloadRequest(actions[1]), {
    method: 'POST',
    path: RELOAD_PATH,
    body: { mode: 'full' },
  });
});

test('never offers the Hermes bundle path from a browser extension', () => {
  const actions = reloadActions(running('react-native'), DEV);
  assert.ok(!actions.some((a) => a.path === RELOAD_APP_PATH));
});

test('a blocked action NAMES the blocker', () => {
  const noServer = reloadActions({ running: false }, { ...DEV, machineLabel: 'localhost:18080' });
  for (const action of noServer) {
    assert.strictEqual(action.enabled, false);
    assert.ok(action.disabledReason.includes('localhost:18080'));
    assert.ok(action.disabledReason.includes('yaver dev start'));
  }

  const building = reloadActions({ running: true, building: true, framework: 'vite' }, DEV);
  assert.ok(building[0].disabledReason.includes('still building'));

  const offline = reloadActions(running('vite'), { isDevBuild: true, connected: false });
  assert.ok(offline[0].disabledReason.includes('Not connected'));
});

test('describeReloadFailure names a cause, never just "failed"', () => {
  assert.ok(describeReloadFailure(503, 'dev server not available').includes('No dev server is running'));
  assert.ok(
    describeReloadFailure(500, 'vite does not support hot reload', running('vite')).includes('vite'),
  );
  assert.ok(
    describeReloadFailure(
      502,
      'Get "http://127.0.0.1:5173/reload": dial tcp 127.0.0.1:5173: connect: connection refused',
    ).includes('not listening'),
  );
  assert.ok(describeReloadFailure(401, '').includes('auth token'));
  assert.ok(describeReloadFailure(403, '').includes('auth token'));
  assert.ok(describeReloadFailure(404, 'not found').includes('yaver-cli@latest'));
  assert.ok(describeReloadFailure(500, 'boom').includes('yaver logs'));
  assert.ok(describeReloadFailure(0, '').includes('yaver serve'));
});
