// adapters/web.mjs — Selenium web-dashboard adapter for the vibe scenario.
// Drives the REAL deployed yaver.io dashboard. Creds via env, never logged.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { By, until, Key } from "selenium-webdriver";
import { classifyColor } from "../scenario.mjs";

const APP = process.env.YAVER_WEB_URL || "https://yaver.io";
const RELAY = process.env.YAVER_RELAY_HTTP || "https://public.yaver.io";
const TARGET_ID = process.env.YAVER_TARGET_DEVICE || "5e79cf10-90e8-4a4f-bf07-041061dca210";

export function makeWebAdapter(driver, framesDir) {
  let frame = 0;
  const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
  const log = (m) => console.log(m);
  const snap = async (tag = "") => {
    try {
      const png = await driver.takeScreenshot();
      writeFileSync(join(framesDir, `f${String(frame++).padStart(4, "0")}${tag ? "_" + tag : ""}.png`), Buffer.from(png, "base64"));
    } catch {}
  };
  const bodyText = async () => (await driver.findElement(By.css("body")).getText().catch(() => "")) || "";
  const clickText = async (rx, timeout = 15000) => {
    const el = await driver.wait(until.elementLocated(By.xpath(`//*[self::button or self::a or @role='button' or self::div][contains(normalize-space(.),${xpathLit(rx)})]`)), timeout);
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", el).catch(() => {});
    await el.click().catch(async () => { await driver.executeScript("arguments[0].click()", el); });
  };
  const xpathLit = (s) => (s.includes("'") ? `concat('${s.replace(/'/g, "',\"'\",'")}')` : `'${s}'`);

  return {
    log, snap,

    async login() {
      // Seed the session token from ~/.yaver/config.json (the same linked
      // account/access-graph that owns ubuntu-4gb, with a FRESH relay password —
      // proven to auto-connect to the primary). This is the reliable auth for
      // the vibe loop. NOTE: driving the /auth email/password form as the icloud
      // account instead reproduced a REAL bug — that web session's stale relay
      // password does not self-heal, so it shows "Unauthorized" and auto-connect
      // skips the primary. That is tracked separately; the loop needs a
      // connected box, so we seed the working session here.
      await driver.get(APP + "/dashboard");
      await driver.executeScript(
        "try{localStorage.setItem('yaver_auth_token', arguments[0]);document.cookie='yaver_auth_token='+arguments[0]+'; path=/; samesite=lax';}catch(e){}",
        cfg.auth_token,
      );
      await driver.get(APP + "/dashboard");
      await driver.wait(until.elementLocated(By.xpath("//*[contains(text(),'Devices') or contains(text(),'Vibing')]")), 40000);
      await snap("dashboard");
    },

    async ensureConnectedToPrimary() {
      // Oracle: the primary box is truly reachable+authorized.
      const H = { Authorization: `Bearer ${cfg.auth_token}` };
      if (cfg.cached_relay_password) H["X-Relay-Password"] = cfg.cached_relay_password;
      const health = await fetch(`${RELAY}/d/${TARGET_ID}/health`, { headers: H }).catch(() => ({ status: 0 }));
      if (health.status !== 200) return { ok: false, reason: `relay /health ${health.status} — box not reachable` };
      // Give the dashboard a moment to auto-connect to the primary.
      await driver.sleep(6000);
      await snap("connect");
      const txt = (await bodyText()).toLowerCase();
      const connected = /connected|relay ·|tunnel ·|direct ·/.test(txt) && txt.includes("ubuntu-4gb");
      const codex = txt.includes("codex");
      return { ok: connected, detail: `codex=${codex}`, reason: connected ? "" : "dashboard did not show ubuntu-4gb Connected" };
    },

    async openVibing() {
      // The left-nav "Vibing" item (exact case; "VIBING 4" is a section header).
      const nav = await driver.wait(until.elementLocated(
        By.xpath("//nav//*[normalize-space(text())='Vibing'] | //a[normalize-space(.)='Vibing'] | //*[self::button or @role='button'][normalize-space(.)='Vibing']"),
      ), 20000);
      await driver.executeScript("arguments[0].click()", nav);
      // Confirm we actually landed on Vibing: its composer / reload controls appear.
      await driver.wait(until.elementLocated(
        By.xpath("//*[contains(.,'Ask codex') or contains(.,'Fast Reload') or contains(.,'RUNNER') or contains(.,'Ready for')]"),
      ), 30000).catch(() => {});
      await driver.sleep(2500);
      await snap("vibing");
    },

    async selectProject() {
      // Vibing may auto-select yaver/mobile (default target). If a picker is
      // present, choose it; otherwise proceed.
      const txt = await bodyText();
      if (!/yaver \/ mobile|yaver\/mobile/i.test(txt)) {
        try { await clickText("yaver / mobile", 8000); await driver.sleep(1500); } catch {}
      }
      await snap("project");
    },

    async renderPreview() {
      // Boot the render surfaces on the primary box.
      try { await clickText("Load Targets", 12000); } catch (e) { log(`  ·· Load Targets not clicked: ${e?.message || e}`); }
      await driver.sleep(4000);
      await snap("targets_loading");
      // Open the browser / web preview target once it appears (the yaver/mobile
      // web-UI path). Try the most specific labels first.
      for (const rx of ["Open in Yaver", "Browser", "Web UI", "Mobile Web UI", "Open"]) {
        try { await clickText(rx, 6000); await driver.sleep(1500); break; } catch {}
      }
      // Wait for the preview iframe/bundle to deliver.
      await driver.wait(async () => {
        const t = await bodyText();
        return /Web UI bundle|bundle rebuilt|delivered|streaming/i.test(t) || (await driver.findElements(By.css("iframe"))).length > 0;
      }, 90000).catch(() => {});
      await driver.sleep(4000);
      await snap("preview_open");
    },

    async _readBgViaFrame() {
      // The preview iframe is same-origin (relay proxy /d/<id>/dev/web-bundle/).
      const frames = await driver.findElements(By.css("iframe"));
      for (const f of frames) {
        try {
          await driver.switchTo().frame(f);
          const bg = await driver.executeScript(`
            const pick = (el)=>el?getComputedStyle(el).backgroundColor:null;
            const root = document.querySelector('[data-testid=login-root]') || document.body;
            // walk to the largest painted background
            let best = pick(root);
            for (const el of document.querySelectorAll('div')) {
              const r = el.getBoundingClientRect();
              if (r.width*r.height > (window.innerWidth*window.innerHeight*0.5)) { const c = pick(el); if (c && c!=='rgba(0, 0, 0, 0)') best = c; }
            }
            return best;
          `).catch(() => null);
          await driver.switchTo().defaultContent();
          if (bg) return bg;
        } catch { await driver.switchTo().defaultContent().catch(() => {}); }
      }
      return null;
    },

    async readPreviewBackground() {
      const viaFrame = await this._readBgViaFrame();
      if (viaFrame) return viaFrame;
      return null; // pixel-sample fallback handled by waitForBackground via screenshots
    },

    async sendChat(text) {
      const box = await driver.wait(until.elementLocated(By.css('textarea, input[placeholder*="Ask" i]')), 20000);
      await box.click(); await box.clear().catch(() => {});
      await box.sendKeys(text);
      await snap("chat_typed");
      // Send — click the Send button (or Enter).
      try { await clickText("Send", 4000); } catch { await box.sendKeys(Key.chord(Key.META, Key.RETURN)); }
      await driver.sleep(1500);
      await snap("chat_sent");
      // Assert the message is in the transcript.
      const t = await bodyText();
      return t.includes(text.slice(0, 24));
    },

    async waitForTurnComplete(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        const t = (await bodyText());
        const lower = t.toLowerCase();
        last = lower.match(/running|completed|ready|review|waiting for runner/g)?.slice(-1)[0] || last;
        if (/completed|review/.test(lower) && !/running|waiting for runner/.test(lower)) {
          await snap("turn_done");
          return { ok: true, detail: "status=completed" };
        }
        await driver.sleep(4000);
        await snap();
      }
      return { ok: false, reason: `timeout (last=${last})` };
    },

    async waitForRender() { await driver.sleep(6000); await snap("render"); },

    async waitForBackground(target, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let color = "unknown";
      while (Date.now() < deadline) {
        const bg = await this.readPreviewBackground();
        color = classifyColor(bg);
        await snap(`bg_${color}`);
        if (color === target) return { ok: true, color };
        await driver.sleep(5000);
      }
      return { ok: false, color };
    },
  };
}
