// adapters/mobile.mjs — Selenium adapter driving the RN-web MOBILE app
// (the phone client) through the same vibe scenario. Same remote box renders;
// the client under test is mobile/ RN code, run as RN-web in Chromium. Creds
// via env, never logged. Vibes a NON-Yaver project (recursion guard) via the
// browser lane. See docs/architecture/E2E_VIBE_CLOSED_LOOP_ALL_SURFACES.md.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { By, until, Key } from "selenium-webdriver";
import { classifyColor } from "../scenario.mjs";

const APP = process.env.MOBILE_WEB_URL || "http://localhost:8081";
const RELAY = process.env.YAVER_RELAY_HTTP || "https://public.yaver.io";
const TARGET_ID = process.env.YAVER_TARGET_DEVICE || "5e79cf10-90e8-4a4f-bf07-041061dca210";
const PROJECT = process.env.YAVER_MOBILE_PROJECT || "yaver-todo-rn";

export function makeMobileAdapter(driver, framesDir) {
  let frame = 0;
  const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
  const log = (m) => console.log(m);
  const snap = async (tag = "") => { try { writeFileSync(join(framesDir, `f${String(frame++).padStart(4, "0")}${tag ? "_" + tag : ""}.png`), Buffer.from(await driver.takeScreenshot(), "base64")); } catch {} };
  const body = async () => (await driver.findElement(By.css("body")).getText().catch(() => "")) || "";
  const xpathLit = (s) => (s.includes("'") ? `concat('${s.replace(/'/g, "',\"'\",'")}')` : `'${s}'`);
  const tapText = async (rx, { last = false, timeout = 15000 } = {}) => {
    const els = await driver.wait(async () => {
      const found = await driver.findElements(By.xpath(`//*[normalize-space(text())=${xpathLit(rx)} or contains(normalize-space(text()),${xpathLit(rx)})]`));
      return found.length ? found : null;
    }, timeout);
    const el = last ? els[els.length - 1] : els[0];
    await driver.executeScript("arguments[0].click()", el);
    return el;
  };

  return {
    log, snap,

    async login() {
      // The RN-web mobile app reads its session token from SecureStore-compat
      // localStorage (`yaver.secure.` prefix). Seed it — reliable, and the same
      // account/access-graph that owns ubuntu-4gb, so the app auto-connects to
      // the primary. NOTE: driving the mobile /auth email/password form did NOT
      // land in automation (Sign In did not sign in even with a real click) —
      // tracked as a separate mobile-login-automation item; the vibe loop needs
      // a signed-in app, so we seed here.
      await driver.get(APP);
      await driver.sleep(4000);
      await driver.executeScript("try{localStorage.setItem('yaver.secure.yaver_auth_token', arguments[0]);}catch(e){}", cfg.auth_token);
      await driver.get(APP);
      await driver.wait(until.elementLocated(By.xpath("//*[contains(text(),'Tasks') or contains(text(),'Projects') or contains(text(),'Summary') or contains(text(),'Connected')]")), 45000);
      await driver.sleep(5000); await snap("signed_in");
    },

    async ensureConnectedToPrimary() {
      const H = { Authorization: `Bearer ${cfg.auth_token}` };
      if (cfg.cached_relay_password) H["X-Relay-Password"] = cfg.cached_relay_password;
      const health = await fetch(`${RELAY}/d/${TARGET_ID}/health`, { headers: H }).catch(() => ({ status: 0 }));
      if (health.status !== 200) return { ok: false, reason: `relay /health ${health.status}` };
      // The mobile app auto-connects to the primary; poll the pill.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const t = (await body()).toLowerCase();
        if (/connected/.test(t) && t.includes("ubuntu-4gb")) { await snap("connect"); return { ok: true, detail: `codex=${t.includes("codex")}` }; }
        await driver.sleep(5000);
      }
      await snap("connect");
      return { ok: false, reason: "mobile app did not show ubuntu-4gb Connected" };
    },

    async openVibing() {
      // Bottom-nav Projects tab (LAST 'Projects' — the tab, not a task card).
      await tapText("Projects", { last: true, timeout: 20000 });
      await driver.sleep(4000); await snap("projects");
    },

    async selectProject() {
      await tapText(PROJECT, { timeout: 15000 });
      await driver.sleep(5000); await snap("project");
    },

    async renderPreview() {
      // Open the project's preview via the BROWSER lane. Try the labels the
      // mobile app uses; log what's available for iteration.
      log(`  ·· project buttons: ${await listButtons()}`);
      for (const rx of ["Open in Yaver", "Browser", "Web UI", "Preview", "Open", "Reload"]) {
        try { await tapText(rx, { timeout: 4000 }); log(`  ·· tapped '${rx}'`); await driver.sleep(2500); } catch {}
      }
      await driver.wait(async () => (await driver.findElements(By.css("iframe, webview"))).length > 0, 120000).catch(() => {});
      await driver.sleep(6000); await snap("preview");
    },

    async _bg() {
      const frames = await driver.findElements(By.css("iframe"));
      for (const f of frames) {
        try {
          await driver.switchTo().frame(f);
          const bg = await driver.executeScript(`const b=document.body; let best=b?getComputedStyle(b).backgroundColor:null;
            for(const el of document.querySelectorAll('div')){const r=el.getBoundingClientRect(); if(r.width*r.height>window.innerWidth*window.innerHeight*0.5){const c=getComputedStyle(el).backgroundColor; if(c&&c!=='rgba(0, 0, 0, 0)')best=c;}} return best;`).catch(() => null);
          await driver.switchTo().defaultContent();
          if (bg) return bg;
        } catch { await driver.switchTo().defaultContent().catch(() => {}); }
      }
      return null;
    },
    async readPreviewBackground() { return this._bg(); },

    async sendChat(text) {
      const boxEl = await driver.wait(until.elementLocated(By.css('textarea, input[placeholder*="Ask" i], input[placeholder*="message" i], input[placeholder*="follow" i]')), 20000);
      await boxEl.click();
      await boxEl.sendKeys(Key.chord(Key.META, "a"), Key.DELETE);
      await boxEl.sendKeys(text);
      await snap("chat_typed");
      let sent = false;
      for (let i = 0; i < 3 && !sent; i++) {
        try { const b = await driver.findElement(By.xpath("//button[normalize-space(.)='Send' and not(@disabled)] | //*[@aria-label='Send']")); await driver.executeScript("arguments[0].click()", b); }
        catch { try { await boxEl.sendKeys(Key.RETURN); } catch {} }
        await driver.sleep(2500);
        const rem = (await boxEl.getAttribute("value").catch(() => "")) || "";
        sent = !rem.includes(text.slice(0, 20));
      }
      await snap("chat_sent");
      return sent;
    },

    async newTask() {
      for (const rx of ["New session", "New task", "New chat", "+"]) {
        try { await tapText(rx, { timeout: 4000 }); await driver.sleep(2000); await snap("new_task"); return; } catch {}
      }
    },

    async waitForRender() { await driver.sleep(6000); await snap("render"); },
    async waitForBackground(target, timeoutMs) {
      const deadline = Date.now() + timeoutMs; let color = "unknown";
      while (Date.now() < deadline) {
        color = classifyColor(await this.readPreviewBackground());
        await snap(`bg_${color}`);
        if (color === target) return { ok: true, color };
        await driver.sleep(5000);
      }
      return { ok: false, color };
    },
  };

  async function listButtons() {
    const els = await driver.findElements(By.xpath("//*[self::a or self::button or @role='button']"));
    const s = new Set();
    for (const e of els) { const t = (await e.getText().catch(() => "")).trim(); if (t && t.length < 40) s.add(t); }
    return [...s].join(" | ");
  }
}
