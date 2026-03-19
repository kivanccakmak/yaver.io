#!/usr/bin/env node
/**
 * Capture real app screenshots from Expo web (localhost:8099).
 * Logs in with email/password, navigates tabs, and captures each screen.
 *
 * Usage: node scripts/screenshots/capture-web.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'output-real');
const outDir65 = path.join(__dirname, 'output-real-6.5');
const outDirTablet = path.join(__dirname, 'output-real-ipad');

// App Store dimensions
const IPHONE_67 = { width: 430, height: 932, scale: 3 };   // → 1290x2796
const IPAD_13 = { width: 1024, height: 1366, scale: 2 };   // → 2048x2732

const APP_URL = 'http://localhost:8099';
const TEST_EMAIL = 'review@yaver.io';
const TEST_PASSWORD = 'ReviewYaver2024';

async function waitAndClick(page, text, timeout = 5000) {
  const el = page.getByText(text, { exact: false }).first();
  await el.waitFor({ timeout });
  await el.click();
}

async function captureScreens(label, device, outPath) {
  console.log(`\n=== ${label} (${device.width}x${device.height} @${device.scale}x) ===`);
  if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  try {
    // Navigate to app
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Screenshot 1: Login screen
    console.log('  Capturing: login screen');
    await page.screenshot({ path: path.join(outPath, '01_login.png') });

    // Click "Continue with Email" and log in
    try {
      await waitAndClick(page, 'Continue with Email', 3000);
      await page.waitForTimeout(500);
    } catch {
      // Email form might already be visible
    }

    // Fill in email and password
    const emailInput = page.locator('input[placeholder="Email"], input[type="email"]').first();
    const passwordInput = page.locator('input[placeholder="Password"], input[type="password"]').first();

    await emailInput.waitFor({ timeout: 5000 });
    await emailInput.fill(TEST_EMAIL);
    await passwordInput.fill(TEST_PASSWORD);
    await page.waitForTimeout(300);

    // Screenshot 2: Login form filled
    console.log('  Capturing: login form');
    await page.screenshot({ path: path.join(outPath, '02_login_form.png') });

    // Submit login
    try {
      await waitAndClick(page, 'Sign In', 3000);
    } catch {
      // Try pressing Enter
      await passwordInput.press('Enter');
    }

    // Wait for navigation after login
    await page.waitForTimeout(3000);

    // Check if there's a survey screen - skip if so
    try {
      const skipBtn = page.getByText('Skip', { exact: false }).first();
      await skipBtn.waitFor({ timeout: 2000 });
      await skipBtn.click();
      await page.waitForTimeout(1000);
    } catch {
      // No survey screen
    }

    // Screenshot 3: Tasks screen (main screen after login)
    console.log('  Capturing: tasks screen');
    await page.screenshot({ path: path.join(outPath, '03_tasks.png') });

    // Navigate to Devices tab
    try {
      await waitAndClick(page, 'Devices', 3000);
      await page.waitForTimeout(1000);
      console.log('  Capturing: devices screen');
      await page.screenshot({ path: path.join(outPath, '04_devices.png') });
    } catch (e) {
      console.log(`  Skipped devices: ${e.message}`);
    }

    // Navigate to Settings tab
    try {
      await waitAndClick(page, 'Settings', 3000);
      await page.waitForTimeout(1000);
      console.log('  Capturing: settings screen');
      await page.screenshot({ path: path.join(outPath, '05_settings.png') });
    } catch (e) {
      console.log(`  Skipped settings: ${e.message}`);
    }

    // Navigate to Todos tab
    try {
      await waitAndClick(page, 'Todos', 3000);
      await page.waitForTimeout(1000);
      console.log('  Capturing: todos screen');
      await page.screenshot({ path: path.join(outPath, '06_todos.png') });
    } catch (e) {
      console.log(`  Skipped todos: ${e.message}`);
    }

    // Go back to Tasks
    try {
      await waitAndClick(page, 'Tasks', 3000);
      await page.waitForTimeout(500);
    } catch {}

  } catch (e) {
    console.error(`  Error: ${e.message}`);
  }

  await browser.close();

  // Print summary
  const files = fs.readdirSync(outPath).filter(f => f.endsWith('.png'));
  for (const f of files) {
    const stats = fs.statSync(path.join(outPath, f));
    console.log(`  ${f} (${(stats.size / 1024).toFixed(0)} KB)`);
  }

  return files.length;
}

async function main() {
  // Capture iPhone 6.7" screenshots
  const phoneCount = await captureScreens('iPhone 6.7"', IPHONE_67, outDir);

  // Generate 6.5" resized copies
  if (phoneCount > 0) {
    console.log('\n=== Resizing for iPhone 6.5" ===');
    if (!fs.existsSync(outDir65)) fs.mkdirSync(outDir65, { recursive: true });
    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.png'));
    for (const f of files) {
      const src = path.join(outDir, f);
      const dst = path.join(outDir65, f);
      fs.copyFileSync(src, dst);
      execSync(`sips --resampleHeightWidth 2688 1242 "${dst}" > /dev/null 2>&1`);
      console.log(`  Resized: ${f}`);
    }
  }

  // Capture iPad 13" screenshots
  await captureScreens('iPad 13"', IPAD_13, outDirTablet);

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
