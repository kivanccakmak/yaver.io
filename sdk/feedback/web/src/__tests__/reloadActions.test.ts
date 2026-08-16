import {
  describeReloadFailure,
  reloadActions,
  reloadFrameworkFamily,
  reloadRequest,
  RELOAD_APP_PATH,
  RELOAD_PATH,
} from '../reloadActions';

const DEV = { isDevBuild: true, connected: true };

describe('reloadActions — the production guard', () => {
  // THIS IS THE GUARD. Prove it by breaking it: flip `if (!opts.isDevBuild)`
  // in reloadActions.ts to `if (opts.isDevBuild)` and this test fails while
  // every other test in this file still passes.
  it('returns NOTHING in a production build, even with a healthy dev server', () => {
    const actions = reloadActions(
      { running: true, framework: 'vite' },
      { isDevBuild: false, connected: true, includeRebuild: true },
    );
    expect(actions).toEqual([]);
  });

  it('returns actions in a dev build', () => {
    const actions = reloadActions({ running: true, framework: 'vite' }, DEV);
    expect(actions.map((a) => a.id)).toEqual(['hot', 'full']);
    expect(actions.every((a) => a.enabled)).toBe(true);
  });
});

describe('reloadFrameworkFamily', () => {
  it.each([
    ['flutter', 'flutter'],
    ['expo', 'react-native'],
    ['react-native', 'react-native'],
    ['vite', 'web'],
    ['nextjs', 'web'],
    ['', 'unknown'],
    ['godot', 'unknown'],
  ])('maps %s → %s', (framework, family) => {
    expect(reloadFrameworkFamily(framework)).toBe(family);
  });
});

describe('per-stack labels', () => {
  it('calls the full action a Hot Restart on Flutter (stdin R), not a Full Reload', () => {
    const actions = reloadActions({ running: true, framework: 'flutter' }, DEV);
    expect(actions.find((a) => a.id === 'hot')!.label).toBe('Hot Reload');
    expect(actions.find((a) => a.id === 'full')!.label).toBe('Hot Restart');
    expect(actions.find((a) => a.id === 'full')!.hint).toContain('(R)');
  });

  it('calls it a Full Reload everywhere else', () => {
    for (const framework of ['expo', 'vite', 'nextjs']) {
      const actions = reloadActions({ running: true, framework }, DEV);
      expect(actions.find((a) => a.id === 'full')!.label).toBe('Full Reload');
    }
  });
});

describe('URL / payload construction', () => {
  it('sends fast for hot and full for full, both to /dev/reload', () => {
    const actions = reloadActions({ running: true, framework: 'flutter' }, DEV);
    expect(reloadRequest(actions[0])).toEqual({
      method: 'POST',
      path: RELOAD_PATH,
      body: { mode: 'fast' },
    });
    expect(reloadRequest(actions[1])).toEqual({
      method: 'POST',
      path: RELOAD_PATH,
      body: { mode: 'full' },
    });
  });

  it('routes the RN bundle rebuild to /dev/reload-app', () => {
    const actions = reloadActions(
      { running: false },
      { ...DEV, includeRebuild: true },
    );
    const rebuild = actions.find((a) => a.id === 'rebuild')!;
    expect(reloadRequest(rebuild)).toEqual({
      method: 'POST',
      path: RELOAD_APP_PATH,
      body: { mode: 'bundle' },
    });
  });
});

describe('a blocked action NAMES the blocker', () => {
  it('names the missing dev server and the command that starts it', () => {
    const actions = reloadActions({ running: false }, { ...DEV, machineLabel: 'primary' });
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.enabled).toBe(false);
      expect(action.disabledReason).toContain('primary');
      expect(action.disabledReason).toContain('yaver dev start');
    }
  });

  it('names "still building" rather than pretending nothing is running', () => {
    const actions = reloadActions({ running: true, building: true, framework: 'expo' }, DEV);
    expect(actions[0].disabledReason).toContain('still building');
  });

  it('names the missing machine when disconnected', () => {
    const actions = reloadActions(
      { running: true, framework: 'expo' },
      { isDevBuild: true, connected: false },
    );
    expect(actions[0].disabledReason).toContain('Not connected');
  });

  it('keeps Rebuild Bundle ENABLED with no dev server — that is its whole point', () => {
    const actions = reloadActions({ running: false }, { ...DEV, includeRebuild: true });
    const rebuild = actions.find((a) => a.id === 'rebuild')!;
    expect(rebuild.enabled).toBe(true);
    expect(rebuild.disabledReason).toBeUndefined();
  });

  it('disables Rebuild Bundle when there is no machine', () => {
    const actions = reloadActions(
      { running: true },
      { isDevBuild: true, connected: false, includeRebuild: true },
    );
    expect(actions.find((a) => a.id === 'rebuild')!.enabled).toBe(false);
  });
});

describe('describeReloadFailure names a cause, never "failed"', () => {
  it('503 → no dev server', () => {
    expect(describeReloadFailure(503, 'dev server not available')).toContain(
      'No dev server is running',
    );
  });

  it('framework cannot hot reload → says so and points at the alternative', () => {
    const msg = describeReloadFailure(500, 'unity does not support hot reload', {
      running: true,
      framework: 'unity',
    });
    expect(msg).toContain('unity');
    expect(msg).toContain('Rebuild Bundle');
  });

  it('loopback connection refused → the dev server is not listening', () => {
    const msg = describeReloadFailure(
      502,
      'Get "http://127.0.0.1:8081/reload": dial tcp 127.0.0.1:8081: connect: connection refused',
    );
    expect(msg).toContain('not listening');
    expect(msg).toContain('yaver dev start');
  });

  it('401/403 → session, not server', () => {
    expect(describeReloadFailure(401, '')).toContain('sign in again');
    expect(describeReloadFailure(403, '')).toContain('sign in again');
  });

  it('404 → the agent is too old, and says how to update it', () => {
    expect(describeReloadFailure(404, 'not found')).toContain('yaver-cli@latest');
  });

  it('5xx → points at the agent log', () => {
    expect(describeReloadFailure(500, 'boom')).toContain('yaver logs');
  });

  it('status 0 (transport never answered) → machine reachability', () => {
    expect(describeReloadFailure(0, '')).toContain('yaver serve');
  });
});
