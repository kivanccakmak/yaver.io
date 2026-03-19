import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'feature-graphic.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
await page.goto(`file://${htmlPath}`);
await page.waitForTimeout(500);
const el = await page.$('#feature');
await el.screenshot({ path: '/Users/kivanccakmak/Desktop/playstore-feature-graphic.png' });
await browser.close();
console.log('Feature graphic saved to ~/Desktop/playstore-feature-graphic.png');
