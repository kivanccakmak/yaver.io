#!/usr/bin/env node
/**
 * Vibing lane headless test — "yaver web / tvos / mobile headless".
 *
 * Verifies the remote-box → client streaming lane used by Vibing (live preview):
 *   1. Sign in (email) → get a session token.
 *   2. Connect to the target device via the relay (HTTP proxy).
 *   3. POST /dev/start { workDir } → start the dev server + preview on the box.
 *   4. Poll /dev/status until serving.
 *   5. Fetch /dev/stream → the running app's HTML (the "browser lane").
 *   6. HEAD the app's JS bundle via /dev/ to confirm assets are reachable
 *      (with and without auth — this reveals whether a plain WebView can load it).
 *   7. POST /dev/stop.
 *
 * Credentials via env (never committed):
 *   YAVER_EMAIL, YAVER_PASSWORD, RELAY_PASSWORD, DEVICE_ID,
 *   CONVEX_URL (default https://perceptive-minnow-557.eu-west-1.convex.site)
 *   WORK_DIR (default: the device's first web-capable project path)
 */
import { readFileSync } from "fs";

const CONVEX = process.env.CONVEX_URL || "https://perceptive-minnow-557.eu-west-1.convex.site";
const EMAIL = process.env.YAVER_EMAIL || "";
const PASSWORD = process.env.YAVER_PASSWORD || "";
const RELAY_PW = process.env.RELAY_PASSWORD || "";
const DEVICE_ID = process.env.DEVICE_ID || "";
const WORK_DIR = process.env.WORK_DIR || "";

const RELAY = "https://public.yaver.io";
const T = 12 * 1000; // per-request timeout

const H = (token) => ({
  Authorization: `Bearer ${token}`,
  "X-Relay-Password": RELAY_PW,
  "Content-Type": "application/json",
});

function log(ok, msg) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  return ok;
}

async function main() {
  if (!EMAIL || !PASSWORD || !RELAY_PW || !DEVICE_ID) {
    console.error("set YAVER_EMAIL, YAVER_PASSWORD, RELAY_PASSWORD, DEVICE_ID env vars");
    process.exit(2);
  }

  // 1. Sign in
  const loginRes = await fetch(`${CONVEX}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) return log(false, `login (${loginRes.status})`);
  const { token } = await loginRes.json();
  log(true, "login → session token");

  const D = `${RELAY}/d/${DEVICE_ID}`;

  // 2. Discover projects if no WORK_DIR given
  let workDir = WORK_DIR;
  if (!workDir) {
    const pr = await fetch(`${D}/projects?refresh=1`, { headers: H(token) });
    if (pr.ok) {
      const { projects } = await pr.json();
      const web = projects?.find((p) => p.path && !/mobile|flutter|ios|android/i.test(p.path));
      workDir = web?.path || projects?.[0]?.path;
    }
    log(!!workDir, `discovered workDir: ${workDir || "none"}`);
    if (!workDir) return log(false, "no project discovered");
  }

  // 3. Start the dev server + preview
  const startRes = await fetch(`${D}/dev/start`, {
    method: "POST",
    headers: H(token),
    body: JSON.stringify({ workDir }),
  });
  if (!startRes.ok) return log(false, `/dev/start ${startRes.status}: ${await startRes.text()}`);
  const start = await startRes.json();
  log(true, `/dev/start → framework=${start.framework} kind=${start.kind} port=${start.port} vibeSessionId=${start.vibeSessionId || "?"}`);

  // 4. Poll /dev/status until serving
  let serving = false;
  for (let i = 0; i < 30; i++) {
    const st = await (await fetch(`${D}/dev/status`, { headers: H(token) })).json();
    if (st.serving) {
      serving = true;
      log(true, `/dev/status → serving (${st.servingLabel}) port=${st.port} session=${st.vibeSessionId}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!serving) {
    await fetch(`${D}/dev/stop`, { method: "POST", headers: H(token) }).catch(() => {});
    return log(false, "/dev/status never became serving");
  }

  // 5. Fetch the app HTML (the browser lane)
  const htmlRes = await fetch(`${D}/dev/stream`, { headers: H(token) });
  const html = await htmlRes.text();
  log(htmlRes.ok && /<html/i.test(html), `/dev/stream → ${htmlRes.status}, ${html.length} bytes HTML`);

  // 6. Asset reachability: with auth (fetch can) vs without (WebView can't)
  const bundleMatch = html.match(/(?:src|href)="([^"]+\.(?:js|bundle)[^"]*)"/);
  const assetPath = bundleMatch?.[1]?.replace(/^\//, "") || "";
  if (assetPath) {
    const withAuth = await fetch(`${D}/dev/${assetPath}`, { headers: H(token) });
    log(withAuth.ok, `asset (auth) ${assetPath} → ${withAuth.status}`);
    const noAuth = await fetch(`${D}/dev/${assetPath}`);
    log(noAuth.status !== 401 && noAuth.ok, `asset (no-auth) → ${noAuth.status} ${noAuth.status === 401 ? "(WebView would need injected auth)" : ""}`);
  } else {
    log(true, "no inline JS bundle path found in HTML");
  }

  // 7. Stop
  const stop = await fetch(`${D}/dev/stop`, { method: "POST", headers: H(token) });
  log(stop.ok, `/dev/stop → ${stop.status}`);
  console.log("done");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
