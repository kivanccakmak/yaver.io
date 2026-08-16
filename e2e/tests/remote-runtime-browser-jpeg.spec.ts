import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * §3 closed-loop guard: RN/Flutter browser-window remote-runtime streaming.
 *
 * This is NOT the RTP H.264 lane. On Linux/Hetzner, RN/Expo web and Flutter web
 * stream through the browser-window target: headless Chromium on the box
 * captures PNG screenshots, the agent transcodes them to JPEG, and WebRTC sends
 * those bytes over the `frames` DataChannel. A blob <img> existing is not enough;
 * this spec samples the decoded JPEG pixels and requires actual frame content.
 *
 * Env:
 *   YAVER_BROWSER_JPEG_BASE      agent base URL, e.g. http://ubuntu-4gb:18080
 *   YAVER_TEST_TOKEN             owner token; falls back to ~/.yaver/config.json
 *   E2E_BROWSER_JPEG_PROJECTS    optional "name|framework|workDir,name|framework|workDir"
 *   E2E_BROWSER_JPEG_ALL=1       run discovered RN/Flutter candidates, not just the active one
 *   E2E_EXPECT_MOBILE_VIEWPORT=1 require RN/Flutter JPEG frames to be portrait/mobile-shaped
 *   E2E_REQUIRE_PIXELS=1         fail NAMED refusals instead of recording them
 */

type Verdict = "PIXELS" | "NAMED" | "SILENT";

type ProjectCase = {
  name: string;
  framework: string;
  workDir: string;
};

const BASE = (process.env.YAVER_BROWSER_JPEG_BASE || process.env.YAVER_WEBRTC_BASE || "").replace(/\/$/, "");
const TOKEN = process.env.YAVER_TEST_TOKEN || tokenFromLocalConfig();
const HAS_LIVE = !!(BASE && TOKEN);
let browserJPEGOfferExposed = false;
let activeOfferSessionId = "";

function tokenFromLocalConfig(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
    return typeof cfg.auth_token === "string" ? cfg.auth_token : "";
  } catch {
    return "";
  }
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function agent(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data, text };
}

function configuredProjects(): ProjectCase[] {
  const raw = process.env.E2E_BROWSER_JPEG_PROJECTS || "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, framework, workDir] = part.split("|");
      return { name: name || framework || workDir, framework, workDir };
    })
    .filter((p) => p.framework && p.workDir);
}

async function discoverProjects(): Promise<ProjectCase[]> {
  const explicit = configuredProjects();
  if (explicit.length > 0) return explicit;

  const [res, status] = await Promise.all([agent("/projects/web"), agent("/dev/status").catch(() => null)]);
  if (!res.ok) throw new Error(`/projects/web HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const projects = Array.isArray(res.data.projects) ? res.data.projects : [];
  const wanted = ["expo", "react-native", "flutter"];
  const picked: ProjectCase[] = [];
  const activeWorkDir = String(status?.data?.workDir || "");
  const active = projects.find((row: any) => activeWorkDir && samePath(row?.path, activeWorkDir));
  if (active?.path && wanted.includes(String(active.framework || "").toLowerCase())) {
    picked.push({
      name: String(active.name || active.framework || "active"),
      framework: String(active.framework).toLowerCase(),
      workDir: String(active.path),
    });
    if (process.env.E2E_BROWSER_JPEG_ALL !== "1") return picked;
  }
  for (const fw of wanted) {
    const p = projects.find((row: any) => String(row?.framework || "").toLowerCase() === fw);
    if (p?.path && !picked.some((existing) => samePath(existing.workDir, p.path))) {
      picked.push({ name: String(p.name || fw), framework: fw, workDir: String(p.path) });
    }
  }
  return picked;
}

async function ensureDevServer(project: ProjectCase): Promise<{ ok: boolean; named?: string }> {
  const status = await agent("/dev/status");
  if (
    status.ok &&
    status.data?.running === true &&
    samePath(status.data?.workDir, project.workDir) &&
    hasWebPort(status.data, project.framework)
  ) {
    return { ok: true };
  }

  const started = await agent("/dev/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      framework: project.framework,
      workDir: project.workDir,
      platform: "web",
    }),
  });
  if (!started.ok) return { ok: false, named: namedFrom(started, "dev server start refused") };

  const wrongWorkDirDeadline = Date.now() + 20_000;
  const deadline = Date.now() + Number(process.env.E2E_BROWSER_JPEG_DEV_TIMEOUT_MS || 240_000);
  let last = "";
  while (Date.now() < deadline) {
    const cur = await agent("/dev/status");
    last = cur.text || JSON.stringify(cur.data || {});
    if (
      cur.ok &&
      samePath(cur.data?.workDir, project.workDir) &&
      (cur.data?.running === true || cur.data?.building === true) &&
      hasWebPort(cur.data, project.framework)
    ) {
      return { ok: true };
    }
    if (
      Date.now() > wrongWorkDirDeadline &&
      cur.ok &&
      cur.data?.running === true &&
      hasWebPort(cur.data, String(cur.data?.framework || project.framework)) &&
      cur.data?.workDir &&
      !samePath(cur.data?.workDir, project.workDir)
    ) {
      return {
        ok: false,
        named: `/dev/start accepted ${project.name}, but /dev/status is still serving ${cur.data.workDir}; active workDir must match the requested project`,
      };
    }
    if (cur.data?.error || cur.data?.capabilityGap) {
      return { ok: false, named: namedFrom(cur, "dev server failed") };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, named: `dev server did not expose a web port for ${project.name}; last status: ${last.slice(0, 240)}` };
}

function hasWebPort(status: any, framework: string): boolean {
  if (!status) return false;
  const generic = Number(status.devServerPort || status.port || 0);
  const web = Number(status.webPreviewPort || status.webPort || 0);
  if (framework === "flutter") return generic > 0;
  return web > 0 || generic > 0;
}

function samePath(a: unknown, b: unknown): boolean {
  const aa = String(a || "").replace(/\/+$/, "");
  const bb = String(b || "").replace(/\/+$/, "");
  return aa.length > 0 && aa === bb;
}

function namedFrom(res: { status: number; data: any; text: string }, fallback: string): string {
  const data = res.data || {};
  const gap = data.capabilityGap;
  const pieces = [
    data.reason,
    data.error,
    data.message,
    gap?.title,
    gap?.message,
    gap?.suggestedAction,
    data.note,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(" · ").slice(0, 400) : `${fallback}: HTTP ${res.status} ${res.text.slice(0, 240)}`;
}

async function assertMobileBrowserTarget(project: ProjectCase): Promise<{ ok: boolean; named?: string }> {
  if (process.env.E2E_EXPECT_MOBILE_VIEWPORT !== "1") return { ok: true };
  const res = await agent(
    `/remote-runtime/capabilities?workDir=${encodeURIComponent(project.workDir)}&framework=${encodeURIComponent(project.framework)}&refresh=1`,
  );
  if (!res.ok) return { ok: false, named: namedFrom(res, "remote runtime capabilities refused") };
  const target = Array.isArray(res.data?.targets)
    ? res.data.targets.find((candidate: any) => candidate?.id === "browser-window")
    : null;
  if (!target) return { ok: false, named: "capabilities did not offer browser-window for the mobile browser lane" };
  if (target.displaySurface !== "mobile-web") {
    return {
      ok: false,
      named: `browser-window displaySurface=${JSON.stringify(target.displaySurface)}; expected "mobile-web" for ${project.framework}`,
    };
  }
  const viewport = target.viewport;
  if (!viewport || Number(viewport.height || 0) <= Number(viewport.width || 0)) {
    return {
      ok: false,
      named: `browser-window viewport=${JSON.stringify(viewport)}; expected portrait mobile viewport for ${project.framework}`,
    };
  }
  return { ok: true };
}

async function createSession(project: ProjectCase): Promise<{ ok: boolean; session?: any; named?: string }> {
  const res = await agent("/remote-runtime/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      framework: project.framework,
      workDir: project.workDir,
      targetId: "browser-window",
      transportMode: "direct-webrtc",
    }),
  });
  if (!res.ok) return { ok: false, named: namedFrom(res, "remote runtime session refused") };
  const session = res.data;
  if (String(session.status || "").includes("failed") || String(session.status || "") === "waiting-for-dev-server") {
    return { ok: false, session, named: session.note || `session status ${session.status}` };
  }
  return { ok: true, session };
}

async function closeSession(sessionId: string): Promise<void> {
  await agent(`/remote-runtime/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
}

async function control(sessionId: string, body: Record<string, unknown>): Promise<void> {
  const res = await agent(`/remote-runtime/sessions/${encodeURIComponent(sessionId)}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(namedFrom(res, "remote runtime control failed"));
}

async function installReceiver(page: Page): Promise<void> {
  await page.setContent(`<!doctype html>
    <meta charset="utf-8" />
    <style>html,body{margin:0;background:#111}img{width:720px;height:auto}</style>
    <img id="frame" alt="remote frame" />
    <script>
      window.__yv = { frames: 0, ready: false, transport: "", error: "", ice: "" };
      let pc;
      let objectUrl;
      window.startJPEGDC = async function startJPEGDC(answerCb) {
        pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        pc.createDataChannel("primer");
        pc.oniceconnectionstatechange = () => { window.__yv.ice = pc.iceConnectionState; };
        pc.ondatachannel = (event) => {
          const ch = event.channel;
          if (ch.label === "frames") {
            ch.binaryType = "arraybuffer";
            ch.onmessage = (msg) => {
              if (objectUrl) URL.revokeObjectURL(objectUrl);
              objectUrl = URL.createObjectURL(new Blob([msg.data], { type: "image/jpeg" }));
              const img = document.getElementById("frame");
              img.onload = () => { window.__yv.frames += 1; };
              img.src = objectUrl;
            };
          }
          if (ch.label === "events") {
            ch.onmessage = (msg) => {
              try {
                const p = JSON.parse(String(msg.data));
                if (p.type === "ready") { window.__yv.ready = true; window.__yv.transport = p.transport || ""; }
                if (p.error) window.__yv.error = p.error;
              } catch {}
            };
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); };
          setTimeout(resolve, 2500);
        });
        const answer = await answerCb(pc.localDescription.type, pc.localDescription.sdp);
        await pc.setRemoteDescription(answer);
      };
      window.sampleFrame = function sampleFrame() {
        const img = document.getElementById("frame");
        if (!img.naturalWidth || !img.naturalHeight) return null;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const cx = Math.floor(c.width / 2), cy = Math.floor(c.height / 2);
        const d = ctx.getImageData(cx, cy, 1, 1).data;
        const grid = [], sig = [];
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 12; x++) {
            const sx = Math.floor((x + 0.5) * c.width / 12);
            const sy = Math.floor((y + 0.5) * c.height / 8);
            const p = ctx.getImageData(sx, sy, 1, 1).data;
            const rgb = [p[0], p[1], p[2]].join(",");
            grid.push(rgb);
            sig.push(String(Math.round(p[0] / 16)), String(Math.round(p[1] / 16)), String(Math.round(p[2] / 16)));
          }
        }
        return { r: d[0], g: d[1], b: d[2], w: c.width, h: c.height, frames: window.__yv.frames, unique: Array.from(new Set(grid)).length, signature: sig.join(".") };
      };
    </script>`);
}

async function negotiate(page: Page, sessionId: string): Promise<{ ok: boolean; named?: string; transport?: string }> {
  activeOfferSessionId = sessionId;
  if (!browserJPEGOfferExposed) {
    await page.exposeFunction("yaverBrowserJPEGOffer", async (type: string, sdp: string) => {
      const res = await agent(`/remote-runtime/sessions/${encodeURIComponent(activeOfferSessionId)}/webrtc/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, sdp }),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, data: res.data, text: res.text };
      }
      return { ok: true, status: res.status, data: res.data, text: res.text };
    });
    browserJPEGOfferExposed = true;
  }
  const result = await page.evaluate(
    async () => {
      let outer: any = null;
      await (window as any).startJPEGDC(async (type: string, sdp: string) => {
        const res = await (window as any).yaverBrowserJPEGOffer(type, sdp);
        outer = res;
        if (!res.ok) throw new Error(res.data?.error || `offer HTTP ${res.status}`);
        return { type: res.data?.answer?.type || "answer", sdp: res.data?.answer?.sdp || "" };
      });
      return outer;
    },
  );
  if (!result?.ok) return { ok: false, named: namedFrom({ status: result?.status || 0, data: result?.data || {}, text: "" }, "WebRTC offer refused") };
  return { ok: true, transport: String(result.data?.transport || result.data?.session?.frameTransport || "") };
}

async function waitForPixelContent(page: Page): Promise<{ verdict: Verdict; detail: string }> {
  const samples: any[] = [];
  const deadline = Date.now() + Number(process.env.E2E_BROWSER_JPEG_PIXEL_TIMEOUT_MS || 90_000);
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => (window as any).__yv);
    const sample = await page.evaluate(() => (window as any).sampleFrame());
    if (sample) {
      samples.push(sample);
      const notBlank = sample.unique > 1 || Math.max(sample.r, sample.g, sample.b) > 24;
      if (sample.w > 100 && sample.h > 100 && sample.frames >= 2 && notBlank) {
        if (process.env.E2E_EXPECT_MOBILE_VIEWPORT === "1" && sample.h <= sample.w) {
          return {
            verdict: "SILENT",
            detail: `mobile browser-window rendered desktop-shaped JPEG ${sample.w}x${sample.h}; expected portrait mobile viewport`,
          };
        }
        return {
          verdict: "PIXELS",
          detail: `JPEG-DC ${sample.w}x${sample.h}, frames=${sample.frames}, center=rgb(${sample.r},${sample.g},${sample.b}), uniqueGrid=${sample.unique}`,
        };
      }
    }
    if (state?.error) return { verdict: "NAMED", detail: String(state.error).slice(0, 300) };
    await page.waitForTimeout(700);
  }
  const last = samples.at(-1);
  return {
    verdict: "SILENT",
    detail: last
      ? `frames arrived but looked blank/static: ${JSON.stringify(last)}`
      : "no JPEG-DC frame decoded into the receiver image",
  };
}

async function waitForSignatureChange(page: Page, before: string): Promise<{ verdict: Verdict; detail: string }> {
  const deadline = Date.now() + Number(process.env.E2E_BROWSER_JPEG_CONTROL_TIMEOUT_MS || 30_000);
  let last: any = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => (window as any).sampleFrame());
    if (last?.signature && last.signature !== before) {
      return {
        verdict: "PIXELS",
        detail: `frame changed after control input; frames=${last.frames}, center=rgb(${last.r},${last.g},${last.b})`,
      };
    }
    await page.waitForTimeout(700);
  }
  return {
    verdict: "SILENT",
    detail: last ? `control input did not change frame signature (${last.frames} frames)` : "no frame to compare after control input",
  };
}

test.describe.serial("remote-runtime browser-window JPEG-DC (§3 live)", () => {
  test.skip(!HAS_LIVE, "set YAVER_BROWSER_JPEG_BASE/YAVER_WEBRTC_BASE and YAVER_TEST_TOKEN, or local ~/.yaver/config.json");
  test.setTimeout(Number(process.env.E2E_BROWSER_JPEG_TIMEOUT_MS || 8 * 60_000));

  let cases: ProjectCase[] = [];
  test.beforeAll(async () => {
    cases = await discoverProjects();
    if (cases.length === 0) {
      throw new Error("no Expo/RN/Flutter web-capable projects found; set E2E_BROWSER_JPEG_PROJECTS='name|framework|/abs/path'");
    }
  });

  test("streams real browser-window pixels over WebRTC DataChannel", async ({ page }, testInfo) => {
    for (const project of cases) {
      await test.step(`${project.name} (${project.framework})`, async () => {
        const dev = await ensureDevServer(project);
        if (!dev.ok) {
          testInfo.annotations.push({ type: "NAMED", description: `${project.name}: ${dev.named}` });
          if (process.env.E2E_REQUIRE_PIXELS === "1") throw new Error(`${project.name}: ${dev.named}`);
          return;
        }

        const caps = await assertMobileBrowserTarget(project);
        if (!caps.ok) {
          testInfo.annotations.push({ type: "NAMED", description: `${project.name}: ${caps.named}` });
          if (process.env.E2E_REQUIRE_PIXELS === "1") throw new Error(`${project.name}: ${caps.named}`);
          return;
        }

        const created = await createSession(project);
        if (!created.ok) {
          testInfo.annotations.push({ type: "NAMED", description: `${project.name}: ${created.named}` });
          if (process.env.E2E_REQUIRE_PIXELS === "1") throw new Error(`${project.name}: ${created.named}`);
          return;
        }
        const sessionId = String(created.session.id);
        try {
          await installReceiver(page);
          const negotiated = await negotiate(page, sessionId);
          if (!negotiated.ok) {
            testInfo.annotations.push({ type: "NAMED", description: `${project.name}: ${negotiated.named}` });
            if (process.env.E2E_REQUIRE_PIXELS === "1") throw new Error(`${project.name}: ${negotiated.named}`);
            return;
          }
          expect(negotiated.transport, `${project.name}: must negotiate JPEG-DC on browser-window`).toContain("jpeg");
          const outcome = await waitForPixelContent(page);
          await testInfo.attach(`${project.name.replace(/\W+/g, "-")}-jpeg-dc.png`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          console.log(`[browser-jpeg] ${outcome.verdict} ${project.name} — ${outcome.detail}`);
          if (outcome.verdict === "NAMED" && process.env.E2E_REQUIRE_PIXELS !== "1") return;
          expect(outcome.verdict, `${project.name}: ${outcome.detail}`).toBe("PIXELS");

          const before = await page.evaluate(() => (window as any).sampleFrame());
          expect(before?.signature, `${project.name}: no frame signature before control input`).toBeTruthy();
          const token = `yj${Date.now().toString(36).slice(-6)}`;
          await control(sessionId, { action: "tap", x: 60, y: 115 });
          await control(sessionId, { action: "text", text: token });
          await control(sessionId, { action: "tap", x: 1220, y: 115 });
          const changed = await waitForSignatureChange(page, before.signature);
          await testInfo.attach(`${project.name.replace(/\W+/g, "-")}-after-control.png`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          console.log(`[browser-jpeg-control] ${changed.verdict} ${project.name} — ${changed.detail}`);
          expect(changed.verdict, `${project.name}: ${changed.detail}`).toBe("PIXELS");
        } finally {
          await closeSession(sessionId);
        }
      });
    }
  });
});
