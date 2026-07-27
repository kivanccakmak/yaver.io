// ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
//
// The in-app overlay offers the developer a way to reload the app they are
// looking at, without leaving it. This file answers the three questions that
// have to be answered IDENTICALLY on every stack, so that a bug fixed in one
// SDK is not still shipping in the other five:
//
//   1. WHICH actions may be shown at all (production build ⇒ none, ever)?
//   2. WHICH request does each action make (path + body)?
//   3. WHEN a reload fails, WHAT do we tell the user?
//
// It is deliberately PURE — no fetch, no DOM, no globals. That is what makes
// it unit-testable, and the unit test is the guard: a production build must
// yield an empty action list. Break `isDevBuild` and the test fails.
//
// ── Wire contract (desktop/agent/devserver_http.go) ──────────────────────────
//
//   POST /dev/reload      { "mode": "fast" | "full" }
//        fast — the framework's cheapest refresh. Flutter stdin "r" (hot
//               reload, keeps state). Metro/Expo fast refresh. Vite/Next HMR.
//        full — framework-level restart. Flutter stdin "R" (hot RESTART,
//               resets state). Web lane additionally forces a warm re-export.
//               NEVER a cache clear or a process cold-start.
//        Absent/unknown mode is normalised to "fast" by the agent, so an old
//        client keeps its exact old behaviour.
//
//   POST /dev/reload-app  { "mode": "bundle", ...identity }
//        Rebuild the Hermes bytecode bundle on the agent and push it over the
//        BlackBox channel. React Native only, and the ONLY action that still
//        works when no dev server is running — which is why it stays enabled
//        in exactly that case.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// None of this needs a new secret. `/dev/reload` and `/dev/reload-app` are
// registered under `authSDKOrGuest` (desktop/agent/httpserver.go), the same
// middleware that already admits the bearer this SDK sends with its feedback
// POST. A scope-limited SDK token needs the existing `guest-reload` scope,
// whose path list already contains both routes — no widening, no new gate.

/** Stable identifier for each action the overlay can render. */
export type ReloadActionId = 'hot' | 'full' | 'rebuild';

/** Wire value of the `mode` field (or `bundle` for /dev/reload-app). */
export type ReloadWireMode = 'fast' | 'full' | 'bundle';

/** The part of GET /dev/status this decision depends on. */
export interface DevServerSnapshot {
  /** Is a dev server process alive on the machine? */
  running: boolean;
  /** Is it still compiling? A reload now would race the build. */
  building?: boolean;
  /** Agent's framework name: expo | react-native | flutter | vite | nextjs. */
  framework?: string;
}

export interface ReloadActionsOptions {
  /**
   * Is the HOST APP a development build?
   *
   * There is no honest default here, so there is no default: every stack has
   * its own signal (`__DEV__`, `kDebugMode`, `Debug.isDebugBuild`,
   * `FLAG_DEBUGGABLE`, `#if DEBUG`) and the caller passes it. False means the
   * list is EMPTY — a shipped app never gets a reload button.
   */
  isDevBuild: boolean;
  /** Do we have an agent connection / selected machine at all? */
  connected: boolean;
  /** Human label for the machine, used inside the disabled reason. */
  machineLabel?: string;
  /**
   * Offer the React Native bundle rebuild as a third action. Only the RN SDK
   * can act on the pushed bundle, so only the RN SDK sets this.
   */
  includeRebuild?: boolean;
}

export interface ReloadAction {
  id: ReloadActionId;
  /** Button label — stack-idiomatic wording lives here, not at the call site. */
  label: string;
  /** One line under/next to the button explaining what it actually does. */
  hint: string;
  mode: ReloadWireMode;
  /** Agent path this action POSTs to. */
  path: string;
  enabled: boolean;
  /**
   * Present exactly when `enabled` is false. Names the specific blocker and
   * the fix — never "unavailable".
   */
  disabledReason?: string;
}

type FrameworkFamily = 'flutter' | 'react-native' | 'web' | 'unknown';

/**
 * Map the agent's framework name onto the family whose reload vocabulary we
 * borrow. Unknown frameworks still get generic actions: the agent is the
 * authority on what it can do, and refusing to offer a reload because we did
 * not recognise a name would be us inventing a limit the product does not have.
 */
export function reloadFrameworkFamily(framework?: string): FrameworkFamily {
  const f = (framework || '').trim().toLowerCase();
  if (!f) return 'unknown';
  if (f.indexOf('flutter') >= 0) return 'flutter';
  if (f === 'expo' || f.indexOf('react-native') >= 0 || f.indexOf('metro') >= 0) {
    return 'react-native';
  }
  if (f === 'vite' || f === 'next' || f === 'nextjs' || f === 'web' || f === 'webpack') {
    return 'web';
  }
  return 'unknown';
}

const LABELS: Record<FrameworkFamily, { hot: [string, string]; full: [string, string] }> = {
  flutter: {
    hot: ['Hot Reload', 'Flutter hot reload (r) — keeps the current app state.'],
    full: ['Hot Restart', 'Flutter hot restart (R) — restarts the app and resets state.'],
  },
  'react-native': {
    hot: ['Hot Reload', 'Fast Refresh through Metro — keeps component state.'],
    full: ['Full Reload', 'Reloads the whole JS bundle and resets state.'],
  },
  web: {
    hot: ['Hot Reload', 'Hot module replacement through the dev server.'],
    full: ['Full Reload', 'Re-exports the bundle and reloads the page.'],
  },
  unknown: {
    hot: ['Hot Reload', "The dev server's cheapest refresh."],
    full: ['Full Reload', 'Framework-level restart of the running app.'],
  },
};

/** Path constants — mirrored from AGENT_ENDPOINTS so a typo cannot diverge. */
export const RELOAD_PATH = '/dev/reload';
export const RELOAD_APP_PATH = '/dev/reload-app';

/**
 * The whole decision, in one pure function.
 *
 * Returns the ordered list the overlay should render. An EMPTY list means
 * "render no reload UI at all" — that is the production-build answer, and it
 * is deliberately indistinguishable from "this SDK has no reload feature",
 * because to a shipped app it doesn't.
 *
 * A NON-empty list may still contain disabled entries: showing a greyed
 * "Hot Reload — no dev server is running on primary" teaches the user what
 * to fix. Hiding it teaches them nothing.
 */
export function reloadActions(
  snapshot: DevServerSnapshot | null | undefined,
  opts: ReloadActionsOptions,
): ReloadAction[] {
  // 1. Production build — never, under any circumstance.
  if (!opts.isDevBuild) return [];

  const snap: DevServerSnapshot = snapshot || { running: false };
  const family = reloadFrameworkFamily(snap.framework);
  const labels = LABELS[family];
  const machine = (opts.machineLabel || '').trim() || 'the selected machine';

  let blocked: string | undefined;
  if (!opts.connected) {
    blocked = 'Not connected to a machine yet — pick one first.';
  } else if (snap.building) {
    blocked = 'The dev server is still building — reload works once it finishes.';
  } else if (!snap.running) {
    blocked =
      `No dev server is running on ${machine}. ` +
      'Start one from the Yaver app, or run `yaver dev start` there.';
  }

  const actions: ReloadAction[] = [
    {
      id: 'hot',
      label: labels.hot[0],
      hint: labels.hot[1],
      mode: 'fast',
      path: RELOAD_PATH,
      enabled: !blocked,
      disabledReason: blocked,
    },
    {
      id: 'full',
      label: labels.full[0],
      hint: labels.full[1],
      mode: 'full',
      path: RELOAD_PATH,
      enabled: !blocked,
      disabledReason: blocked,
    },
  ];

  if (opts.includeRebuild) {
    // Deliberately NOT gated on `running`: rebuilding the bundle is exactly
    // what you do when Metro is not up. It is gated on `connected`, because
    // without a machine there is nothing to rebuild on.
    const rebuildBlocked = opts.connected
      ? undefined
      : 'Not connected to a machine yet — pick one first.';
    actions.push({
      id: 'rebuild',
      label: 'Rebuild Bundle',
      hint: 'Recompiles the Hermes bundle on the machine. Works with no dev server.',
      mode: 'bundle',
      path: RELOAD_APP_PATH,
      enabled: !rebuildBlocked,
      disabledReason: rebuildBlocked,
    });
  }

  return actions;
}

/** The exact request an action makes. Kept next to the labels on purpose. */
export function reloadRequest(action: Pick<ReloadAction, 'mode' | 'path'>): {
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
} {
  return { method: 'POST', path: action.path, body: { mode: action.mode } };
}

/**
 * Turn a failed reload into a sentence that names the cause AND the fix.
 *
 * "Reload failed" is the shape of error this codebase keeps paying whole
 * sessions for. Every branch below exists because the raw text the agent (or
 * Go's net stack) produces is accurate and unreadable.
 */
export function describeReloadFailure(
  status: number,
  body: string,
  snapshot?: DevServerSnapshot | null,
): string {
  const lower = (body || '').toLowerCase();
  const framework = (snapshot?.framework || '').trim();

  if (lower.indexOf('does not support hot reload') >= 0) {
    const name = framework || 'This dev server';
    return `${name} cannot hot reload. Use Rebuild Bundle, or restart the dev server.`;
  }
  if (
    status === 503 ||
    lower.indexOf('no dev server') >= 0 ||
    lower.indexOf('dev server not available') >= 0
  ) {
    return 'No dev server is running on the machine. Start one before reloading.';
  }
  if (
    (lower.indexOf('connection refused') >= 0 || lower.indexOf('econnrefused') >= 0) &&
    (lower.indexOf('127.0.0.1') >= 0 || lower.indexOf('localhost') >= 0)
  ) {
    return 'The dev server is not listening on the machine. Start it with `yaver dev start`.';
  }
  if (status === 401 || status === 403) {
    return 'The machine rejected this session — sign in again, or re-pair this device.';
  }
  if (status === 404) {
    return (
      'This machine’s agent has no /dev/reload route — it is too old. ' +
      'Update it with `npm install -g yaver-cli@latest`.'
    );
  }
  if (status >= 500) {
    return 'The agent hit an internal error while reloading. Check `yaver logs` on the machine.';
  }
  if (status === 0) {
    return 'Could not reach the machine. Check that it is online and `yaver serve` is running.';
  }
  return `Reload failed (HTTP ${status}).`;
}
