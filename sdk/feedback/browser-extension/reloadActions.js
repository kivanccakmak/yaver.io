/* eslint-disable no-undef */
// ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
//
// Plain-script port of sdk/feedback/{web,react-native}/src/reloadActions.ts,
// with the same wording as the Flutter, Unity, Swift and Kotlin ports. Same
// three questions, same answers — because a bug fixed in one SDK must not
// still be shipping in the other six:
//
//   1. WHICH actions may be shown at all?
//   2. WHICH request does each action make (path + body)?
//   3. WHEN a reload fails, WHAT do we tell the user?
//
// No bundler here on purpose (the extension has no build step — see
// package.json's `pack` script), so this file attaches to `globalThis` for
// the popup + service worker and also exports for `node --test`.
//
// ── Wire contract (desktop/agent/devserver_http.go) ──────────────────────────
//
//   POST /dev/reload  {"mode": "fast" | "full"}
//        fast — the dev server's cheapest refresh (Vite/Next HMR).
//        full — framework-level restart; on the static web-bundle lane the
//               agent additionally forces a warm re-export.
//        Absent/unknown normalises to "fast" on the agent.
//
//   /dev/reload-app (Hermes bundle) is React Native only and is never offered
//   from a browser extension.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// No new secret: the extension sends the SAME `Authorization: Bearer <token>`
// it already sends when POSTing a design-reference bundle. /dev/reload sits
// behind `authSDKOrGuest` on the agent and is already inside the
// `guest-reload` SDK-token scope.

(function attachYaverReloadActions(root) {
  'use strict';

  var RELOAD_PATH = '/dev/reload';
  var RELOAD_APP_PATH = '/dev/reload-app';
  var STATUS_PATH = '/dev/status';

  /**
   * Map the agent's framework name onto the family whose reload vocabulary we
   * borrow. Unknown frameworks still get generic actions: the agent is the
   * authority on what it can do, and refusing to offer a reload because we did
   * not recognise a name would be us inventing a limit the product lacks.
   */
  function reloadFrameworkFamily(framework) {
    var f = String(framework || '').trim().toLowerCase();
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

  var LABELS = {
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

  /**
   * Is this agent URL one the extension is actually allowed to drive?
   *
   * This is the extension's equivalent of the other SDKs' "is this a dev
   * build" gate, and it is not a guess: manifest.json's `host_permissions`
   * grant localhost and 127.0.0.1 ONLY. Pointing the extension at a public
   * host cannot work, so offering reload buttons for one would be offering an
   * action that cannot succeed — the exact thing this seam exists to prevent.
   */
  function isDevAgentUrl(agentUrl) {
    var raw = String(agentUrl || '').trim();
    if (!raw) return false;
    var host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch (e) {
      return false;
    }
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  }

  /**
   * The whole decision, in one pure function.
   *
   * An EMPTY list means "render no reload UI at all". A NON-empty list may
   * still contain disabled entries: showing a greyed "Hot Reload — no dev
   * server is running" teaches the user what to fix. Hiding it teaches them
   * nothing.
   *
   * `opts.isDevBuild` has no default — pass `isDevAgentUrl(settings.agentUrl)`.
   */
  function reloadActions(snapshot, opts) {
    var options = opts || {};
    if (!options.isDevBuild) return [];

    var snap = snapshot || { running: false };
    var labels = LABELS[reloadFrameworkFamily(snap.framework)];
    var machine = String(options.machineLabel || '').trim() || 'the selected machine';

    var blocked;
    if (!options.connected) {
      blocked = 'Not connected to a machine yet — check the agent URL below.';
    } else if (snap.building) {
      blocked = 'The dev server is still building — reload works once it finishes.';
    } else if (!snap.running) {
      blocked =
        'No dev server is running on ' + machine +
        '. Start one from the Yaver app, or run `yaver dev start` there.';
    }

    return [
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
  }

  /** The exact request an action makes. Kept next to the labels on purpose. */
  function reloadRequest(action) {
    return { method: 'POST', path: action.path, body: { mode: action.mode } };
  }

  /**
   * Turn a failed reload into a sentence that names the cause AND the fix.
   *
   * "Reload failed" is the shape of error this codebase keeps paying whole
   * sessions for. Every branch exists because the raw text the agent (or Go's
   * net stack) produces is accurate and unreadable.
   *
   * status 0 means the request never reached anything — a different problem
   * from a 5xx, needing a different sentence.
   */
  function describeReloadFailure(status, body, snapshot) {
    var lower = String(body || '').toLowerCase();
    var framework = String((snapshot && snapshot.framework) || '').trim();

    if (lower.indexOf('does not support hot reload') >= 0) {
      return (framework || 'This dev server') +
        ' cannot hot reload. Restart the dev server on the machine.';
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
      return 'The agent rejected this token — check the auth token in the settings below.';
    }
    if (status === 404) {
      return "This machine's agent has no /dev/reload route — it is too old. " +
        'Update it with `npm install -g yaver-cli@latest`.';
    }
    if (status >= 500) {
      return 'The agent hit an internal error while reloading. Check `yaver logs` on the machine.';
    }
    if (status === 0) {
      return 'Could not reach the agent. Check that it is running (`yaver serve`) and the URL below.';
    }
    return 'Reload failed (HTTP ' + status + ').';
  }

  var api = {
    RELOAD_PATH: RELOAD_PATH,
    RELOAD_APP_PATH: RELOAD_APP_PATH,
    STATUS_PATH: STATUS_PATH,
    reloadFrameworkFamily: reloadFrameworkFamily,
    isDevAgentUrl: isDevAgentUrl,
    reloadActions: reloadActions,
    reloadRequest: reloadRequest,
    describeReloadFailure: describeReloadFailure,
  };

  root.YaverReloadActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
