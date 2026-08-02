using UnityEngine;

namespace Yaver.Feedback
{
    /// <summary>
    /// The polite "you're running inside Yaver" mark for Unity apps.
    ///
    /// ─── Why detection here is NOT the same problem as on RN/web ────────────
    ///
    /// A Unity build is never a Hermes guest — Yaver's container loads React
    /// Native bytecode, and there is no mechanism by which a Unity player runs
    /// inside it. So the RN SDK's <c>NativeModules.YaverInfo</c> probe has no
    /// counterpart here.
    ///
    /// What DOES happen is streaming: the build runs on a Yaver box (Redroid,
    /// an emulator, or a desktop player) and the pixels arrive elsewhere. That
    /// is genuinely a "you are not looking at the installed build" situation
    /// and is worth a mark.
    ///
    /// ─── Why we do not sniff the platform ───────────────────────────────────
    ///
    /// The tempting probe is <c>Application.isEditor</c> or a platform check.
    /// It is WRONG, and wrong in the expensive direction: a developer pressing
    /// Play in the Editor would be told "you are inside Yaver" when they are
    /// not. A false claim about which build you are looking at teaches people
    /// to ignore the mark, which costs more than never showing it.
    ///
    /// So detection is EXPLICIT and fails closed:
    ///
    ///   1. the launching side sets the <c>YAVER_STREAMED</c> environment
    ///      variable (the agent controls the launch in a remote runtime),
    ///   2. the host calls <see cref="SetStreamed"/> because it knows, or
    ///   3. no mark is shown.
    ///
    /// Absent evidence, we say nothing.
    /// </summary>
    public static class YaverModeBadge
    {
        private const float Size = 22f;
        private const float Margin = 12f;
        private const float BottomMargin = 28f;

        private static readonly Color Accent = new Color(124f / 255f, 92f / 255f, 1f, 1f);

        /// <summary>
        /// Per-RUN dismissal. In memory on purpose: a permanently hidden mark
        /// recreates the problem it exists to prevent — a tester who cannot
        /// tell a streamed dev build from the installed one. Polite means not
        /// nagging within a session, not permanent amnesia. A project that
        /// wants it gone for good simply never calls <see cref="Attach"/>.
        /// </summary>
        private static bool _hiddenThisRun;

        private static bool? _streamedOverride;
        private static YaverModeBadgeRenderer _renderer;

        /// <summary>Tell the SDK this process is being streamed by Yaver.</summary>
        public static void SetStreamed(bool streamed)
        {
            _streamedOverride = streamed;
        }

        /// <summary>
        /// Whether this process is running inside Yaver, as far as we can
        /// honestly tell. Explicit signals only.
        /// </summary>
        public static bool IsInsideYaver()
        {
            if (_streamedOverride.HasValue) return _streamedOverride.Value;
            string value;
            try
            {
                value = System.Environment.GetEnvironmentVariable("YAVER_STREAMED");
            }
            catch
            {
                // Not readable on every platform (WebGL, some consoles).
                // Absent evidence ⇒ say nothing.
                return false;
            }
            if (string.IsNullOrEmpty(value)) return false;
            value = value.ToLowerInvariant();
            return value == "1" || value == "true";
        }

        public static bool IsHidden => _hiddenThisRun;

        /// <summary>Hide the mark for the rest of this run. Returns next launch.</summary>
        public static void Hide()
        {
            _hiddenThisRun = true;
            if (_renderer != null) _renderer.enabled = false;
        }

        /// <summary>Bring it back — e.g. on entering a new streamed context.</summary>
        public static void Show()
        {
            _hiddenThisRun = false;
            Attach();
        }

        /// <summary>
        /// Mount the mark. No-op when we cannot honestly claim the build is
        /// inside Yaver, when the user hid it, or when it is already mounted.
        /// Safe to call repeatedly.
        /// </summary>
        public static void Attach()
        {
            if (_hiddenThisRun || !IsInsideYaver()) return;
            if (_renderer != null)
            {
                _renderer.enabled = true;
                return;
            }
            var go = new GameObject("YaverModeBadge");
            Object.DontDestroyOnLoad(go);
            _renderer = go.AddComponent<YaverModeBadgeRenderer>();
        }

        /// <summary>Kept so a caller can log the decision without re-deriving it.</summary>
        public static string DescribeDetection()
        {
            if (_streamedOverride.HasValue) return "explicit: SetStreamed(" + _streamedOverride.Value + ")";
            return IsInsideYaver() ? "environment YAVER_STREAMED" : "no Yaver signal — no mark shown";
        }

        internal static Color AccentColor => Accent;
        internal static float MarkSize => Size;
        internal static float SideMargin => Margin;
        internal static float BottomOffset => BottomMargin;
    }

    /// <summary>
    /// IMGUI renderer for the mark. Separate from the static API so the public
    /// surface stays callable before any scene exists.
    /// </summary>
    internal sealed class YaverModeBadgeRenderer : MonoBehaviour
    {
        private bool _explaining;

        private void OnGUI()
        {
            // Bottom-LEFT: bottom-right is where most games put their own HUD
            // controls, and the mark must never compete with them.
            var size = YaverModeBadge.MarkSize;
            var rect = new Rect(
                YaverModeBadge.SideMargin,
                Screen.height - size - YaverModeBadge.BottomOffset,
                size,
                size);

            var prev = GUI.color;
            GUI.color = new Color(YaverModeBadge.AccentColor.r, YaverModeBadge.AccentColor.g,
                                  YaverModeBadge.AccentColor.b, 0.9f);
            if (GUI.Button(rect, "Y"))
            {
                _explaining = true;
            }
            GUI.color = prev;

            if (!_explaining) return;

            var panel = new Rect(
                Mathf.Max(12f, (Screen.width - 360f) / 2f),
                Mathf.Max(12f, (Screen.height - 220f) / 2f),
                Mathf.Min(360f, Screen.width - 24f),
                220f);
            GUI.Box(panel, "Running inside Yaver");
            GUILayout.BeginArea(new Rect(panel.x + 12f, panel.y + 28f, panel.width - 24f, panel.height - 40f));
            GUILayout.Label(
                "This build is being streamed from a Yaver box — it is a development build, not " +
                "the version installed on a device. Anything unfinished here is work in progress, " +
                "not a released bug.\n\n" +
                "Hiding this mark lasts until the next launch, so nobody forgets which build " +
                "they are testing.");
            GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            // Polite means closeable. "for now", never "don't show again".
            if (GUILayout.Button("Hide for now"))
            {
                _explaining = false;
                YaverModeBadge.Hide();
            }
            if (GUILayout.Button("Close"))
            {
                _explaining = false;
            }
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }
    }
}
