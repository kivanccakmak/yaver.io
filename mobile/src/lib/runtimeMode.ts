// runtimeMode.ts — "what am I actually looking at?", and how to get back.
//
// PURE + RN-free so the logic that SHIPS is the logic that's TESTED
// (`npx tsx src/lib/runtimeMode.test.mts`).
//
// ── The problem this solves ─────────────────────────────────────────────────
//
// Yaver renders apps that look EXACTLY like the real thing:
//
//   • Attach Mode renders Yaver's own dev build — pixel-identical to the Yaver
//     you installed from TestFlight, but it is someone's half-finished branch.
//   • A Hermes guest bundle renders a third-party app inside the Yaver
//     container — identical to that app's own TestFlight build.
//   • A browser-lane preview renders the same app in a WebView.
//
// In all three the user can lose track of which one they are in. That is not a
// cosmetic problem: "why is my app broken?" when you are actually looking at an
// unbuilt branch costs a debugging session, and "I can't get out" is worse.
//
// So two obligations, together, always:
//
//   1. SAY WHICH MODE THIS IS — quietly. One small badge, not a banner. The
//      surface belongs to the app being previewed; our indicator earns a few
//      pixels and no more (LESS IS MORE). It must never cover the app's own
//      chrome or intercept its taps.
//   2. ALWAYS OFFER THE WAY BACK — to the real, installed build. This is the
//      revert. It is only honest if it is reachable from a layer the previewed
//      app cannot capture, which is why every mode below names its escape
//      OWNER as well as its label.

export type RuntimeMode =
  /** The real installed build. No badge, nothing to revert to. */
  | "installed"
  /** Yaver's own dev build, rendered over the browser lane (Attach Mode). */
  | "attached-yaver"
  /** A third-party app loaded as a Hermes bundle inside the Yaver container. */
  | "guest-hermes"
  /** A third-party app rendered in the browser-lane WebView preview. */
  | "guest-browser";

/**
 * Who owns the affordance that gets the user out.
 *
 * This mirrors EscapeOwnerFor in desktop/agent/workspace_preview_strategy.go
 * and exists for the same reason: an escape the previewed app can draw over,
 * or capture the gesture for, is not an escape.
 */
export type EscapeOwner =
  /** Native chrome outside the rendered surface. Structurally safe. */
  | "native-chrome"
  /** The Yaver container's shake + overlay. Safe while the guest honours the
   *  suppression contract (YaverInfo.isYaver → the guest SDK no-ops). */
  | "container-overlay";

export interface RuntimeModeBadge {
  /**
   * The mark. Always Yaver's "Y" — this is Yaver saying "you are inside me",
   * so it is one glyph the user already recognises rather than a word they
   * have to read. Politeness is the whole brief: a small Y, low contrast, no
   * text until asked. A chip that spells out its state in every header is the
   * accretion the LESS IS MORE rule exists to stop.
   */
  mark: "Y";
  /** Short label, revealed on tap — never rendered in the resting badge. */
  label: string;
  /** Longer sentence, shown on tap. Says what you're looking at AND what the
   *  way back does, because "Revert" alone is ambiguous. */
  detail: string;
  /** Advisory tone. Never "error": being in a preview is not a failure. */
  tone: "info" | "dev";
  escapeOwner: EscapeOwner;
  /** Label for the way-back action. */
  revertLabel: string;
  /** True when THIS surface can perform the revert itself. False means the
   *  escape belongs to a layer above and the badge must say so rather than
   *  render a button that cannot work. */
  canRevertHere: boolean;
}

export interface RuntimeModeInput {
  /** The attach sentinel (localStorage `yaver.attach.mode`). Set by the host
   *  into the attached WebView; carries no authority. */
  attachSentinel?: string | null;
  /** A live Attach Mode session owned by THIS (host) instance. */
  hostAttachSessionLive?: boolean;
  /** A Hermes guest bundle is mounted in this container. */
  guestBundleMounted?: boolean;
  /** A browser-lane preview is open on this surface. */
  browserPreviewOpen?: boolean;
}

/**
 * Resolve the mode. Order matters and is deliberate:
 *
 * The attach sentinel wins over everything, because inside the attached Yaver
 * the OTHER signals are the inner app's own state and describe ITS previews,
 * not ours. Getting this backwards would label the attached Yaver by whatever
 * it happens to be previewing.
 */
export function resolveRuntimeMode(input: RuntimeModeInput): RuntimeMode {
  if (input.attachSentinel === "1" || input.attachSentinel === "true") {
    return "attached-yaver";
  }
  if (input.hostAttachSessionLive) return "attached-yaver";
  if (input.guestBundleMounted) return "guest-hermes";
  if (input.browserPreviewOpen) return "guest-browser";
  return "installed";
}

/**
 * The badge for a mode, or null when there is nothing to say.
 *
 * `isAttachedInstance` distinguishes "I am the host, showing an attached
 * surface" from "I AM the attached surface". Only the host can revert; the
 * attached instance is a WebView and its escape lives in the host's native
 * chrome. An attached instance that rendered a working-looking Revert button
 * would be lying.
 */
export function runtimeModeBadge(
  mode: RuntimeMode,
  opts: { isAttachedInstance?: boolean } = {},
): RuntimeModeBadge | null {
  switch (mode) {
    case "installed":
      // Nothing to say. A badge that is always present is wallpaper, and
      // wallpaper is what people stop reading.
      return null;

    case "attached-yaver":
      if (opts.isAttachedInstance) {
        return {
          mark: "Y",
          label: "Dev copy",
          detail:
            "You're looking at Yaver's own development build, served from your box — not the " +
            "version you installed. Use Detach in the bar above to return to the installed app.",
          tone: "dev",
          escapeOwner: "native-chrome",
          revertLabel: "Detach",
          canRevertHere: false,
        };
      }
      return {
        mark: "Y",
        label: "Attached",
        detail:
          "Attach Mode is live: this device is rendering Yaver's own development build from your " +
          "box. Revert returns to the installed app and ends the session.",
        tone: "dev",
        escapeOwner: "native-chrome",
        revertLabel: "Revert to installed app",
        canRevertHere: true,
      };

    case "guest-hermes":
      return {
        mark: "Y",
        label: "In Yaver",
        detail:
          "This app is running inside Yaver from a development bundle, not its installed build. " +
          "Shake the device, or use Back to Yaver, to leave it.",
        tone: "info",
        // The container owns shake + the overlay while the guest honours the
        // suppression contract (YaverInfo.isYaver).
        escapeOwner: "container-overlay",
        revertLabel: "Back to Yaver",
        canRevertHere: true,
      };

    case "guest-browser":
      return {
        mark: "Y",
        label: "Preview",
        detail:
          "This is a browser preview of your app served from your box. Close the preview to " +
          "return to Yaver.",
        tone: "info",
        escapeOwner: "native-chrome",
        revertLabel: "Close preview",
        canRevertHere: true,
      };
  }
}

/**
 * What a revert must clean up, as data rather than as scattered call sites.
 *
 * Revert has bitten this codebase before in the same way every time: the UI
 * returns to the real app while something server-side stays live, so the
 * inventory says "reverted" and the operation says otherwise. Enumerating the
 * steps here means a test can assert none is skipped.
 */
export interface RevertPlan {
  /** Revoke the attach capability ON THE BOX, not just locally. */
  revokeAttachSession: boolean;
  /** Clear the sentinel so a reopened surface doesn't think it's still inside. */
  clearAttachSentinel: boolean;
  /** Unload the Hermes guest bundle via the native loader. */
  unloadGuestBundle: boolean;
  /** Close the browser-lane preview surface. */
  closeBrowserPreview: boolean;
  /** Sentence shown while it happens. */
  message: string;
}

export function planRevert(mode: RuntimeMode): RevertPlan | null {
  switch (mode) {
    case "installed":
      return null;
    case "attached-yaver":
      return {
        revokeAttachSession: true,
        clearAttachSentinel: true,
        unloadGuestBundle: false,
        closeBrowserPreview: false,
        message: "Returning to the installed Yaver and ending the attach session…",
      };
    case "guest-hermes":
      return {
        revokeAttachSession: false,
        clearAttachSentinel: false,
        unloadGuestBundle: true,
        closeBrowserPreview: false,
        message: "Unloading the development bundle and returning to Yaver…",
      };
    case "guest-browser":
      return {
        revokeAttachSession: false,
        clearAttachSentinel: false,
        unloadGuestBundle: false,
        closeBrowserPreview: true,
        message: "Closing the preview…",
      };
  }
}

// ── Dismissal ───────────────────────────────────────────────────────────────
//
// The badge is polite, which means it can be closed. Two ways, deliberately
// different in scope:
//
//   • THE USER taps "Hide" on the sheet. Lasts for THIS RUN only.
//   • THE APP passes modeBadge:false (or calls the SDK's setter). Permanent,
//     because the developer made an informed choice.
//
// User dismissal is per-run on purpose. A permanently hidden badge recreates
// exactly the problem it exists to prevent: a tester who cannot tell an
// unbuilt branch from the installed app, and cannot find the way back. Being
// polite means not nagging within a session — it does not mean permanent
// amnesia about which build you are looking at. A fresh launch, a new attach
// session or a newly loaded guest bundle is a new context, and the user is
// entitled to be told again.
//
// This is the single place that rule is written down; every SDK mirrors it.

export type BadgeDismissalScope = "run" | "never";

export interface BadgeVisibilityInput {
  mode: RuntimeMode;
  /** The app opted out at init (config.modeBadge === false). */
  appOptedOut?: boolean;
  /** The user tapped Hide during this run. */
  userHidThisRun?: boolean;
}

export function shouldShowModeBadge(input: BadgeVisibilityInput): boolean {
  if (input.mode === "installed") return false;
  if (input.appOptedOut) return false;
  if (input.userHidThisRun) return false;
  return true;
}

/** What the "Hide" affordance should say, so the user knows it is not forever. */
export const BADGE_HIDE_LABEL = "Hide for now";
export const BADGE_HIDE_EXPLANATION =
  "Hidden until you next launch this build. It comes back so nobody forgets which app they're testing.";
