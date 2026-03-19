#!/usr/bin/env node
/**
 * Capture App Store screenshots from the HTML mockups.
 * - iPhone 6.7" (1290x2796) from generate.html
 * - iPad 13" (2048x2732) from generate-ipad.html
 *
 * Usage: npx playwright install chromium && node scripts/screenshots/capture.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// iPhone: 430x932 CSS * 3x = 1290x2796
// iPad:   1024x1366 CSS * 2x = 2048x2732
const configs = [
  {
    label: 'iPhone 6.7"',
    html: path.join(__dirname, 'generate.html'),
    outDir: path.join(__dirname, 'output'),
    scale: 3,
    viewport: { width: 2000, height: 4000 },
    prefix: 'shot',
    selectors: [
      { id: 'shot1', name: '01_hero' },
      { id: 'shot2', name: '02_tasks' },
      { id: 'shot3', name: '03_agents' },
      { id: 'shot4', name: '04_devices' },
      { id: 'shot5', name: '05_privacy' },
      { id: 'shot6', name: '06_live_output' },
    ],
    // Also generate 6.5" (1242x2688) resized copies
    resize: { dir: path.join(__dirname, 'output-6.5'), width: 1242, height: 2688, label: 'iPhone 6.5"' },
  },
  {
    label: 'iPad 13"',
    html: path.join(__dirname, 'generate-ipad.html'),
    outDir: path.join(__dirname, 'output-ipad'),
    scale: 2,
    viewport: { width: 3000, height: 5000 },
    prefix: 'ipad-shot',
    selectors: [
      { id: 'ipad-shot1', name: '01_hero' },
      { id: 'ipad-shot2', name: '02_tasks' },
      { id: 'ipad-shot3', name: '03_agents' },
      { id: 'ipad-shot4', name: '04_devices' },
      { id: 'ipad-shot5', name: '05_privacy' },
      { id: 'ipad-shot6', name: '06_live_output' },
    ],
  },
];

async function main() {
  const browser = await chromium.launch();

  for (const cfg of configs) {
    console.log(`\n=== ${cfg.label} ===`);
    if (!fs.existsSync(cfg.outDir)) fs.mkdirSync(cfg.outDir, { recursive: true });
    if (cfg.resize && !fs.existsSync(cfg.resize.dir)) fs.mkdirSync(cfg.resize.dir, { recursive: true });

    const context = await browser.newContext({
      viewport: cfg.viewport,
      deviceScaleFactor: cfg.scale,
    });
    const page = await context.newPage();
    await page.goto(`file://${cfg.html}`);
    await page.waitForTimeout(1000);

    for (const { id, name } of cfg.selectors) {
      const el = await page.$(`#${id}`);
      if (!el) {
        console.log(`  Skipping #${id} (not found)`);
        continue;
      }
      const outPath = path.join(cfg.outDir, `${name}.png`);
      await el.screenshot({ path: outPath });
      console.log(`  Captured: ${name}.png`);

      // Resize copy if configured
      if (cfg.resize) {
        const resizedPath = path.join(cfg.resize.dir, `${name}.png`);
        fs.copyFileSync(outPath, resizedPath);
        execSync(`sips --resampleHeightWidth ${cfg.resize.height} ${cfg.resize.width} "${resizedPath}" > /dev/null 2>&1`);
        console.log(`  Resized:  ${name}.png (${cfg.resize.label})`);
      }
    }

    await context.close();

    // Print summary
    const files = fs.readdirSync(cfg.outDir).filter(f => f.endsWith('.png'));
    for (const f of files) {
      const stats = fs.statSync(path.join(cfg.outDir, f));
      console.log(`  ${f} (${(stats.size / 1024).toFixed(0)} KB)`);
    }
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
