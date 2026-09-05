import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_DOWNLOADS_BY_PLATFORM,
  detectDesktopPlatform,
} from "./desktopDownloads.ts";

test("desktop download detection chooses the visitor's operating system", () => {
  assert.equal(detectDesktopPlatform({ platform: "MacIntel" }), "macos");
  assert.equal(detectDesktopPlatform({ platform: "Win32" }), "windows");
  assert.equal(
    detectDesktopPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }),
    "linux",
  );
  assert.equal(detectDesktopPlatform({ platform: "Linux armv8l" }), "linux");
});

test("each platform reveals only its own desktop artifacts", () => {
  const selected = process.env.YAVER_BREAK_DOWNLOAD_PLATFORM_GUARD === "all"
    ? Object.values(DESKTOP_DOWNLOADS_BY_PLATFORM).flat()
    : DESKTOP_DOWNLOADS_BY_PLATFORM.macos;

  assert.deepEqual(
    selected.map((download) => download.downloadKey),
    ["macArm64", "macX64"],
  );
  assert.deepEqual(
    DESKTOP_DOWNLOADS_BY_PLATFORM.windows.map((download) => download.downloadKey),
    ["winX64"],
  );
  assert.deepEqual(
    DESKTOP_DOWNLOADS_BY_PLATFORM.linux.map((download) => download.downloadKey),
    ["linuxX64", "linuxArm64", "debX64"],
  );
});

test("unknown platforms get a useful default instead of an empty panel", () => {
  assert.equal(detectDesktopPlatform({}), "macos");
});
