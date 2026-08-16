"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  assetName,
  checksumFor,
  installedDesktopCandidates,
  normalizedArch,
  parseDesktopArgs,
  parseGuiRelease,
  WINDOWS_PUBLISHER_PATTERN,
} = require("../src/commands/desktop");

test("desktop artifacts are architecture-specific on every OS", () => {
  assert.equal(assetName("1.2.3", "darwin", "arm64", "dmg"), "yaver-gui-1.2.3-mac-arm64.dmg");
  assert.equal(assetName("1.2.3", "darwin", "x64", "dmg"), "yaver-gui-1.2.3-mac-x64.dmg");
  assert.equal(assetName("1.2.3", "linux", "amd64", "deb"), "yaver-gui-1.2.3-linux-x64.deb");
  assert.equal(assetName("1.2.3", "linux", "aarch64", "appimage"), "yaver-gui-1.2.3-linux-arm64.AppImage");
  assert.equal(assetName("1.2.3", "win32", "x64", "exe"), "yaver-gui-1.2.3-win-x64-setup.exe");
});

test("unsupported desktop architectures and format/OS combinations fail named", () => {
  assert.throws(() => normalizedArch("ia32"), /not published for architecture ia32/);
  assert.throws(() => assetName("1.2.3", "darwin", "arm64", "deb"), /not supported on darwin/);
});

test("release resolver ignores generic CLI and prerelease tags", () => {
  const release = parseGuiRelease([
    { tag_name: "v99.0.0", assets: [] },
    { tag_name: "gui/v2.0.0", prerelease: true, assets: [] },
    { tag_name: "gui/v1.4.0", draft: false, prerelease: false, assets: [{ name: "x" }] },
  ]);
  assert.equal(release.version, "1.4.0");
  assert.equal(parseGuiRelease([{ tag_name: "gui/v1.4.0" }], "1.4.0").version, "1.4.0");
});

test("checksum parser requires an exact asset filename", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumFor(`${hash}  yaver-gui-1.2.3-linux-x64.deb\n`, "yaver-gui-1.2.3-linux-x64.deb"), hash);
  assert.throws(() => checksumFor(`${hash}  other.deb\n`, "wanted.deb"), /no SHA-256 entry/);
});

test("desktop command parser supports non-launching npm bootstrap", () => {
  assert.deepEqual(parseDesktopArgs([]), { command: "open", format: process.platform === "darwin" ? "dmg" : process.platform === "win32" ? "exe" : "appimage", destination: "", noOpen: false });
  assert.equal(parseDesktopArgs(["install"]).command, "install");
  assert.deepEqual(parseDesktopArgs(["download", "--format", "deb", "--output", "./yaver.deb"]), {
    command: "download", format: "deb", destination: "./yaver.deb", noOpen: false,
  });
  assert.equal(parseDesktopArgs(["install", "--no-open"]).noOpen, true);
});

test("installed app candidates are per-user first", () => {
  assert.equal(installedDesktopCandidates("darwin", {}, "/Users/tester")[0], path.join("/Users/tester", "Applications", "Yaver.app"));
  assert.equal(installedDesktopCandidates("linux", {}, "/home/tester")[0], path.join("/home/tester", ".local", "opt", "yaver", "Yaver.AppImage"));
  assert.equal(installedDesktopCandidates("win32", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }, "C:\\Users\\tester")[0], path.join("C:\\Users\\tester\\AppData\\Local", "Programs", "Yaver", "Yaver.exe"));
});

test("Windows installer trust is pinned to the Simkab publisher identity", () => {
  assert.equal(WINDOWS_PUBLISHER_PATTERN, "Simkab");
});
