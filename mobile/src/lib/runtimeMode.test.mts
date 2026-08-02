// runtimeMode.test.mts — "what am I looking at, and how do I get out".
// Run: npx tsx src/lib/runtimeMode.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  BADGE_HIDE_EXPLANATION,
  BADGE_HIDE_LABEL,
  planRevert,
  shouldShowModeBadge,
  resolveRuntimeMode,
  runtimeModeBadge,
  type RuntimeMode,
} from "./runtimeMode.ts";

const ALL_MODES: RuntimeMode[] = ["installed", "attached-yaver", "guest-hermes", "guest-browser"];

test("the plain installed app says nothing — no badge, no revert", () => {
  assert.equal(resolveRuntimeMode({}), "installed");
  assert.equal(runtimeModeBadge("installed"), null);
  assert.equal(planRevert("installed"), null);
});

test("the attach sentinel wins over the inner app's own preview state", () => {
  // Inside the attached Yaver, guestBundleMounted / browserPreviewOpen describe
  // what the INNER app is previewing. Labelling ourselves by those would tell
  // the user they're in a guest bundle when they're in the dev copy of Yaver.
  assert.equal(
    resolveRuntimeMode({ attachSentinel: "1", guestBundleMounted: true, browserPreviewOpen: true }),
    "attached-yaver",
  );
  assert.equal(resolveRuntimeMode({ attachSentinel: "true" }), "attached-yaver");
});

test("modes resolve in the documented precedence", () => {
  assert.equal(resolveRuntimeMode({ hostAttachSessionLive: true }), "attached-yaver");
  assert.equal(resolveRuntimeMode({ guestBundleMounted: true }), "guest-hermes");
  assert.equal(resolveRuntimeMode({ browserPreviewOpen: true }), "guest-browser");
  assert.equal(resolveRuntimeMode({ guestBundleMounted: true, browserPreviewOpen: true }), "guest-hermes");
  for (const s of [null, undefined, "", "0", "false"]) {
    assert.equal(resolveRuntimeMode({ attachSentinel: s }), "installed", `sentinel ${String(s)}`);
  }
});

test("every non-installed mode carries the Y mark and a way back", () => {
  for (const mode of ALL_MODES) {
    if (mode === "installed") continue;
    const badge = runtimeModeBadge(mode)!;
    assert.ok(badge, `${mode} has no badge`);
    assert.equal(badge.mark, "Y", `${mode} must use Yaver's Y`);
    assert.ok(badge.revertLabel.trim().length > 0, `${mode} has no revert label`);
    assert.ok(badge.detail.length > 40, `${mode} detail is too thin to explain itself`);
    assert.notEqual(badge.tone, "error" as never, "being in a preview is not an error");
  }
});

test("NEGATIVE CONTROL: the attached instance must NOT claim it can revert itself", () => {
  // It is a WebView. Its escape lives in the host's native chrome. A working-
  // looking Revert button here would be a lie, and the user would tap it and
  // stay exactly where they were.
  const inner = runtimeModeBadge("attached-yaver", { isAttachedInstance: true })!;
  assert.equal(inner.canRevertHere, false);
  assert.equal(inner.escapeOwner, "native-chrome");
  assert.match(inner.detail, /Detach/);
  assert.match(inner.detail, /not the\s+version you installed|not the version you installed/);

  const host = runtimeModeBadge("attached-yaver")!;
  assert.equal(host.canRevertHere, true);
  assert.match(host.revertLabel, /installed app/);
});

test("the Hermes guest's escape belongs to the container overlay", () => {
  const badge = runtimeModeBadge("guest-hermes")!;
  assert.equal(badge.escapeOwner, "container-overlay");
  assert.match(badge.detail, /[Ss]hake/);
});

// ── Revert plans ───────────────────────────────────────────────────────────

test("NEGATIVE CONTROL: reverting Attach Mode revokes on the BOX, not just locally", () => {
  // Clearing only the client is the false green this repo keeps finding: the
  // UI says detached while a live capability sits on the box.
  const plan = planRevert("attached-yaver")!;
  assert.equal(plan.revokeAttachSession, true, "revert must revoke server-side");
  assert.equal(plan.clearAttachSentinel, true, "a stale sentinel makes the next open think it's inside");
  assert.equal(plan.unloadGuestBundle, false);
  assert.equal(plan.closeBrowserPreview, false);
});

test("each mode reverts through its own mechanism, and only its own", () => {
  const hermes = planRevert("guest-hermes")!;
  assert.equal(hermes.unloadGuestBundle, true);
  assert.equal(hermes.revokeAttachSession, false);

  const browser = planRevert("guest-browser")!;
  assert.equal(browser.closeBrowserPreview, true);
  assert.equal(browser.unloadGuestBundle, false);
});

test("every revert plan narrates itself — a silent revert looks like a freeze", () => {
  for (const mode of ALL_MODES) {
    const plan = planRevert(mode);
    if (!plan) continue;
    assert.ok(plan.message.trim().length > 10, `${mode} reverts silently`);
  }
});

test("totality: no mode falls through undefined", () => {
  for (const mode of ALL_MODES) {
    // Neither call may throw or return undefined (as opposed to null).
    assert.notEqual(runtimeModeBadge(mode), undefined, `${mode} badge undefined`);
    assert.notEqual(planRevert(mode), undefined, `${mode} plan undefined`);
  }
});

// ── Dismissal ──────────────────────────────────────────────────────────────

test("the badge hides when the user asks, and when the app opts out", () => {
  assert.equal(shouldShowModeBadge({ mode: "guest-hermes" }), true);
  assert.equal(shouldShowModeBadge({ mode: "guest-hermes", userHidThisRun: true }), false);
  assert.equal(shouldShowModeBadge({ mode: "guest-hermes", appOptedOut: true }), false);
});

test("the installed app never shows it, dismissal or not", () => {
  assert.equal(shouldShowModeBadge({ mode: "installed" }), false);
  assert.equal(shouldShowModeBadge({ mode: "installed", userHidThisRun: false }), false);
});

test("NEGATIVE CONTROL: the Hide affordance must promise only THIS RUN", () => {
  // A permanent hide recreates the problem the badge exists to prevent — a
  // tester who can't tell an unbuilt branch from the installed app. If this
  // copy ever says "never" or "don't show again", that promise has been made.
  assert.match(BADGE_HIDE_LABEL, /for now/i);
  assert.doesNotMatch(BADGE_HIDE_LABEL, /never|again/i);
  assert.match(BADGE_HIDE_EXPLANATION, /next launch|comes back/i);
});
