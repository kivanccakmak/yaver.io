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
const PROJECT_PATH = process.env.YAVER_MOBILE_PROJECT_PATH || "/root/Workspace/yaver-todo-rn";

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
      // Search + tap the card. This EITHER opens the "What do you want to do?"
      // sheet (Browser Reload) OR — if a browser preview is already running —
      // surfaces the "Open in Yaver" banner. renderPreview handles both.
      try { await tapText("Projects", { last: true, timeout: 6000 }); } catch {}
      await driver.sleep(1200);
      try {
        const search = await driver.findElement(By.css('input[placeholder*="Search projects" i], input[placeholder*="Search" i]'));
        await search.clear(); await search.sendKeys(Key.chord(Key.META, "a"), Key.DELETE); await search.sendKeys(PROJECT);
        await driver.sleep(2000);
      } catch {}
      // If a browser preview is already RUNNING ("Stop" banner), stop it so the
      // card re-opens the SHEET with "Browser Reload" — the proven in-app iframe
      // path ("Open in Yaver" doesn't yield a readable in-app surface).
      try { const stop = await driver.findElement(By.xpath("//*[self::a or self::button or @role='button' or @tabindex][normalize-space(text())='Stop']")); await stop.click(); log("  ·· stopped running preview"); await driver.sleep(3000); } catch {}
      const sheetUp = async () => (await driver.findElements(By.xpath("//*[normalize-space(text())='Browser Reload']"))).length > 0;
      for (let attempt = 0; attempt < 5 && !(await sheetUp()); attempt++) {
        const card = await driver.wait(async () => {
          const els = await driver.findElements(By.xpath(`//*[contains(.,${xpathLit(PROJECT)}) and contains(.,${xpathLit(PROJECT_PATH)})]`));
          return els.length ? els[els.length - 1] : null;
        }, 12000).catch(() => null);
        if (card) { await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", card); try { await card.click(); } catch { await driver.executeScript("arguments[0].click()", card); } }
        await driver.sleep(3500);
        // A stray Open-in-Yaver banner? stop it and retry.
        if (!(await sheetUp())) { try { const s = await driver.findElement(By.xpath("//*[normalize-space(text())='Stop']")); await s.click(); await driver.sleep(2500); } catch {} }
      }
      await snap("project_sheet");
    },

    async renderPreview() {
      // BROWSER lane. Either the running-preview banner ("Open in Yaver") or the
      // sheet's "Browser Reload" (NOT WebRTC). REAL click (executeScript-click
      // doesn't fire RN-web onPress).
      // In-app iframe path: "Browser Reload" (from the sheet). REAL click.
      const el = await driver.wait(until.elementLocated(By.xpath("//*[normalize-space(text())='Browser Reload']")), 30000);
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", el);
      try { await el.click(); } catch { await (await el.findElement(By.xpath("./ancestor-or-self::*[@role='button' or @tabindex][1]"))).click().catch(() => {}); }
      log("  ·· clicked Browser Reload (in-app browser lane)");
      // The box builds the web bundle (first compile ~1min) then the WebView
      // (iframe in RN-web) mounts and the app PAINTS. Wait for a real
      // (non-transparent) background, not just the loading placeholder.
      await driver.wait(async () => (await driver.findElements(By.css("iframe"))).length > 0, 180000).catch(() => {});
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const bg = await this._bg();
        if (bg && classifyColor(bg) !== "unknown" && bg !== "rgba(0, 0, 0, 0)") { log(`  ·· app painted: ${bg}`); break; }
        await driver.sleep(6000);
      }
      await driver.sleep(3000); await snap("preview");
      log(`  ·· iframes: ${(await driver.findElements(By.css("iframe"))).length}`);
    },

    // Read the largest PAINTED (non-transparent) background inside a frame,
    // recursing one level into nested iframes (the mobile browser lane wraps
    // the app's web bundle in an inner iframe). Returns null if only transparent
    // / still-loading is found.
    async _bgInCurrentFrame() {
      return driver.executeScript(`
        function paint(doc){ let best=null,area=0;
          const scan=(el)=>{ const r=el.getBoundingClientRect(); const a=r.width*r.height;
            if(a>area){ const c=getComputedStyle(el).backgroundColor; if(c && c!=='rgba(0, 0, 0, 0)' && c!=='transparent'){best=c;area=a;} } };
          scan(doc.documentElement); if(doc.body) scan(doc.body);
          for(const el of doc.querySelectorAll('div,section,main,view')) scan(el);
          return best; }
        return paint(document);
      `).catch(() => null);
    },
    async _bg() {
      // top level
      let bg = await this._bgInCurrentFrame();
      const frames = await driver.findElements(By.css("iframe"));
      for (const f of frames) {
        try {
          await driver.switchTo().frame(f);
          const inner = await this._bgInCurrentFrame();
          if (inner) bg = inner;
          const nested = await driver.findElements(By.css("iframe"));
          for (const nf of nested) {
            try { await driver.switchTo().frame(nf); const deep = await this._bgInCurrentFrame(); if (deep) bg = deep; await driver.switchTo().parentFrame(); }
            catch { await driver.switchTo().parentFrame().catch(() => {}); }
          }
          await driver.switchTo().defaultContent();
        } catch { await driver.switchTo().defaultContent().catch(() => {}); }
      }
      return bg;
    },
    async readPreviewBackground() { return this._bg(); },

    async sendChat(text) {
      // Each vibe = a TASK on the box (what the mobile app creates under the
      // hood; its browser-lane UI command is shake→feedback, impractical to
      // drive reliably). The MOBILE CLIENT still renders + verifies the change
      // via the browser lane below. POST /tasks through the relay.
      const H = { Authorization: `Bearer ${cfg.auth_token}`, "Content-Type": "application/json" };
      if (cfg.cached_relay_password) H["X-Relay-Password"] = cfg.cached_relay_password;
      // The scenario phrases it as "login page"; todo-rn has no login — retarget
      // to its main screen so Codex edits the right file.
      const cmd = text.replace(/login (page|screen)/gi, "main screen (app/index.tsx / the root screen container)");
      const r = await fetch(`${RELAY}/d/${TARGET_ID}/tasks`, {
        method: "POST", headers: H,
        body: JSON.stringify({ title: cmd.slice(0, 60), description: cmd + " Do NOT commit, do NOT push, do NOT run the dev server (it is already running); just edit the file(s).", runner: "codex", workDir: PROJECT_PATH, projectName: PROJECT }),
      }).catch((e) => ({ ok: false, status: 0, _e: e }));
      const j = await (r.json?.().catch(() => ({})) ?? {});
      this._lastTaskId = j.id || j.taskId || null;
      log(`  ·· task created: ${this._lastTaskId || "?"} (HTTP ${r.status})`);
      await snap("chat_sent");
      return r.status >= 200 && r.status < 300;
    },

    async newTask() { /* each sendChat is already a distinct task */ },

    async _reloadPreview() {
      // Re-render the in-app browser lane so a source edit shows up (no
      // auto-reload). Tap the in-preview "Reload" (real click).
      for (const rx of ["Reload", "Fast Reload"]) {
        try {
          const b = await driver.findElement(By.xpath(`//*[self::a or self::button or @role='button' or @tabindex][normalize-space(text())=${xpathLit(rx)}]`));
          await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", b);
          await b.click();
          log(`  ·· reloaded preview via '${rx}'`); return true;
        } catch {}
      }
      return false;
    },

    async waitForRender() { await driver.sleep(4000); },
    async waitForBackground(target, timeoutMs) {
      const deadline = Date.now() + timeoutMs; let color = "unknown"; let reloadAt = 0;
      while (Date.now() < deadline) {
        // Periodically re-render so the runner's edit becomes visible.
        if (Date.now() - reloadAt > 25000) { await this._reloadPreview(); reloadAt = Date.now(); await driver.sleep(12000); }
        color = classifyColor(await this.readPreviewBackground());
        await snap(`bg_${color}`);
        if (color === target) return { ok: true, color };
        await driver.sleep(6000);
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
