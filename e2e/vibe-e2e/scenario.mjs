// scenario.mjs — the surface-agnostic vibe closed-loop scenario + oracle +
// verdict. See docs/architecture/E2E_VIBE_CLOSED_LOOP_ALL_SURFACES.md.
//
// A SurfaceAdapter implements: login, ensureConnectedToPrimary, openVibing,
// selectProject, renderPreview, readPreviewBackground, sendChat,
// waitForTurnComplete, waitForRender, screenshot, log. runScenario drives them
// through the same steps on any surface and returns a verdict.

// Classify an "rgb(r,g,b)" / hex color into {black, green, other}.
export function classifyColor(css) {
  if (!css) return "unknown";
  const s = String(css).trim().toLowerCase();
  let r, g, b;
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) { [r, g, b] = [+m[1], +m[2], +m[3]]; }
  else if (/^#([0-9a-f]{6})$/.test(s)) { r = parseInt(s.slice(1, 3), 16); g = parseInt(s.slice(3, 5), 16); b = parseInt(s.slice(5, 7), 16); }
  else if (/^#([0-9a-f]{3})$/.test(s)) { r = parseInt(s[1] + s[1], 16); g = parseInt(s[2] + s[2], 16); b = parseInt(s[3] + s[3], 16); }
  else return "other";
  if (r < 60 && g < 60 && b < 60) return "black";
  if (g > 90 && g > r + 40 && g > b + 40) return "green";
  return "other";
}

const VERDICT = { PIXELS: "PIXELS", NAMED: "NAMED", SILENT: "SILENT" };

export async function runScenario(adapter, opts = {}) {
  const log = adapter.log || ((m) => console.log(m));
  const steps = [];
  const record = (name, ok, detail) => { steps.push({ name, ok, detail }); log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`); };
  const named = (reason) => ({ verdict: VERDICT.NAMED, reason, steps });

  try {
    // 1. AUTH
    await adapter.login();
    record("AUTH — signed in", true);

    // 2. CONNECT to the primary box (ubuntu-4gb), Codex primary, as renderer.
    const conn = await adapter.ensureConnectedToPrimary();
    if (!conn.ok) return named(`CONNECT failed: ${conn.reason || "not connected to primary"}`);
    record("CONNECT — primary box connected", true, conn.detail);

    // 3. OPEN VIBE + select the mobile project + render its web-UI path.
    await adapter.openVibing();
    record("OPEN VIBE", true);
    await adapter.selectProject("yaver / mobile");
    record("SELECT PROJECT yaver/mobile", true);
    await adapter.renderPreview("web");
    record("RENDER web-UI preview", true);

    // 4. BASELINE — read the login background.
    const base = await adapter.readPreviewBackground();
    const baseColor = classifyColor(base);
    record("BASELINE background read", baseColor !== "unknown", `${base} → ${baseColor}`);

    // The TERMINAL signal is the pixels, not a chat-status string (the "Ready
    // for …" placeholder always contains "ready"). After sending, poll the
    // preview background until it reaches the target — that single signal proves
    // the runner ran AND the edit rendered. Generous window: a Codex turn +
    // render can take several minutes.
    const budget = opts.turnAndRenderMs ?? 12 * 60_000;

    // 5–7. VIBE → green.
    const sentGreen = await adapter.sendChat("Change the login page background color from black to green. Only the login screen background.");
    if (!sentGreen) return named("could not SEND the 'green' message (composer never cleared — Send did not dispatch)");
    record("CHAT → 'background to green' sent", true);
    const afterGreen = await adapter.waitForBackground("green", budget);
    record("ASSERT background == green", afterGreen.ok, `${afterGreen.color}`);
    if (!afterGreen.ok) return named(`preview did not turn green in ${Math.round(budget / 60000)}min (got ${afterGreen.color}) — runner/render/edit`);

    // Two TASKS, not one follow-up: start a fresh session so the revert is its
    // own task (exercises the new-task render path, not just a follow-up).
    if (adapter.newTask) { await adapter.newTask(); record("NEW TASK (fresh session for the revert)", true); }

    // 8–10. VIBE ← black (revert) — as a second, separate task.
    const sentBlack = await adapter.sendChat("Revert the login page background color back to black.");
    if (!sentBlack) return named("could not SEND the 'revert' message (composer never cleared)");
    record("CHAT ← 'revert to black' sent", true);
    const afterBlack = await adapter.waitForBackground("black", budget);
    record("ASSERT background == black (reverted)", afterBlack.ok, `${afterBlack.color}`);
    if (!afterBlack.ok) return named(`preview did not revert to black in ${Math.round(budget / 60000)}min (got ${afterBlack.color})`);

    return { verdict: VERDICT.PIXELS, reason: "black → green → black observed end to end", steps };
  } catch (e) {
    return { verdict: VERDICT.SILENT, reason: `unexpected: ${e?.message || e}`, steps };
  }
}
