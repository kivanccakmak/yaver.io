#!/usr/bin/env node
/**
 * Capture App Store screenshots from the HTML mockup.
 * Renders each "phone" / "marketing-bg" element at 3x for iPhone 6.7" (1290x2796).
 *
 * Usage: npx playwright install chromium && node scripts/screenshots/capture.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'generate.html');
const outDir = path.join(__dirname, 'output');

// iPhone 6.7" screenshot dimensions (App Store requirement)
const SHOT_WIDTH = 1290;
const SHOT_HEIGHT = 2796;

// Each element is 430x932 CSS pixels, so device scale = 1290/430 = 3
const DEVICE_SCALE = 3;

async function main() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 2000, height: 4000 },
    deviceScaleFactor: DEVICE_SCALE,
  });
  const page = await context.newPage();
  await page.goto(`file://${htmlPath}`);
  await page.waitForTimeout(1000);

  // Get all phone/marketing elements
  const selectors = [
    { id: 'shot1', name: '01_hero' },
    { id: 'shot2', name: '02_tasks' },
    { id: 'shot3', name: '03_agents' },
    { id: 'shot4', name: '04_devices' },
    { id: 'shot5', name: '05_privacy' },
    { id: 'shot6', name: '06_live_output' },
  ];

  for (const { id, name } of selectors) {
    const el = await page.$(`#${id}`);
    if (!el) {
      console.log(`  Skipping #${id} (not found)`);
      continue;
    }
    const outPath = path.join(outDir, `${name}.png`);
    await el.screenshot({ path: outPath });

    // Verify dimensions
    const { spawn } = await import('child_process');
    console.log(`  Captured: ${name}.png`);
  }

  await browser.close();

  // Print summary
  console.log(`\nScreenshots saved to: ${outDir}`);
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.png'));
  for (const f of files) {
    const stats = fs.statSync(path.join(outDir, f));
    console.log(`  ${f} (${(stats.size / 1024).toFixed(0)} KB)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
