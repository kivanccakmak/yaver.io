import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(join(here, relative), "utf8");

test("every TV account screen exposes the same two choices", () => {
  const screens = [
    source("../../app/tv-signin.tsx"),
    source("../../../tvos/YaverTV/Views/SignInView.swift"),
    source("../../../androidtv/app/src/main/kotlin/io/yaver/tv/ui/SignInScreen.kt"),
  ];
  for (const screen of screens) {
    assert.match(screen, /Email.{0,20}password/is);
    assert.match(screen, /Scan.{0,40}(Yaver app|QR|phone)/is);
    assert.doesNotMatch(screen, /Sign in with (Apple|Google|Microsoft|GitHub|GitLab)/i);
  }
});

test("tvOS cannot silently re-expose dormant native provider implementations", () => {
  assert.equal(existsSync(join(here, "../../../tvos/YaverTV/AppleSignIn.swift")), false);
  assert.equal(existsSync(join(here, "../../../tvos/YaverTV/OAuthSignIn.swift")), false);
});

test("Scan TV QR is the first mobile Settings section", () => {
  const settings = source("../../app/(tabs)/settings.tsx");
  const scanner = settings.indexOf("Scan TV QR");
  const nextSection = settings.indexOf("Machine + voice controls");
  assert.ok(scanner >= 0 && nextSection >= 0 && scanner < nextSection);
  assert.match(settings, /params: \{ scan: "1" \}/);
});
