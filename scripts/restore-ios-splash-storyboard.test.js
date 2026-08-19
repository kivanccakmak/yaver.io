#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "restore-ios-splash-storyboard.js");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yaver-ios-splash-test-"));
const fixture = path.join(fixtureRoot, "SplashScreen.storyboard");
const podfile = path.join(fixtureRoot, "Podfile");
const properties = path.join(fixtureRoot, "Podfile.properties.json");
const appConfig = path.join(fixtureRoot, "app.json");
const contaminated = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder.AppleTV.Storyboard" version="3.0" targetRuntime="AppleTV">
  <device id="retina6_12" orientation="portrait"/>
  <dependencies><deployment identifier="tvOS"/></dependencies>
</document>
`;

fs.writeFileSync(fixture, contaminated);
fs.writeFileSync(podfile, "platform :tvos, '15.5'\ntarget 'Yaver' do\nend\n");
fs.writeFileSync(properties, '{"newArchEnabled":"false","expo.jsEngine":"hermes"}\n');
fs.writeFileSync(appConfig, JSON.stringify({
  expo: {
    newArchEnabled: true,
    plugins: [["expo-build-properties", { ios: { deploymentTarget: "15.5" } }]],
  },
}) + "\n");
const args = [script, fixture, podfile, properties, appConfig];
childProcess.execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });

const repaired = fs.readFileSync(fixture, "utf8");
assert.match(repaired, /type="com\.apple\.InterfaceBuilder3\.CocoaTouch\.Storyboard\.XIB"/);
assert.match(repaired, /targetRuntime="iOS\.CocoaTouch"/);
assert.match(repaired, /<deployment identifier="iOS"\/>/);
assert.doesNotMatch(repaired, /AppleTV|tvOS/);
assert.match(fs.readFileSync(podfile, "utf8"), /^platform :ios, '15\.5'$/m);
assert.strictEqual(JSON.parse(fs.readFileSync(properties, "utf8")).newArchEnabled, "true");
assert.strictEqual(JSON.parse(fs.readFileSync(properties, "utf8"))["ios.deploymentTarget"], "15.5");

// The repair is idempotent and must not churn a valid generated file.
childProcess.execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
assert.strictEqual(fs.readFileSync(fixture, "utf8"), repaired);

fs.writeFileSync(fixture, repaired.replace('targetRuntime="iOS.CocoaTouch"', 'targetRuntime="Unknown"'));
assert.throws(
  () => childProcess.execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" }),
  /status 1|Command failed/,
);

console.log("restore-ios-splash-storyboard tests passed");
