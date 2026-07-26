// previewBundlePath.ts — WHICH path the browser preview loads, in one place.
//
// The agent is the authority (status.bundleUrl); the client keeps exactly one
// compatibility override and one guard, shared by BOTH browser-preview
// implementations (app/(tabs)/apps.tsx and src/components/DevPreview.tsx —
// a fix in one is not a fix):
//
//  • LEGACY override: an agent < 1.99.355 reports bundleUrl "/dev/" (Metro)
//    even while the actual web app runs on a sibling port proxied at
//    /dev-web/ — Metro serves no page, so following the report gives a blank
//    preview behind a healthy status. Only in that exact shape (bundleUrl
//    "/dev/" AND webPort set) does the client override to /dev-web/.
//    Current agents that MEAN "/dev/" (direct expo-web serve) report no
//    webPort, or report the /dev-web/ path themselves — both honored as-is.
//    The old code overrode to /dev-web/ whenever webPort was set, which
//    worked only while the agent's WebPort() and /dev-web/ route agreed —
//    an agent serving a non-proxied bundleUrl alongside a webPort would have
//    been silently misrouted.
//
//  • EMPTY guard: an empty bundleUrl means "there is no web target" (bare
//    Metro). It must never be papered over with a "/dev/" default — a
//    WebView mounted on a wrong-or-empty url issues no useful request, so
//    nothing can ever fail or retry. Empty in, empty out; the caller renders
//    a waiting/impossible state instead of a WebView.

export function previewBundlePath(
  status: { bundleUrl?: string | null; webPort?: number | null } | null | undefined,
): string {
  if (!status) return "";
  const reported = (status.bundleUrl || "").trim();
  const hasWebSibling = !!status.webPort;
  if (!reported) return hasWebSibling ? "/dev-web/" : "";
  if (reported === "/dev/" && hasWebSibling) return "/dev-web/";
  return reported;
}
