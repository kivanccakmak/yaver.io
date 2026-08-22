import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(join(here, relative), "utf8");

test("machine pairing is QR-first and manual entry stays secondary", () => {
  const more = source("../../app/(tabs)/more.tsx");
  const modal = more.slice(more.indexOf("{/* Pair device modal */}"));

  assert.match(modal, />yaver auth pair</);
  assert.match(modal, /testID="pair-scan-qr"/);
  assert.match(modal, /testID="pair-manual-toggle"/);
  assert.ok(
    modal.indexOf('testID="pair-scan-qr"') < modal.indexOf('testID="pair-manual-toggle"'),
    "QR scan must remain the first pairing action",
  );
  assert.match(more, /const \[pairManualOpen, setPairManualOpen\] = useState\(false\)/);
});

test("manual pairing remains usable while the software keyboard is open", () => {
  const more = source("../../app/(tabs)/more.tsx");
  const modal = more.slice(more.indexOf("{/* Pair device modal */}"));

  assert.match(modal, /<KeyboardAvoidingView/);
  assert.match(modal, /keyboardShouldPersistTaps="handled"/);
  assert.match(modal, /keyboardDismissMode="interactive"/);
  assert.match(modal, /automaticallyAdjustKeyboardInsets/);
  assert.match(modal, /testID="pair-manual-confirm"/);
});

test("scanning validates a Yaver pair URL but never authorizes by itself", () => {
  const scanner = source("../components/PairQrScanner.tsx");
  assert.match(scanner, /parsePairUrl\(raw\)/);
  assert.match(scanner, /onScanned\(raw\)/);
  assert.doesNotMatch(scanner, /submitPair|auth\/pair\/submit/);
});

test("new-user onboarding also offers QR before passive discovery", () => {
  const onboarding = source("../../app/onboarding-pair.tsx");
  const scan = onboarding.indexOf('testID="onboarding-scan-machine-qr"');
  const discovery = onboarding.indexOf("{/* Live discovery */}");
  assert.ok(scan >= 0 && discovery >= 0 && scan < discovery);
  assert.match(onboarding, /pathname: "\/approve-device", params: \{ scan: "1" \}/);
});

test("short pairing codes use one real input behind segmented character boxes", () => {
  const segmented = source("../components/SegmentedCodeInput.tsx");
  assert.match(segmented, /Array\.from\(\{ length \}/);
  assert.equal((segmented.match(/^\s*<TextInput/gm) || []).length, 1, "segmented boxes must not become separate focusable inputs");
  assert.match(segmented, /textContentType="oneTimeCode"/);
  assert.match(segmented, /autoComplete="one-time-code"/);

  assert.match(source("../../app/(tabs)/more.tsx"), /testID="pair-segmented-code"/);
  assert.match(source("../../app/approve-device.tsx"), /testID="device-approval-segmented-code"/);

  const web = source("../../../web/app/auth/device/DeviceCodeClient.tsx");
  const manualForm = web.slice(web.indexOf("<form onSubmit={handleSubmit}>"));
  assert.match(manualForm, /Array\.from\(\{ length: 8 \}/);
  assert.match(manualForm, /autoComplete="one-time-code"/);
});
