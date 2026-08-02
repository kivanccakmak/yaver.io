/**
 * attachDetachEscape.test.mts — you must ALWAYS be able to get back out.
 *
 *   npx tsx mobile/src/lib/attachDetachEscape.test.mts
 *
 * ── Why this guard exists ───────────────────────────────────────────────────
 *
 * Attach Mode is Yaver rendering Yaver: the phone shows the app's own RN-web
 * build, served from a box, full-screen. It is the dogfooding mode — you vibe
 * the app you are looking at.
 *
 * That makes ONE property load-bearing above all others: the way out must live
 * in NATIVE chrome, outside the WebView. Hermes is refused for this exact
 * scenario (409 YAVER_SELF_DEVELOPMENT_RECURSION) because two shake/exit owners
 * in one RN process means the preview cannot reliably be exited. The web target
 * is only safe because a WebView cannot register a gesture handler on the host
 * or draw over native chrome — so if the Detach control ever moves inside the
 * WebView, or the WebView goes full-bleed over the header, the mode becomes a
 * one-way door on the user's own phone. There is no recovery from inside: the
 * page you would use to leave is the page that is broken.
 *
 * MOBILE CLIENT SURFACE ONLY, deliberately. Attach Mode is a phone affordance —
 * `mobile/app/attach.tsx` is its only implementation, and the web dashboard has
 * no equivalent, so asserting parity elsewhere would invent coverage.
 *
 * Structural, not behavioural, because the failure is a LAYOUT relationship
 * (chrome outside vs inside the WebView) that no unit-level render assertion
 * would catch. Same shape as connectedDeviceCard.test.ts.
 *
 * Prove it by breaking it: move the Detach button inside <WebView>, or delete
 * the revert-on-detach call, and exactly one assertion below fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored on THIS file — the sweep runs from the repo root, humans run from
// mobile/. A cwd-relative path turns that difference into a meaningless red.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const attachScreen = readFileSync(join(root, "app/attach.tsx"), "utf8");

/**
 * The JSX region actually occupied by the WebView ELEMENT.
 *
 * Not `indexOf("<WebView")` — that matches `useRef<WebView>(null)` 180 lines
 * earlier, and slicing from there to the next "/>" swallows the whole screen
 * including the native chrome, so the guard failed on correct code. A false red
 * costs the same trust as a false green; the element is the one followed by
 * whitespace and a prop.
 */
function webViewBlock(): string {
  const m = /<WebView\s*\n/.exec(attachScreen);
  assert.notEqual(m, null, "attach.tsx no longer renders a <WebView> element — re-point this guard");
  const start = m!.index;
  const end = attachScreen.indexOf("/>", start);
  assert.notEqual(end, -1, "could not bound the WebView element");
  return attachScreen.slice(start, end);
}

test("the Detach control exists and is NOT inside the WebView", () => {
  assert.match(attachScreen, /detach/i, "attach.tsx offers no detach path at all");
  const wv = webViewBlock();
  // A CONTROL, not the word. The WebView's props legitimately mention "Detach"
  // inside an error string ("Detach and re-attach to restart it") — that is
  // copy, not an exit affordance, and failing on it would push a correct
  // remedy sentence out of the product to satisfy a test. What must never
  // appear here is something TAPPABLE that detaches.
  assert.ok(
    !/onPress[^\n]*detach/i.test(wv),
    "a tappable Detach lives inside the <WebView> — a broken page would take the exit with it, " +
      "and there is no way back from inside an attached Yaver",
  );
  // And the real control must exist in the native chrome outside it.
  const outside = attachScreen.replace(wv, "");
  assert.match(outside, /onPress[^\n]*[Dd]etach|confirmDetach/,
    "no Detach control in the native chrome — the only way out would be inside the WebView");
});

test("detaching REVERTS, and asks first — it is a destructive action on the user's checkout", () => {
  assert.match(attachScreen, /confirmDetach|Alert\.alert/,
    "detach happens with no confirmation — attach mode edits a real checkout");
  assert.match(attachScreen, /style:\s*"destructive"/,
    "the revert option is not marked destructive, so it does not read as one");
});

test("detach returns the user to the host app, never to a dead surface", () => {
  const detachStart = attachScreen.indexOf("const detach");
  assert.notEqual(detachStart, -1, "detach handler is gone — re-point this guard");
  const body = attachScreen.slice(detachStart, detachStart + 1400);
  assert.match(body, /router\.(back|replace|push)/,
    "detach does not navigate anywhere — the user is left on the attached surface after leaving it");
});

test("nesting is refused, so a third copy can never be stacked", async () => {
  const { computeNestingVerdict, ATTACH_SENTINEL_KEY } = await import("./attachMode.ts");
  assert.equal(computeNestingVerdict("1").mayOffer, false,
    "an already-attached instance would offer Attach Mode again — an infinite mirror");
  assert.equal(computeNestingVerdict(null).mayOffer, true,
    "a normal host instance must still be able to attach");
  assert.equal(ATTACH_SENTINEL_KEY, "yaver.attach.mode",
    "the sentinel key is read by name from inside the attached surface — renaming it silently re-enables nesting");
});
