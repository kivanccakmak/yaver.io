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
// Windows agent assets live in the MAIN repo at the same version as darwin/
// linux (verified v1.99.411 → yaver-windows-amd64.exe). The CLI's historical
// fallback repo (kivanccakmak/yaver-cli) is stale (v1.37.0) — never use it.
const WINDOWS_REPO = process.env.YAVER_WINDOWS_AGENT_REPO || DEFAULT_REPO;

function binaryName() {
  return process.platform === "win32" ? "yaver.exe" : "yaver";
}

/**
 * Go-style architecture name used by the release assets. Node says "x64";
 * the agent's release assets are named with Go's "amd64" (agent-runtime.js
 * does the same mapping: `arch === 'x64' ? 'amd64' : arch`).
 */
function goArch() {
  return process.arch === "x64" ? "amd64" : process.arch;
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

/**
 * Resolve the release tag name for a given agent version on a repo. Tags may
 * be `v1.2.3` or `cli/v1.2.3` (the CLI's stripCliTagPrefix accepts both), and
 * a release's download URL must use the EXACT tag. Prefer the API so we never
 * guess the prefix; fall back to `v<version>` for offline/rate-limited runs.
 */
async function resolveReleaseTag(repo, version) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  try {
    const res = await new Promise((resolve, reject) => {
      https.get(apiUrl, { headers: { "User-Agent": "yaver-gui-release", Accept: "application/vnd.github+json" } }, resolve).on("error", reject);
    });
    let body = "";
    for await (const chunk of res) body += chunk;
    if (res.statusCode === 200) {
      const tag = JSON.parse(body).tag_name;
      if (typeof tag === "string" && tag) return tag;
    }
  } catch {
    /* fall through */
  }
  return `v${version}`;
}

async function main() {
  const targetDir = join(__dirname, "..", "resources", "bin");
  const targetPath = join(targetDir, binaryName());
  if (existsSync(targetPath)) await rm(targetPath, { force: true });
  await mkdir(targetDir, { recursive: true });

  if (process.platform === "win32") {
    // Windows ships a raw .exe from its own repo. Resolve the release tag via
    // the API (tags may be `v1.2.3` or `cli/v1.2.3` — mirror the CLI's
    // stripCliTagPrefix), then build the asset URL.
    const winTag = await resolveReleaseTag(WINDOWS_REPO, version);
    const url = `https://github.com/${WINDOWS_REPO}/releases/download/${winTag}/yaver-windows-${goArch()}.exe`;
    console.log(`[fetch-agent] windows agent ${version} (tag ${winTag}) → ${targetPath}`);
    await download(url, targetPath);
    console.log(`[fetch-agent] done`);
    return;
  }

  // darwin / linux: tar.gz from the main repo. Try the versioned name first,
  // fall back to the unversioned legacy name (agent-runtime's second candidate).
  const tag = await resolveReleaseTag(DEFAULT_REPO, version);
  const base = `https://github.com/${DEFAULT_REPO}/releases/download/${tag}`;
  const osKey = process.platform === "darwin" ? "darwin" : "linux";
  const archKey = goArch();
  const candidates = [
    `${base}/yaver-v${version}-${osKey}-${archKey}.tar.gz`,
    `${base}/yaver-${osKey}-${archKey}.tar.gz`,
  ];
  let archivePath = null;
  for (const url of candidates) {
    try {
      archivePath = join(targetDir, "agent.tar.gz");
      await download(url, archivePath);
      console.log(`[fetch-agent] ${osKey}-${archKey} agent ${version} ← ${url}`);
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
  const extracted = join(targetDir, `yaver-${osKey}-${archKey}`);
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
