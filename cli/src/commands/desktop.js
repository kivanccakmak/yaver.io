"use strict";

/**
 * Optional native desktop companion for the unified npm CLI.
 *
 * The npm package intentionally does not contain Electron itself. `yaver
 * desktop install` downloads the architecture-specific canonical `electron/`
 * release, verifies the release checksum, verifies the OS signature where the
 * host provides one, and installs per-user. The Go agent remains independently
 * usable through the console and an already-running agent is adopted by the
 * GUI instead of duplicated.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const DEFAULT_REPO = "yaver-io/yaver.io";
const WINDOWS_PUBLISHER_PATTERN = "Simkab";

const DESKTOP_HELP = `
yaver desktop — optional native Yaver GUI (the console remains available as \`yaver\`)

Commands:
  yaver desktop                     Open the installed desktop app
  yaver desktop install             Download, verify, install per-user, and open
  yaver desktop update              Install the latest verified desktop release
  yaver desktop status              Show platform, installed path, and release state
  yaver desktop path                Print the installed application path
  yaver desktop download [--format] Download a verified installer without running it

Options:
  --no-open                       Install without launching (used by npm bootstrap)

Formats:
  macOS: dmg (default)
  Linux: appimage (default), deb, rpm
  Windows: exe (default)

The GUI is downloaded as a separately signed, checksum-verified artifact; npm
does not embed Electron in the CLI tarball. Global installs bootstrap it on an
interactive desktop unless YAVER_SKIP_POSTINSTALL_DESKTOP=1 is set. Headless
Linux/CI stays console-only. Runner bootstrap can independently be disabled
with YAVER_SKIP_POSTINSTALL_RUNNERS=1.
`;

function normalizedArch(arch = process.arch) {
  if (arch === "x64" || arch === "amd64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  throw new Error(`Yaver Desktop is not published for architecture ${arch}.`);
}

function defaultFormat(platform = process.platform) {
  if (platform === "darwin") return "dmg";
  if (platform === "linux") return "appimage";
  if (platform === "win32") return "exe";
  throw new Error(`Yaver Desktop is not published for platform ${platform}.`);
}

function assetName(version, platform = process.platform, arch = process.arch, format = defaultFormat(platform)) {
  const cpu = normalizedArch(arch);
  const ext = String(format).toLowerCase();
  if (platform === "darwin" && ext === "dmg") return `yaver-gui-${version}-mac-${cpu}.dmg`;
  if (platform === "linux" && ["appimage", "deb", "rpm"].includes(ext)) {
    const suffix = ext === "appimage" ? "AppImage" : ext;
    return `yaver-gui-${version}-linux-${cpu}.${suffix}`;
  }
  if (platform === "win32" && ext === "exe") return `yaver-gui-${version}-win-${cpu}-setup.exe`;
  throw new Error(`Desktop format ${format} is not supported on ${platform}.`);
}

function parseGuiRelease(releases, requestedVersion = "") {
  const rows = Array.isArray(releases) ? releases : [];
  const wanted = String(requestedVersion || "").replace(/^gui\/v/, "").replace(/^v/, "");
  const release = rows.find((row) => {
    if (!row || row.draft || row.prerelease) return false;
    const match = String(row.tag_name || "").match(/^gui\/v(\d+\.\d+\.\d+)$/);
    return match && (!wanted || match[1] === wanted);
  });
  if (!release) throw new Error(wanted ? `No published GUI release exists for ${wanted}.` : "No published GUI release exists.");
  return { ...release, version: String(release.tag_name).slice("gui/v".length) };
}

function checksumFor(text, filename) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`checksums.txt has no SHA-256 entry for ${filename}.`);
}

function installedDesktopCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") {
    return [path.join(home, "Applications", "Yaver.app"), "/Applications/Yaver.app"];
  }
  if (platform === "linux") {
    return [
      path.join(home, ".local", "opt", "yaver", "Yaver.AppImage"),
      "/opt/Yaver/yaver-desktop",
      "/usr/bin/yaver-desktop",
      "/usr/local/bin/yaver-desktop",
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(local, "Programs", "Yaver", "Yaver.exe"),
      path.join(local, "Yaver", "Yaver.exe"),
    ];
  }
  return [];
}

function installedDesktopPath(platform = process.platform) {
  return installedDesktopCandidates(platform).find((candidate) => fs.existsSync(candidate)) || "";
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "yaver-cli-desktop", Accept: "application/vnd.github+json", ...(options.headers || {}) },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(request(response.headers.location, options));
        return;
      }
      resolve(response);
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Desktop release request timed out: ${url}`)));
    req.on("error", reject);
  });
}

async function responseText(response) {
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) body += chunk;
  return body;
}

async function download(url, destination) {
  const response = await request(url, { headers: { Accept: "application/octet-stream" } });
  if (response.statusCode !== 200) {
    const body = await responseText(response);
    throw new Error(`Desktop download failed (HTTP ${response.statusCode}) from ${url}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  await pipeline(response, fs.createWriteStream(destination, { mode: 0o700 }));
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count = 0;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function resolveDownload({ platform, arch, format, version = "" }) {
  const repo = process.env.YAVER_DESKTOP_REPO || DEFAULT_REPO;
  const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100`);
  if (response.statusCode !== 200) throw new Error(`Desktop release lookup failed (HTTP ${response.statusCode}).`);
  const release = parseGuiRelease(JSON.parse(await responseText(response)), version || process.env.YAVER_DESKTOP_VERSION);
  const filename = assetName(release.version, platform, arch, format);
  const assets = new Map((release.assets || []).map((entry) => [entry.name, entry]));
  const artifact = assets.get(filename);
  const checksums = assets.get("checksums.txt");
  if (!artifact) throw new Error(`Release ${release.tag_name} does not contain ${filename}.`);
  if (!checksums) throw new Error(`Release ${release.tag_name} has no checksums.txt; refusing an unverified desktop download.`);
  return { release, artifact, checksums, filename };
}

async function downloadVerified(options) {
  const resolved = await resolveDownload(options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaver-desktop-"));
  const artifactPath = path.join(dir, resolved.filename);
  const checksumsPath = path.join(dir, "checksums.txt");
  try {
    await download(resolved.artifact.browser_download_url, artifactPath);
    await download(resolved.checksums.browser_download_url, checksumsPath);
    const expected = checksumFor(fs.readFileSync(checksumsPath, "utf8"), resolved.filename);
    const actual = sha256(artifactPath);
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${resolved.filename}: expected ${expected}, downloaded ${actual}.`);
    return { ...resolved, artifactPath, tempDir: dir, sha256: actual };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function runChecked(command, args, message) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${message}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return result.stdout || result.stderr || "";
}

function verifyMacApp(appPath) {
  runChecked("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], "macOS code-sign verification failed");
  const details = runChecked("codesign", ["-dv", "--verbose=4", appPath], "Could not inspect the macOS signature");
  if (!details.includes("Identifier=io.yaver.gui")) throw new Error("The signed macOS app has an unexpected bundle identifier.");
  runChecked("spctl", ["--assess", "--type", "exec", "--verbose=2", appPath], "macOS Gatekeeper rejected Yaver");
  runChecked("xcrun", ["stapler", "validate", appPath], "The macOS notarization ticket is missing or invalid");
}

function installMac(downloaded) {
  const mount = path.join(downloaded.tempDir, "mount");
  fs.mkdirSync(mount);
  runChecked("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, downloaded.artifactPath], "Could not mount the Yaver DMG");
  try {
    const source = path.join(mount, "Yaver.app");
    if (!fs.existsSync(source)) throw new Error("The verified DMG does not contain Yaver.app.");
    verifyMacApp(source);
    const applications = path.join(os.homedir(), "Applications");
    fs.mkdirSync(applications, { recursive: true });
    const target = path.join(applications, "Yaver.app");
    const staging = path.join(applications, `.Yaver.app.install-${process.pid}`);
    const backup = path.join(applications, `.Yaver.app.backup-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true, force: false, preserveTimestamps: true });
    verifyMacApp(staging);
    let backedUp = false;
    try {
      if (fs.existsSync(target)) { fs.renameSync(target, backup); backedUp = true; }
      fs.renameSync(staging, target);
      if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(target) && backedUp && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return target;
  } finally {
    spawnSync("hdiutil", ["detach", mount], { stdio: "ignore" });
  }
}

function installLinuxAppImage(downloaded) {
  const root = path.join(os.homedir(), ".local", "opt", "yaver");
  const target = path.join(root, "Yaver.AppImage");
  const staging = path.join(root, `.Yaver.AppImage.install-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(downloaded.artifactPath, staging);
  fs.chmodSync(staging, 0o755);
  fs.renameSync(staging, target);

  const applications = path.join(os.homedir(), ".local", "share", "applications");
  fs.mkdirSync(applications, { recursive: true });
  const execPath = `"${target.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  fs.writeFileSync(path.join(applications, "io.yaver.gui.desktop"), [
    "[Desktop Entry]", "Name=Yaver", "Comment=AI development workspace and remote node",
    `Exec=${execPath} %U`, "Terminal=false", "Type=Application", "Categories=Development;Utility;",
    "StartupWMClass=Yaver", "MimeType=x-scheme-handler/yaver;", "",
  ].join("\n"));

  const binDir = path.join(os.homedir(), ".local", "bin");
  const link = path.join(binDir, "yaver-desktop");
  fs.mkdirSync(binDir, { recursive: true });
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`${link} already exists and is not a Yaver-managed symlink.`);
    const priorTarget = path.resolve(path.dirname(link), fs.readlinkSync(link));
    if (!priorTarget.startsWith(root + path.sep) && priorTarget !== target) {
      throw new Error(`${link} points outside the Yaver install directory; refusing to replace it.`);
    }
    fs.unlinkSync(link);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.symlinkSync(target, link);
  return target;
}

function verifyWindowsInstaller(installer) {
  const escaped = installer.replace(/'/g, "''");
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid') { throw \"Authenticode status: $($s.Status) $($s.StatusMessage)\" }; if ($s.SignerCertificate.Subject -notmatch '(?i)${WINDOWS_PUBLISHER_PATTERN}') { throw \"Unexpected publisher: $($s.SignerCertificate.Subject)\" }`;
  runChecked("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "Windows Authenticode verification failed");
}

function openDesktop(appPath, platform = process.platform) {
  let command;
  let args;
  if (platform === "darwin") { command = "open"; args = [appPath]; }
  else { command = appPath; args = []; }
  const child = spawn(command, args, { detached: true, stdio: "ignore", env: process.env });
  child.once("error", (error) => console.error(`Could not open Yaver Desktop: ${error.message}`));
  child.unref();
}

function parseDesktopArgs(args) {
  const command = !args[0] || args[0].startsWith("-") ? "open" : args[0];
  let format = "";
  let destination = "";
  let noOpen = false;
  for (let i = command === "open" && args[0]?.startsWith("-") ? 0 : 1; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) format = args[++i].toLowerCase();
    else if (args[i] === "--output" && args[i + 1]) destination = args[++i];
    else if (args[i] === "--no-open") noOpen = true;
  }
  return { command, format: format || defaultFormat(), destination, noOpen };
}

async function desktop(args = []) {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(DESKTOP_HELP);
    return;
  }
  const options = parseDesktopArgs(args);
  const existing = installedDesktopPath();
  if (options.command === "status") {
    console.log(JSON.stringify({ installed: Boolean(existing), path: existing || null, platform: process.platform, arch: normalizedArch() }, null, 2));
    return;
  }
  if (options.command === "path") {
    if (!existing) throw new Error("Yaver Desktop is not installed. Run `yaver desktop install`.");
    console.log(existing);
    return;
  }
  if (options.command === "open") {
    if (!existing) throw new Error("Yaver Desktop is not installed. Run `yaver desktop install` (the console remains available as `yaver`).");
    openDesktop(existing);
    return;
  }
  if (!["install", "update", "download"].includes(options.command)) throw new Error(`Unknown desktop command: ${options.command}\n${DESKTOP_HELP}`);

  const downloaded = await downloadVerified({ platform: process.platform, arch: process.arch, format: options.format });
  if (options.command === "download" || (process.platform === "linux" && options.format !== "appimage")) {
    const destination = path.resolve(options.destination || path.join(process.cwd(), downloaded.filename));
    fs.copyFileSync(downloaded.artifactPath, destination);
    fs.rmSync(downloaded.tempDir, { recursive: true, force: true });
    console.log(`Verified ${downloaded.filename} → ${destination}`);
    if (process.platform === "linux" && options.format === "deb") console.log(`Install with: sudo apt-get install ${JSON.stringify(destination)}`);
    if (process.platform === "linux" && options.format === "rpm") console.log(`Install with: sudo dnf install ${JSON.stringify(destination)}`);
    return;
  }

  let installed = "";
  try {
    if (process.platform === "darwin") installed = installMac(downloaded);
    else if (process.platform === "linux") installed = installLinuxAppImage(downloaded);
    else if (process.platform === "win32") {
      verifyWindowsInstaller(downloaded.artifactPath);
      const child = spawn(downloaded.artifactPath, options.noOpen ? ["/S"] : [], { detached: true, stdio: "ignore" });
      child.once("error", (error) => console.error(`Could not open the verified Yaver installer: ${error.message}`));
      child.unref();
      console.log(options.noOpen
        ? "Verified installer started in per-user silent mode."
        : "Verified installer opened. Complete the per-user installation in the Yaver setup window.");
      return;
    }
  } finally {
    if (process.platform !== "win32") fs.rmSync(downloaded.tempDir, { recursive: true, force: true });
  }
  console.log(`Yaver Desktop ${downloaded.release.version} installed at ${installed}`);
  if (!options.noOpen) openDesktop(installed);
}

module.exports = {
  DESKTOP_HELP,
  assetName,
  checksumFor,
  defaultFormat,
  desktop,
  installedDesktopCandidates,
  normalizedArch,
  parseDesktopArgs,
  parseGuiRelease,
  WINDOWS_PUBLISHER_PATTERN,
};
