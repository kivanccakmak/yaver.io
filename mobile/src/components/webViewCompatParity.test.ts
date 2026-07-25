/**
 * webViewCompatParity.test.ts — `npx tsx src/components/webViewCompatParity.test.ts`.
 * No RN, no jest — the tiny assert harness the rest of the repo uses.
 *
 * WebViewCompat.tsx and WebViewCompat.web.tsx are chosen by Metro's platform
 * extension, so they are two INDEPENDENT modules. Drift is invisible to tsc and
 * detonates at runtime — the shape that shipped
 * "beaconListener.getBootstrapDevices is not a function" earlier the same day.
 *
 * Source is read rather than imported: importing the native file resolves
 * react-native-webview and would prove nothing about the browser build.
 */
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

// Comments are STRIPPED before matching. The first version of this test matched
// the word "iframe" inside a doc comment, so replacing the real <iframe> with a
// <div> still passed — a guard that cannot fail is a guess, not a guard.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f: string) => stripComments(readFileSync(join(__dirname, f), "utf8"));
const nativeSrc = read("WebViewCompat.tsx");
const webSrc = read("WebViewCompat.web.tsx");

// Both must export the names every caller relies on.
for (const name of ["WebView", "WEBVIEW_SUPPORTED", "WEBVIEW_UNSUPPORTED_REASON"]) {
  ok(new RegExp(`export (const |{[^}]*\\b${name}\\b|function ${name}|type )`).test(nativeSrc) || nativeSrc.includes(name), `native exports ${name}`);
  ok(webSrc.includes(name), `web exports ${name}`);
}

// The web sibling must actually be an iframe — not a stub that renders nothing,
// which would reproduce the blank screen it exists to fix.
ok(/<iframe/.test(webSrc), "web sibling renders a real <iframe>");

// Guest pages written for the native container post through
// window.ReactNativeWebView. The web sibling must provide that bridge or those
// pages silently stop talking.
ok(webSrc.includes("ReactNativeWebView"), "web sibling bridges window.ReactNativeWebView");

// reload() is called imperatively by the preview screen.
ok(/reload\s*\(/.test(webSrc), "web sibling implements reload()");

console.log(`\nwebViewCompatParity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
