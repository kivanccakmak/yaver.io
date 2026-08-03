/**
 * _visionOracle.mjs — read the TEXT off a captured frame, on any surface.
 *
 * ── What it buys ───────────────────────────────────────────────────────────
 *
 * A colour verdict can say a screen changed. It cannot say why a screen that
 * did NOT change is stuck. "expo server ready — loading page…", a runner
 * refusal, a sign-in wall, a red error banner and a genuinely blank preview
 * are all just "black" to a sampler. On surfaces with a DOM the harness reads
 * `document.body.innerText`; tvOS, visionOS, watchOS, Wear OS and the car
 * surface have none, so until this existed their only failing verdict was
 * SILENT — the one verdict CLAUDE.md calls a real failure.
 *
 * Apple's Vision framework turns a frame into text on-device in ~500ms, free
 * and offline. Measured on the tvOS sign-in fixture: 483 ms, 6 blocks,
 * confidence 1.00, and it read the device code `EXUY-2270` straight off the
 * screen. That is not just diagnostics — it is a capability: tvOS headless
 * auth no longer needs a human to read a code aloud.
 *
 * ── One implementation, every surface ──────────────────────────────────────
 *
 * This module is shared on purpose. The oracle first lived inline in the TV
 * arc, which meant the mobile and web arcs — the ones that fail most often —
 * could not use it, and any fix to it would have had to be copied. That is the
 * drift pattern this repo keeps paying for (three different relay-auth
 * matchers in mobile, none a superset of the others). One file, every caller.
 *
 * ── OPPORTUNISTIC, NEVER LOAD-BEARING ──────────────────────────────────────
 *
 * macOS-only. Its absence must never fail an arc, change a verdict, or turn a
 * pass into a failure: it only ever ADDS a reason to a failure the pixels
 * already reached. Every function here returns null instead of throwing, and
 * `available()` says why it is unavailable so a run on Linux prints one honest
 * line rather than looking broken.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HELPER = new URL("../desktop/agent/screenread/screenread", import.meta.url).pathname;

/**
 * Is the oracle usable here, and if not, why?
 * @returns {{ok: boolean, reason: string, path: string}}
 */
export function available() {
  if (process.platform !== "darwin") {
    return { ok: false, path: HELPER, reason: "Apple Vision is macOS-only — the text oracle is skipped on this platform" };
  }
  if (!existsSync(HELPER)) {
    return {
      ok: false,
      path: HELPER,
      // The remedy, not "unavailable". And the compile and the sign are ONE
      // command on purpose: macOS kills an unsigned helper under launchd with
      // OS_REASON_CODESIGNING while launchd still reports "spawn scheduled",
      // so a split build looks like a hang, not a failure. That took this
      // repo's agent down on 2026-07-25.
      reason:
        "text oracle not built — run:\n" +
        "  xcrun swiftc -O desktop/agent/screenread/main.swift -o desktop/agent/screenread/screenread " +
        "&& codesign --force -s - desktop/agent/screenread/screenread",
    };
  }
  return { ok: true, path: HELPER, reason: "ready" };
}

/**
 * Read a PNG on disk and return its recognised text blocks.
 * @param {string} pngPath
 * @returns {{text: string, blocks: Array<{text: string, confidence: number}>}|null}
 */
export function readFrame(pngPath) {
  const a = available();
  if (!a.ok || !pngPath || !existsSync(pngPath)) return null;
  try {
    const out = JSON.parse(execFileSync(a.path, [pngPath], { encoding: "utf8", timeout: 30_000 }));
    if (!out?.ok || !Array.isArray(out.blocks)) return null;
    const blocks = out.blocks.map((b) => ({ text: String(b.text || ""), confidence: Number(b.confidence ?? 0) }));
    return { text: blocks.map((b) => b.text).join(" | "), blocks };
  } catch {
    return null; // the oracle failing is not the product failing
  }
}

/**
 * Known screens, so a frame's text becomes a NAMED cause rather than a quote.
 *
 * The value of this table is that it maps what the screen SAYS to what is
 * actually wrong and what to do — the difference between showing a user a
 * string and telling them the answer. Keyed on lowercase substrings because
 * OCR punctuation and spacing are not reliable enough to match exactly.
 *
 * Add a row every time a loop fails for a new reason. That is this file's half
 * of the snowball: the arc grows a check, the oracle grows a name.
 */
const KNOWN_SCREENS = [
  {
    match: ["expo server ready", "loading page", "starting metro", "bundling"],
    cause: "dev-server-warming",
    say: "the dev server is still bundling — the preview has not rendered the app yet, so a colour verdict here is meaningless",
  },
  {
    match: ["continue with apple", "continue with google", "sign in to yaver", "sign in with"],
    cause: "signed-out",
    say: "the app is showing the SIGN-IN screen — the session did not reach the surface, so no vibe could have been applied",
  },
  {
    match: ["cannot create temporary directory", "chrome failed to start"],
    cause: "browser-cannot-launch",
    say: "the capture browser could not start — this is the confined-snap Chrome failure; the box needs an unconfined build",
  },
  {
    match: ["failed to compile", "unable to resolve", "syntaxerror", "module not found"],
    cause: "build-error",
    say: "the app FAILED TO COMPILE — the runner's edit broke the build, which is a product failure the colour verdict alone would have called 'black'",
  },
  {
    match: ["usage limit", "quota", "rate limit", "too many requests"],
    cause: "runner-quota",
    say: "the coding runner hit a QUOTA wall — no model change fixes this, the account needs capacity",
  },
  {
    match: ["not connected", "reconnecting", "connecting…", "connecting..."],
    cause: "transport-pending",
    say: "the surface never connected to the box — the vibe was never dispatched",
  },
];

/**
 * Turn frame text into a named cause.
 * @param {string|null} text
 * @returns {{cause: string, say: string}|null}
 */
export function nameFromText(text) {
  if (!text) return null;
  const low = text.toLowerCase();
  for (const row of KNOWN_SCREENS) {
    if (row.match.some((m) => low.includes(m))) return { cause: row.cause, say: row.say };
  }
  return null;
}

/**
 * The whole ladder in one call: read the frame, name it if we recognise it,
 * otherwise quote what it said.
 *
 * Returns null only when the oracle could not run at all — which callers must
 * treat as "no extra information", never as a failure.
 *
 * @param {string} pngPath
 * @returns {{cause: string, reason: string, text: string}|null}
 */
export function explainFrame(pngPath) {
  const read = readFrame(pngPath);
  if (!read || !read.text.trim()) return null;
  const named = nameFromText(read.text);
  if (named) return { cause: named.cause, reason: named.say, text: read.text };
  return {
    cause: "unrecognised-screen",
    // Quoting is still strictly better than SILENT: a human reading the run
    // can recognise a screen this table does not know yet, and then it becomes
    // a row above.
    reason: `the frame showed: ${read.text.slice(0, 300)}`,
    text: read.text,
  };
}
