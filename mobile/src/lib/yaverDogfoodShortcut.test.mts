import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("Yaver long-press Dogfood shortcut reaches the same route on iOS and Android", () => {
  const appConfig = read("../../app.json");
  const infoPlist = read("../../ios/Yaver/Info.plist");
  const appDelegate = read("../../ios/Yaver/AppDelegate.swift");
  const mainActivity = read("../../android/app/src/main/java/io/yaver/mobile/MainActivity.kt");

  for (const nativeSource of [appConfig, infoPlist, appDelegate, mainActivity]) {
    assert.match(nativeSource, /io\.yaver\.mobile\.dogfood/);
  }
  assert.match(appDelegate, /yaver:\/\/dogfood/);
  assert.match(mainActivity, /yaver:\/\/dogfood/);
  assert.match(mainActivity, /addDynamicShortcuts/);
});
