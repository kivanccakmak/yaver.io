import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium, devices } from "playwright";

const roots = {
  backendless: resolve(process.env.YAVER_BACKENDLESS_DIST || "../demo/mobile/workspace-todo-backendless/apps/mobile/dist"),
  serverless: resolve(process.env.YAVER_SERVERLESS_DIST || "../demo/mobile/workspace-todo-serverless/apps/mobile/dist"),
};
const artifactRoot = resolve(process.env.YAVER_EXAMPLE_ARTIFACTS || "../test-results/mobile-workspace-examples");
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForPersistedTodo(page, title, completed) {
  await page.waitForFunction(
    ({ expectedTitle, expectedCompleted }) => Object.values(localStorage).some((raw) => {
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) && value.some((todo) =>
          todo?.title === expectedTitle && todo?.completed === expectedCompleted,
        );
      } catch {
        return false;
      }
    }),
    { expectedTitle: title, expectedCompleted: completed },
    { timeout: 10_000 },
  );
}

function startStaticServer(root) {
  assert(existsSync(join(root, "index.html")), `missing web export: ${root}/index.html`);
  const server = createServer((request, response) => {
    const rawPath = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    const relative = normalize(rawPath).replace(/^([/\\])+/, "");
    let candidate = resolve(root, relative || "index.html");
    if (!candidate.startsWith(`${root}/`) && candidate !== root) {
      response.writeHead(403).end("forbidden");
      return;
    }
    if (!existsSync(candidate) || statSync(candidate).isDirectory()) candidate = join(root, "index.html");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mime[extname(candidate)] || "application/octet-stream",
    });
    createReadStream(candidate).pipe(response);
  });
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveReady({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function openMobile(browser, name, url) {
  const videoDir = join(artifactRoot, name, "video");
  await mkdir(videoDir, { recursive: true });
  const iphone = devices["iPhone 15 Pro"];
  const context = await browser.newContext({
    ...iphone,
    recordVideo: { dir: videoDir, size: iphone.viewport },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  const device = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    ua: navigator.userAgent,
    viewport: [window.innerWidth, window.innerHeight],
  }));
  assert(
    device.viewport[0] === iphone.viewport.width && device.viewport[1] === iphone.viewport.height,
    `wrong mobile viewport: ${device.viewport}; expected ${iphone.viewport.width},${iphone.viewport.height}`,
  );
  assert(device.maxTouchPoints > 0, "browser context is not touch-capable");
  assert(device.dpr >= 2, `browser context has desktop pixel ratio: ${device.dpr}`);
  assert(/Mobile|iPhone/i.test(device.ua), `browser context has desktop user-agent: ${device.ua}`);
  return { context, page, errors };
}

async function backendlessArc(browser, url) {
  const { context, page, errors } = await openMobile(browser, "backendless", url);
  const title = "Ship backendless demo";
  await page.getByText("Pocket Tasks", { exact: true }).waitFor();
  await page.getByLabel("New task").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("checkbox", { name: title }).click();
  await waitForPersistedTodo(page, title, true);
  await page.getByRole("tab", { name: "done" }).click();
  await page.getByText(title, { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "done" }).click();
  assert(await page.getByRole("checkbox", { name: title }).isChecked(), "backendless completion did not persist");
  await page.screenshot({ path: join(artifactRoot, "backendless", "completed.png"), fullPage: true });
  await page.getByRole("button", { name: `Delete ${title}` }).click();
  await page.getByRole("tab", { name: "all" }).click();
  assert(await page.getByText(title, { exact: true }).count() === 0, "backendless delete did not apply");
  await context.close();
  assert(errors.length === 0, `backendless browser errors:\n${errors.join("\n")}`);
}

async function serverlessArc(browser, url) {
  const { context, page, errors } = await openMobile(browser, "serverless", url);
  const title = "Ship serverless demo";
  await page.getByText("YAVER SERVERLESS", { exact: true }).waitFor();
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByText("Saved locally · sync pending", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: `Complete: ${title}` }).click();
  await waitForPersistedTodo(page, title, true);
  await page.getByText("done", { exact: true }).click();
  await page.getByRole("checkbox", { name: `Mark open: ${title}` }).waitFor();

  await page.getByLabel("Yaver Serverless project token").fill("invalid-test-token");
  const dialog = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Save securely" }).click();
  const alert = await dialog;
  assert(alert.message().includes("pp_"), `invalid-token alert lacks repair guidance: ${alert.message()}`);
  await alert.dismiss();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("done", { exact: true }).click();
  await page.getByRole("checkbox", { name: `Mark open: ${title}` }).waitFor();
  await page.getByText("Connect this app", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Sync" }).isDisabled(), "sync must stay disabled without URL and project token");
  await page.screenshot({ path: join(artifactRoot, "serverless", "offline-first.png"), fullPage: true });
  await context.close();
  assert(errors.length === 0, `serverless browser errors:\n${errors.join("\n")}`);
}

await mkdir(artifactRoot, { recursive: true });
const backendless = await startStaticServer(roots.backendless);
const serverless = await startStaticServer(roots.serverless);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  await backendlessArc(browser, backendless.url);
  await serverlessArc(browser, serverless.url);
  console.log(`mobile workspace example loop passed; artifacts: ${artifactRoot}`);
} finally {
  await browser.close();
  await Promise.all([
    new Promise((resolveClose) => backendless.server.close(resolveClose)),
    new Promise((resolveClose) => serverless.server.close(resolveClose)),
  ]);
}
