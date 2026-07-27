using System.Collections.Generic;

namespace Yaver.Feedback
{
    // ─── Reload actions — the ONE decision seam every Yaver feedback SDK mirrors ──
    //
    // C# port of sdk/feedback/{web,react-native}/src/reloadActions.ts and
    // sdk/feedback/flutter/lib/src/reload_actions.dart. Same three questions,
    // same answers, same wording — because a bug fixed in one SDK must not
    // still be shipping in the other five:
    //
    //   1. WHICH actions may be shown at all (release build ⇒ none, ever)?
    //   2. WHICH request does each action make (path + body)?
    //   3. WHEN a reload fails, WHAT do we tell the user?
    //
    // Deliberately PURE — no UnityWebRequest, no MonoBehaviour, no statics
    // reaching into runtime state. That is what makes it EditMode-testable
    // without a player, and the test is the guard.
    //
    // ── Wire contract (desktop/agent/devserver_http.go) ──────────────────────
    //
    //   POST /dev/reload      {"mode": "fast" | "full"}
    //        fast — the dev server's cheapest refresh.
    //        full — framework-level restart (Flutter stdin "R").
    //        Absent/unknown normalises to "fast" on the agent, so an old
    //        client keeps its exact old behaviour.
    //
    //   POST /dev/reload-app  {"mode": "bundle"}
    //        Hermes bytecode rebuild — React Native ONLY. A Unity player can
    //        never load one, so this SDK does not offer it. Unity's own
    //        in-place refresh paths (scene reload, Addressables content
    //        refresh) are separate and already wired elsewhere.
    //
    // ── Auth ─────────────────────────────────────────────────────────────────
    //
    // No new secret. /dev/reload is registered under authSDKOrGuest in
    // desktop/agent/httpserver.go — the same middleware that already admits
    // the bearer this SDK sends with its feedback POST — and the
    // scope-limited `guest-reload` SDK token already lists the route.

    /// <summary>Stable identifier for each action the overlay can render.</summary>
    public enum YaverReloadActionId
    {
        Hot,
        Full
    }

    /// <summary>Framework families whose reload vocabulary we borrow.</summary>
    public enum YaverReloadFrameworkFamily
    {
        Flutter,
        ReactNative,
        Web,
        Unknown
    }

    /// <summary>The part of GET /dev/status this decision depends on.</summary>
    public sealed class YaverDevServerSnapshot
    {
        /// <summary>Is a dev server process alive on the machine?</summary>
        public bool Running;

        /// <summary>Is it still compiling? A reload now would race the build.</summary>
        public bool Building;

        /// <summary>Agent framework name: expo | react-native | flutter | vite | nextjs.</summary>
        public string Framework = string.Empty;
    }

    /// <summary>One button the overlay may render.</summary>
    public sealed class YaverReloadAction
    {
        public YaverReloadActionId Id;

        /// <summary>Button label — stack-idiomatic wording lives here.</summary>
        public string Label = string.Empty;

        /// <summary>One line explaining what the action actually does.</summary>
        public string Hint = string.Empty;

        /// <summary>Wire value of the `mode` field: "fast" or "full".</summary>
        public string Mode = YaverReloadActions.ModeFast;

        /// <summary>Agent path this action POSTs to.</summary>
        public string Path = YaverReloadActions.ReloadPath;

        public bool Enabled;

        /// <summary>
        /// Set exactly when <see cref="Enabled"/> is false. Names the specific
        /// blocker and the fix — never "unavailable".
        /// </summary>
        public string DisabledReason = string.Empty;

        /// <summary>The exact JSON body this action sends.</summary>
        public string BodyJson
        {
            get { return "{\"mode\":\"" + Mode + "\"}"; }
        }
    }

    public static class YaverReloadActions
    {
        public const string ModeFast = "fast";
        public const string ModeFull = "full";
        public const string ReloadPath = "/dev/reload";
        public const string ReloadAppPath = "/dev/reload-app";
        public const string StatusPath = "/dev/status";

        /// <summary>
        /// Map the agent's framework name onto a family.
        ///
        /// An unrecognised framework still gets generic actions: the agent is
        /// the authority on what it can do, and refusing to offer a reload
        /// because we did not recognise a name would be us inventing a limit
        /// the product does not have.
        /// </summary>
        public static YaverReloadFrameworkFamily FrameworkFamily(string framework)
        {
            var f = (framework ?? string.Empty).Trim().ToLowerInvariant();
            if (f.Length == 0) return YaverReloadFrameworkFamily.Unknown;
            if (f.Contains("flutter")) return YaverReloadFrameworkFamily.Flutter;
            if (f == "expo" || f.Contains("react-native") || f.Contains("metro"))
            {
                return YaverReloadFrameworkFamily.ReactNative;
            }
            if (f == "vite" || f == "next" || f == "nextjs" || f == "web" || f == "webpack")
            {
                return YaverReloadFrameworkFamily.Web;
            }
            return YaverReloadFrameworkFamily.Unknown;
        }

        private static void LabelsFor(
            YaverReloadFrameworkFamily family,
            out string hotLabel, out string hotHint,
            out string fullLabel, out string fullHint)
        {
            switch (family)
            {
                case YaverReloadFrameworkFamily.Flutter:
                    hotLabel = "Hot Reload";
                    hotHint = "Flutter hot reload (r) — keeps the current app state.";
                    fullLabel = "Hot Restart";
                    fullHint = "Flutter hot restart (R) — restarts the app and resets state.";
                    return;
                case YaverReloadFrameworkFamily.ReactNative:
                    hotLabel = "Hot Reload";
                    hotHint = "Fast Refresh through Metro — keeps component state.";
                    fullLabel = "Full Reload";
                    fullHint = "Reloads the whole JS bundle and resets state.";
                    return;
                case YaverReloadFrameworkFamily.Web:
                    hotLabel = "Hot Reload";
                    hotHint = "Hot module replacement through the dev server.";
                    fullLabel = "Full Reload";
                    fullHint = "Re-exports the bundle and reloads the page.";
                    return;
                default:
                    hotLabel = "Hot Reload";
                    hotHint = "The dev server's cheapest refresh.";
                    fullLabel = "Full Reload";
                    fullHint = "Framework-level restart of the running app.";
                    return;
            }
        }

        /// <summary>
        /// The whole decision, in one pure function.
        ///
        /// Returns the ordered list the overlay should render. An EMPTY list
        /// means "render no reload UI at all" — that is the release-build
        /// answer, and it is deliberately indistinguishable from "this SDK has
        /// no reload feature", because to a shipped player it doesn't.
        ///
        /// A NON-empty list may still contain disabled entries: showing a
        /// greyed "Hot Reload — no dev server is running on primary" teaches
        /// the user what to fix. Hiding it teaches them nothing.
        /// </summary>
        /// <param name="isDevBuild">
        /// Unity's signal is <c>UnityEngine.Debug.isDebugBuild ||
        /// Application.isEditor</c>. There is no default here on purpose:
        /// false means the list is EMPTY, and a shipped player never gets a
        /// reload button.
        /// </param>
        public static List<YaverReloadAction> Build(
            YaverDevServerSnapshot snapshot,
            bool isDevBuild,
            bool connected,
            string machineLabel = null)
        {
            var actions = new List<YaverReloadAction>();

            // 1. Release build — never, under any circumstance.
            if (!isDevBuild) return actions;

            var snap = snapshot ?? new YaverDevServerSnapshot();
            string hotLabel, hotHint, fullLabel, fullHint;
            LabelsFor(FrameworkFamily(snap.Framework), out hotLabel, out hotHint, out fullLabel, out fullHint);

            var machine = string.IsNullOrEmpty(machineLabel) || machineLabel.Trim().Length == 0
                ? "the selected machine"
                : machineLabel.Trim();

            var blocked = string.Empty;
            if (!connected)
            {
                blocked = "Not connected to a machine yet — pick one first.";
            }
            else if (snap.Building)
            {
                blocked = "The dev server is still building — reload works once it finishes.";
            }
            else if (!snap.Running)
            {
                blocked = "No dev server is running on " + machine +
                          ". Start one from the Yaver app, or run `yaver dev start` there.";
            }

            var enabled = blocked.Length == 0;

            actions.Add(new YaverReloadAction
            {
                Id = YaverReloadActionId.Hot,
                Label = hotLabel,
                Hint = hotHint,
                Mode = ModeFast,
                Path = ReloadPath,
                Enabled = enabled,
                DisabledReason = blocked,
            });
            actions.Add(new YaverReloadAction
            {
                Id = YaverReloadActionId.Full,
                Label = fullLabel,
                Hint = fullHint,
                Mode = ModeFull,
                Path = ReloadPath,
                Enabled = enabled,
                DisabledReason = blocked,
            });

            return actions;
        }

        /// <summary>
        /// Turn a failed reload into a sentence that names the cause AND the fix.
        ///
        /// "Reload failed" is the shape of error this codebase keeps paying
        /// whole sessions for. Every branch below exists because the raw text
        /// the agent (or Go's net stack) produces is accurate and unreadable.
        ///
        /// <paramref name="status"/> 0 means the request never reached
        /// anything — a different problem from a 5xx, needing a different
        /// sentence.
        /// </summary>
        public static string DescribeFailure(int status, string body, YaverDevServerSnapshot snapshot = null)
        {
            var lower = (body ?? string.Empty).ToLowerInvariant();
            var framework = snapshot != null ? (snapshot.Framework ?? string.Empty).Trim() : string.Empty;

            if (lower.Contains("does not support hot reload"))
            {
                var name = framework.Length == 0 ? "This dev server" : framework;
                return name + " cannot hot reload. Restart the dev server, or use Unity's scene reload instead.";
            }
            if (status == 503 || lower.Contains("no dev server") || lower.Contains("dev server not available"))
            {
                return "No dev server is running on the machine. Start one before reloading.";
            }
            if ((lower.Contains("connection refused") || lower.Contains("econnrefused")) &&
                (lower.Contains("127.0.0.1") || lower.Contains("localhost")))
            {
                return "The dev server is not listening on the machine. Start it with `yaver dev start`.";
            }
            if (status == 401 || status == 403)
            {
                return "The machine rejected this session — sign in again, or re-pair this device.";
            }
            if (status == 404)
            {
                return "This machine's agent has no /dev/reload route — it is too old. " +
                       "Update it with `npm install -g yaver-cli@latest`.";
            }
            if (status >= 500)
            {
                return "The agent hit an internal error while reloading. Check `yaver logs` on the machine.";
            }
            if (status == 0)
            {
                return "Could not reach the machine. Check that it is online and `yaver serve` is running.";
            }
            return "Reload failed (HTTP " + status + ").";
        }
    }
}
