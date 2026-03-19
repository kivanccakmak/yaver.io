#!/usr/bin/env node

/**
 * Upload desktop installers to Convex storage.
 * Usage: node scripts/upload-downloads.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Read CONVEX_URL from backend/.env.local
const envFile = fs.readFileSync(path.join(ROOT, "backend", ".env.local"), "utf8");
const convexUrl = envFile.match(/CONVEX_URL=(.+)/)?.[1]?.trim();
if (!convexUrl) {
  console.error("CONVEX_URL not found in backend/.env.local");
  process.exit(1);
}

const DIST = path.join(ROOT, "desktop", "installer", "dist");

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "desktop", "installer", "package.json"), "utf8"));
const VERSION = pkg.version;

const FILES = [
  { file: `Yaver-${VERSION}-arm64.dmg`, platform: "macos", arch: "arm64", format: "dmg", filename: "Yaver-arm64.dmg" },
  { file: `Yaver-${VERSION}-arm64-mac.zip`, platform: "macos", arch: "arm64", format: "zip", filename: "Yaver-arm64.zip" },
  { file: `Yaver-${VERSION}-arm64.AppImage`, platform: "linux", arch: "arm64", format: "appimage", filename: "Yaver-arm64.AppImage" },
  { file: `yaver-installer_${VERSION}_arm64.deb`, platform: "linux", arch: "arm64", format: "deb", filename: "yaver-arm64.deb" },
  { file: `Yaver-${VERSION}.deb`, platform: "linux", arch: "amd64", format: "deb", filename: "yaver-amd64.deb" },
  { file: `Yaver-${VERSION}.AppImage`, platform: "linux", arch: "amd64", format: "appimage", filename: "Yaver-amd64.AppImage" },
  { file: `Yaver Setup ${VERSION}.exe`, platform: "windows", arch: "amd64", format: "exe", filename: "Yaver-Setup.exe" },
];

async function convexMutation(fnPath, args = {}) {
  const res = await fetch(`${convexUrl}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  if (!res.ok) throw new Error(`Mutation ${fnPath} failed: ${await res.text()}`);
  const data = await res.json();
  return data.value;
}

async function convexQuery(fnPath, args = {}) {
  const res = await fetch(`${convexUrl}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  if (!res.ok) throw new Error(`Query ${fnPath} failed: ${await res.text()}`);
  const data = await res.json();
  return data.value;
}

async function uploadFile(entry) {
  const filePath = path.join(DIST, entry.file);
  if (!fs.existsSync(filePath)) {
    console.log(`  skip: ${entry.file} (not found)`);
    return;
  }

  const stat = fs.statSync(filePath);
  const size = stat.size;
  console.log(`  uploading: ${entry.file} (${(size / 1024 / 1024).toFixed(1)} MB)...`);

  // Get upload URL
  const uploadUrl = await convexMutation("downloads:generateUploadUrl");

  // Upload the file as a Blob (avoids EPIPE with streams)
  const fileBuffer = fs.readFileSync(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([fileBuffer]),
  });

  if (!uploadRes.ok) {
    console.error(`  FAILED: ${entry.file} — ${await uploadRes.text()}`);
    return;
  }

  const { storageId } = await uploadRes.json();

  // Record the download entry
  await convexMutation("downloads:createDownload", {
    platform: entry.platform,
    arch: entry.arch,
    format: entry.format,
    version: VERSION,
    filename: entry.filename,
    storageId,
    size,
  });

  console.log(`  done: ${entry.file} → ${storageId}`);
}

async function main() {
  console.log(`Uploading to: ${convexUrl}`);
  console.log(`Dist dir: ${DIST}\n`);

  for (const entry of FILES) {
    await uploadFile(entry);
  }

  console.log("\nAll uploads complete. Verifying...");
  const downloads = await convexQuery("downloads:listDownloads");
  console.log(`\n${downloads.length} downloads available:`);
  for (const d of downloads) {
    console.log(`  ${d.platform}/${d.arch}/${d.format}: ${d.filename} (${(d.size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
