/**
 * The current Go agent owns preview route rebasing and must see the original
 * scoped path before any history.replaceState call. Older agents did not
 * inject that shim, so the outer web proxy retains a narrow fallback.
 */
export function shouldInjectPreviewPathRebase(html: string): boolean {
  return !html.includes("yaver-preview-auth-shim");
}

/** Legacy compatibility only. Current agents own both scoped asset routing and
 * guest-router rebasing in one early shim, so an outer rewrite must not run
 * first and erase the path that shim needs to capture. */
export function injectPreviewPathRebase(html: string, script: string): string {
  if (!shouldInjectPreviewPathRebase(html)) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_match, attrs) => `<head${attrs}>${script}`);
  }
  return script + html;
}
