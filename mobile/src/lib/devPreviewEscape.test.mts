import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "src/components/DevPreview.tsx"), "utf8");

function webViewBlock(): string {
  const match = /<WebView\s*\n/.exec(source);
  assert.notEqual(match, null, "DevPreview.tsx no longer renders a <WebView> element");
  const start = match!.index;
  const end = source.indexOf("/>", start);
  assert.notEqual(end, -1, "could not bound the WebView element");
  return source.slice(start, end);
}

test("browser preview keeps a native Back control outside the WebView", () => {
  assert.match(source, /accessibilityLabel="Back from browser preview"/,
    "browser preview exposes no explicit native Back control");
  const webView = webViewBlock();
  assert.ok(
    !webView.includes('accessibilityLabel="Back from browser preview"'),
    "the browser preview Back control moved inside the WebView",
  );
  const outside = source.replace(webView, "");
  assert.match(outside, /showBrowserEscapeBar[\s\S]*accessibilityLabel="Back from browser preview"/,
    "browser preview Back control is not mounted in the native host overlay");
});

test("browser preview also keeps native reload and stop controls", () => {
  assert.match(source, /accessibilityLabel="Fast reload browser preview"/,
    "browser preview lost its native reload control");
  assert.match(source, /accessibilityLabel="Stop browser preview"/,
    "browser preview lost its native stop control");
});
