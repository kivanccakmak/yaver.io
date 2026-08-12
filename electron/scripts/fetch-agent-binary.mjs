#!/usr/bin/env node
/**
 * fetch-agent-binary.mjs — download the yaver Go agent binary for the
 * current platform into electron/resources/bin/, so electron-builder can
 * bundle it via extraResources (the GUI's embedded agent).
 *
 * Asset shapes mirror the CLI's agent-runtime.js::fetchRemoteAsset:
 *   darwin/linux → yaver-io/yaver.io releases, `yaver-v<ver>-<os>-<arch>.tar.gz`
 *   windows      → kivanccakmak/yaver-cli releases, `yaver-windows-<arch>.exe`
 *
 * The agent version is independent from the GUI version — it is read from
 * versions.json ("cli") unless YAVER_AGENT_VERSION is set.
 *
 * Usage: node scripts/fetch-agent-binary.mjs   (run from electron/)
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const versions = JSON.parse(readFileSync(join(repoRoot, "versions.json"), "utf8"));
const version = process.env.YAVER_AGENT_VERSION || versions.cli;
const DEFAULT_REPO = process.env.YAVER_AGENT_REPO || "yaver-io/yaver.io";
const WINDOWS_REPO = process.env.YAVER_WINDOWS_AGENT_REPO || "kivanccakmak/yaver-cli";

function binaryName() {
  return process.platform === "win32" ? "yaver.exe" : "yaver";
}

async function download(url, outPath) {
  const res = await new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "yaver-gui-release" } }, resolve).on("error", reject);
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    return download(res.headers.location, outPath);
  }
  if (res.statusCode !== 200) {
    throw new Error(`download failed: HTTP ${res.statusCode} for ${url}`);
  }
  // pipeline needs a real writable stream — a FileHandle is not one. On
  // success pipeline ends the stream; on error it destroys it and rejects.
  const { createWriteStream } = await import("node:fs");
  await pipeline(res, createWriteStream(outPath, { mode: 0o755 }));
}

async function main() {
  const targetDir = join(__dirname, "..", "resources", "bin");
  const targetPath = join(targetDir, binaryName());
  if (existsSync(targetPath)) await rm(targetPath, { force: true });
  await mkdir(targetDir, { recursive: true });

  if (process.platform === "win32") {
    // Windows ships a raw .exe from its own repo.
    const url = `https://github.com/${WINDOWS_REPO}/releases/download/v${version}/yaver-windows-${process.arch}.exe`;
    console.log(`[fetch-agent] windows agent ${version} → ${targetPath}`);
    await download(url, targetPath);
    console.log(`[fetch-agent] done`);
    return;
  }

  // darwin / linux: tar.gz from the main repo. Try the versioned name first,
  // fall back to the unversioned legacy name (agent-runtime's second candidate).
  const base = `https://github.com/${DEFAULT_REPO}/releases/download/v${version}`;
  const osKey = process.platform === "darwin" ? "darwin" : "linux";
  const candidates = [
    `${base}/yaver-v${version}-${osKey}-${process.arch}.tar.gz`,
    `${base}/yaver-${osKey}-${process.arch}.tar.gz`,
  ];
  let archivePath = null;
  for (const url of candidates) {
    try {
      archivePath = join(targetDir, "agent.tar.gz");
      await download(url, archivePath);
      console.log(`[fetch-agent] ${osKey}-${process.arch} agent ${version} ← ${url}`);
      break;
    } catch {
      archivePath = null;
    }
  }
  if (!archivePath) {
    throw new Error(`no agent tarball found at ${base} (tried ${candidates.length} candidates)`);
  }
  // Extract with system tar (present on macOS + Linux CI). The release
  // tarball holds the binary at the TOP level (entry name `yaver`), so no
  // --strip-components — stripping would remove the filename itself.
  await execFileAsync("tar", ["-xzf", archivePath, "-C", targetDir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  // Legacy archives extract as `yaver-<os>-<arch>`; normalize to `yaver`.
  const extracted = join(targetDir, `yaver-${osKey}-${process.arch}`);
  if (existsSync(extracted)) {
    await import("node:fs/promises").then((m) => m.rename(extracted, targetPath));
  }
  if (!existsSync(targetPath)) {
    throw new Error(`agent binary not found after extraction (looked for ${targetPath})`);
  }
  await import("node:fs/promises").then((m) => m.chmod(targetPath, 0o755));
  await rm(archivePath, { force: true });
  const size = await import("node:fs/promises").then((m) => m.stat(targetPath)).then((s) => s.size);
  console.log(`[fetch-agent] done (${size} bytes)`);
}

main().catch((err) => {
  console.error(`[fetch-agent] FAILED: ${err.message}`);
  process.exit(1);
});
