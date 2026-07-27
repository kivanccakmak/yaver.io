// ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
//
// Dart port of `sdk/feedback/{web,react-native}/src/reloadActions.ts`. Same
// three questions, same answers, same wording — because a bug fixed in one
// SDK must not still be shipping in the other five.
//
//   1. WHICH actions may be shown at all (release build ⇒ none, ever)?
//   2. WHICH request does each action make (path + body)?
//   3. WHEN a reload fails, WHAT do we tell the user?
//
// Deliberately PURE — no http, no BuildContext, no globals. That is what
// makes it unit-testable, and the unit test is the guard: a release build
// must yield an empty action list.
//
// ── Wire contract (desktop/agent/devserver_http.go) ──────────────────────────
//
//   POST /dev/reload      {"mode": "fast" | "full"}
//        fast — Flutter stdin "r": HOT RELOAD. Keeps app state.
//        full — Flutter stdin "R": HOT RESTART. Resets app state.
//        The agent's FlutterDevServer.ReloadWithMode does exactly that
//        mapping; an absent/unknown mode normalises to "fast".
//
//   POST /dev/reload-app  {"mode": "bundle"}
//        Hermes bytecode rebuild — React Native ONLY. A Flutter app can
//        never load a Hermes bundle, so this SDK never offers it.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// No new secret. `/dev/reload` is registered under `authSDKOrGuest` in
// desktop/agent/httpserver.go — the same middleware that already admits the
// bearer this SDK sends with its feedback upload — and the scope-limited
// `guest-reload` SDK token already lists the route. Nothing widens.

/// Stable identifier for each action the overlay can render.
enum ReloadActionId { hot, full }

/// Wire value of the `mode` field on POST /dev/reload.
enum ReloadWireMode { fast, full }

/// The wire string for a mode. Pinned by test — the agent parses this.
String reloadWireModeValue(ReloadWireMode mode) =>
    mode == ReloadWireMode.full ? 'full' : 'fast';

/// Framework families whose reload vocabulary we borrow.
enum ReloadFrameworkFamily { flutter, reactNative, web, unknown }

/// Path constants, so a typo cannot diverge from the agent's routes.
const String kReloadPath = '/dev/reload';
const String kReloadAppPath = '/dev/reload-app';

/// The part of `GET /dev/status` this decision depends on.
class DevServerSnapshot {
  /// Is a dev server process alive on the machine?
  final bool running;

  /// Is it still compiling? A reload now would race the build.
  final bool building;

  /// Agent's framework name: expo | react-native | flutter | vite | nextjs.
  final String? framework;

  const DevServerSnapshot({
    required this.running,
    this.building = false,
    this.framework,
  });

  /// Parse a `/dev/status` body. Unknown/missing fields degrade to "not
  /// running" rather than to an optimistic default — claiming a dev server
  /// we have not seen is how a button ends up doing nothing in silence.
  factory DevServerSnapshot.fromJson(Map<String, dynamic> json) {
    return DevServerSnapshot(
      running: json['running'] == true,
      building: json['building'] == true,
      framework: json['framework'] is String ? json['framework'] as String : null,
    );
  }
}

/// One button the overlay may render.
class ReloadAction {
  final ReloadActionId id;

  /// Button label — stack-idiomatic wording lives here, not at the call site.
  final String label;

  /// One line under the button explaining what it actually does.
  final String hint;

  final ReloadWireMode mode;

  /// Agent path this action POSTs to.
  final String path;

  final bool enabled;

  /// Present exactly when [enabled] is false. Names the specific blocker and
  /// the fix — never "unavailable".
  final String? disabledReason;

  const ReloadAction({
    required this.id,
    required this.label,
    required this.hint,
    required this.mode,
    required this.path,
    required this.enabled,
    this.disabledReason,
  });

  /// The exact request body this action sends.
  Map<String, dynamic> get body => {'mode': reloadWireModeValue(mode)};
}

/// Map the agent's framework name onto a family.
///
/// An unrecognised framework still gets generic actions: the agent is the
/// authority on what it can do, and refusing to offer a reload because we
/// did not recognise a name would be us inventing a limit the product does
/// not have.
ReloadFrameworkFamily reloadFrameworkFamily(String? framework) {
  final f = (framework ?? '').trim().toLowerCase();
  if (f.isEmpty) return ReloadFrameworkFamily.unknown;
  if (f.contains('flutter')) return ReloadFrameworkFamily.flutter;
  if (f == 'expo' || f.contains('react-native') || f.contains('metro')) {
    return ReloadFrameworkFamily.reactNative;
  }
  if (f == 'vite' || f == 'next' || f == 'nextjs' || f == 'web' || f == 'webpack') {
    return ReloadFrameworkFamily.web;
  }
  return ReloadFrameworkFamily.unknown;
}

const Map<ReloadFrameworkFamily, List<List<String>>> _labels = {
  ReloadFrameworkFamily.flutter: [
    ['Hot Reload', 'Flutter hot reload (r) — keeps the current app state.'],
    ['Hot Restart', 'Flutter hot restart (R) — restarts the app and resets state.'],
  ],
  ReloadFrameworkFamily.reactNative: [
    ['Hot Reload', 'Fast Refresh through Metro — keeps component state.'],
    ['Full Reload', 'Reloads the whole JS bundle and resets state.'],
  ],
  ReloadFrameworkFamily.web: [
    ['Hot Reload', 'Hot module replacement through the dev server.'],
    ['Full Reload', 'Re-exports the bundle and reloads the page.'],
  ],
  ReloadFrameworkFamily.unknown: [
    ['Hot Reload', "The dev server's cheapest refresh."],
    ['Full Reload', 'Framework-level restart of the running app.'],
  ],
};

/// The whole decision, in one pure function.
///
/// Returns the ordered list the overlay should render. An EMPTY list means
/// "render no reload UI at all" — that is the release-build answer, and it is
/// deliberately indistinguishable from "this SDK has no reload feature",
/// because to a shipped app it doesn't.
///
/// A NON-empty list may still contain disabled entries: showing a greyed
/// "Hot Reload — no dev server is running on primary" teaches the user what
/// to fix. Hiding it teaches them nothing.
///
/// [isDevBuild] has no default on purpose. Every stack has its own signal —
/// Flutter's is `kDebugMode` from `package:flutter/foundation.dart` — and the
/// caller passes it. False means the list is EMPTY: a released app never gets
/// a reload button.
List<ReloadAction> reloadActions(
  DevServerSnapshot? snapshot, {
  required bool isDevBuild,
  required bool connected,
  String? machineLabel,
}) {
  // 1. Release build — never, under any circumstance.
  if (!isDevBuild) return const [];

  final snap = snapshot ?? const DevServerSnapshot(running: false);
  final labels = _labels[reloadFrameworkFamily(snap.framework)]!;
  final machine = (machineLabel ?? '').trim().isEmpty
      ? 'the selected machine'
      : machineLabel!.trim();

  String? blocked;
  if (!connected) {
    blocked = 'Not connected to a machine yet — pick one first.';
  } else if (snap.building) {
    blocked = 'The dev server is still building — reload works once it finishes.';
  } else if (!snap.running) {
    blocked = 'No dev server is running on $machine. '
        'Start one from the Yaver app, or run `yaver dev start` there.';
  }

  return [
    ReloadAction(
      id: ReloadActionId.hot,
      label: labels[0][0],
      hint: labels[0][1],
      mode: ReloadWireMode.fast,
      path: kReloadPath,
      enabled: blocked == null,
      disabledReason: blocked,
    ),
    ReloadAction(
      id: ReloadActionId.full,
      label: labels[1][0],
      hint: labels[1][1],
      mode: ReloadWireMode.full,
      path: kReloadPath,
      enabled: blocked == null,
      disabledReason: blocked,
    ),
  ];
}

/// Turn a failed reload into a sentence that names the cause AND the fix.
///
/// "Reload failed" is the shape of error this codebase keeps paying whole
/// sessions for. Every branch below exists because the raw text the agent
/// (or Go's net stack) produces is accurate and unreadable.
///
/// [status] 0 means the request never reached anything — a different
/// problem from a 5xx, and it needs a different sentence.
String describeReloadFailure(
  int status,
  String body, {
  DevServerSnapshot? snapshot,
}) {
  final lower = body.toLowerCase();
  final framework = (snapshot?.framework ?? '').trim();

  if (lower.contains('does not support hot reload')) {
    final name = framework.isEmpty ? 'This dev server' : framework;
    return '$name cannot hot reload. Restart the dev server, or run the app '
        'from a framework that supports it.';
  }
  if (status == 503 ||
      lower.contains('no dev server') ||
      lower.contains('dev server not available')) {
    return 'No dev server is running on the machine. Start one before reloading.';
  }
  if ((lower.contains('connection refused') || lower.contains('econnrefused')) &&
      (lower.contains('127.0.0.1') || lower.contains('localhost'))) {
    return 'The dev server is not listening on the machine. '
        'Start it with `yaver dev start`.';
  }
  if (status == 401 || status == 403) {
    return 'The machine rejected this session — sign in again, or re-pair this device.';
  }
  if (status == 404) {
    return 'This machine’s agent has no /dev/reload route — it is too old. '
        'Update it with `npm install -g yaver-cli@latest`.';
  }
  if (status >= 500) {
    return 'The agent hit an internal error while reloading. '
        'Check `yaver logs` on the machine.';
  }
  if (status == 0) {
    return 'Could not reach the machine. Check that it is online and '
        '`yaver serve` is running.';
  }
  return 'Reload failed (HTTP $status).';
}
