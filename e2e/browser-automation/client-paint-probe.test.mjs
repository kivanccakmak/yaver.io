import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { launchChromium } from "./chromium-executable.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probePath = path.resolve(here, "../../desktop/agent/screen_context_probe.js");

test("client paint probe rejects an empty Expo root, then reports the committed app", async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div id="root"></div></main>');
    await page.evaluate(() => {
      window.__paintMessages = [];
      window.ReactNativeWebView = {
        postMessage(raw) {
          try { window.__paintMessages.push(JSON.parse(raw)); } catch {}
        },
      };
    });
    await page.addScriptTag({ content: await readFile(probePath, "utf8") });

    await page.waitForTimeout(700);
    assert.equal(
      await page.evaluate(() => window.__paintMessages.some((message) => message?.t === "yaver-rendered")),
      false,
      "a loaded Expo document with an empty #root must remain unrendered",
    );

    await page.evaluate(() => {
      const app = document.createElement("section");
      app.textContent = "sfmg app content";
      document.querySelector("#root")?.appendChild(app);
    });
    await page.waitForFunction(
      () => window.__paintMessages.some((message) => message?.t === "yaver-rendered"),
      undefined,
      { timeout: 3_000 },
    );

    const rendered = await page.evaluate(
      () => window.__paintMessages.find((message) => message?.t === "yaver-rendered"),
    );
    assert.equal(rendered.state.mountId, "root");
    assert.equal(rendered.state.mountChildren, 1);
  } finally {
    await browser.close();
  }
});
