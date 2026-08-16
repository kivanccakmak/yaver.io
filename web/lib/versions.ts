/**
 * Web-side version constants, kept in sync by scripts/sync-versions.sh.
 *
 * versions.json (repo root) is the single source of truth; this file is the
 * web-app copy because the web tsconfig cannot import JSON from outside the
 * web/ project root. sync-versions.sh rewrites GUI_VERSION here whenever
 * versions.json's `gui` key changes.
 *
 * Desktop GUI release artifacts are named deterministically by
 * electron/package.json's artifactName pattern; GitHub's
 * /releases/latest/download/ URL shape resolves each by its exact asset name.
 */
export const GUI_VERSION = "0.1.2";
export const GUI_BASE_URL =
  "https://github.com/yaver-io/yaver.io/releases/latest/download";
export const GUI_DOWNLOADS = {
  mac: `${GUI_BASE_URL}/yaver-gui-${GUI_VERSION}-mac.dmg`,
  win: `${GUI_BASE_URL}/yaver-gui-${GUI_VERSION}-win-setup.exe`,
  linux: `${GUI_BASE_URL}/yaver-gui-${GUI_VERSION}-linux.AppImage`,
  deb: `${GUI_BASE_URL}/yaver-gui-${GUI_VERSION}-linux.deb`,
} as const;
