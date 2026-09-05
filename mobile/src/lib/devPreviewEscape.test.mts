import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "src/components/DevPreview.tsx"), "utf8");

test("browser preview keeps one native Y escape outside the WebView", () => {
  assert.match(source, /!mustUseNativePreview \? \([\s\S]*<BrowserVibeBubble/,
    "browser preview lost its native Dogfood entry affordance");
  assert.match(source, /onExitPreview=\{\(\) => setShowPreview\(false\)\}/,
    "the Y affordance must always have a working native exit route");
  assert.doesNotMatch(source, /showBrowserEscapeBar/,
    "legacy browser chrome would obscure the app being dogfooded");
});
