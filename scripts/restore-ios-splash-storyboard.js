#!/usr/bin/env node
"use strict";

// Expo owns the mostly-gitignored mobile/ios tree, but the existing native
// project is what TestFlight archives. A launch storyboard can therefore
// survive locally with internally inconsistent platform metadata. Xcode then
// reports the deeply misleading:
//
//   tvOS storyboards do not support target device type "iphone"
//
// Normalize the one known, deterministic corruption before building. Do not
// guess at unfamiliar storyboard formats: a future mismatch must fail with the
// exact file and fields instead of silently rewriting arbitrary XML.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const storyboard = path.resolve(
  process.argv[2] || path.join(root, "mobile", "ios", "Yaver", "SplashScreen.storyboard"),
);
const podfile = path.resolve(
  process.argv[3] || path.join(root, "mobile", "ios", "Podfile"),
);
const podfileProperties = path.resolve(
  process.argv[4] || path.join(path.dirname(podfile), "Podfile.properties.json"),
);
const appConfig = path.resolve(
  process.argv[5] || path.join(root, "mobile", "app.json"),
);

if (!fs.existsSync(storyboard)) {
  throw new Error(
    `restore-ios-splash-storyboard: missing ${storyboard}; run Expo's iOS prebuild first`,
  );
}
if (!fs.existsSync(podfile)) {
  throw new Error(
    `restore-ios-splash-storyboard: missing ${podfile}; run Expo's iOS prebuild first`,
  );
}
for (const required of [podfileProperties, appConfig]) {
  if (!fs.existsSync(required)) {
    throw new Error(`restore-ios-splash-storyboard: missing ${required}`);
  }
}

const iosType = "com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB";
const iosRuntime = "iOS.CocoaTouch";
const before = fs.readFileSync(storyboard, "utf8");

const type = before.match(/<document\b[^>]*\btype="([^"]+)"/)?.[1] || "";
const runtime = before.match(/<document\b[^>]*\btargetRuntime="([^"]+)"/)?.[1] || "";
const deployment = before.match(/<deployment\s+identifier="([^"]+)"\s*\/>/)?.[1] || "";

const alreadyIOS = type === iosType && runtime === iosRuntime && deployment === "iOS";
const knownTVContamination =
  type === "com.apple.InterfaceBuilder.AppleTV.Storyboard" &&
  runtime === "AppleTV" &&
  deployment === "tvOS";

if (!alreadyIOS && !knownTVContamination) {
  throw new Error(
    "restore-ios-splash-storyboard: refusing unfamiliar platform metadata in " +
      `${storyboard} (type=${JSON.stringify(type)}, runtime=${JSON.stringify(runtime)}, ` +
      `deployment=${JSON.stringify(deployment)})`,
  );
}

if (knownTVContamination) {
  const after = before
    .replace('type="com.apple.InterfaceBuilder.AppleTV.Storyboard"', `type="${iosType}"`)
    .replace('targetRuntime="AppleTV"', `targetRuntime="${iosRuntime}"`)
    .replace('<deployment identifier="tvOS"/>', '<deployment identifier="iOS"/>');
  fs.writeFileSync(storyboard, after);
  console.log(`Restored iOS launch storyboard metadata: ${storyboard}`);
} else {
  console.log(`iOS launch storyboard metadata already valid: ${storyboard}`);
}

// Podfile.properties.json is generated state; mobile/app.json is the checked-in
// source of truth. A stale `newArchEnabled=false` makes current Reanimated
// reject the Podfile before CocoaPods can regenerate anything.
const app = JSON.parse(fs.readFileSync(appConfig, "utf8"));
const properties = JSON.parse(fs.readFileSync(podfileProperties, "utf8"));
const desiredNewArch = app?.expo?.newArchEnabled === true ? "true" : "false";
const buildProperties = (app?.expo?.plugins || []).find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties",
);
const desiredDeploymentTarget = String(buildProperties?.[1]?.ios?.deploymentTarget || "").trim();
if (!/^\d+\.\d+$/.test(desiredDeploymentTarget)) {
  throw new Error(
    `restore-ios-splash-storyboard: mobile app config has no valid expo-build-properties iOS deploymentTarget`,
  );
}
let propertiesChanged = false;
if (properties.newArchEnabled !== desiredNewArch) {
  properties.newArchEnabled = desiredNewArch;
  propertiesChanged = true;
  console.log(
    `Reconciled iOS newArchEnabled=${desiredNewArch} from ${appConfig}: ${podfileProperties}`,
  );
} else {
  console.log(`iOS newArchEnabled already matches app config: ${podfileProperties}`);
}
if (properties["ios.deploymentTarget"] !== desiredDeploymentTarget) {
  properties["ios.deploymentTarget"] = desiredDeploymentTarget;
  propertiesChanged = true;
  console.log(
    `Reconciled iOS deploymentTarget=${desiredDeploymentTarget} from ${appConfig}: ${podfileProperties}`,
  );
} else {
  console.log(`iOS deploymentTarget already matches app config: ${podfileProperties}`);
}
if (propertiesChanged) {
  fs.writeFileSync(podfileProperties, `${JSON.stringify(properties, null, 2)}\n`);
}

// The same contamination can reach Expo's generated Podfile. When it does,
// CocoaPods happily creates a tvOS-only Pods project; the iPhone workspace then
// skips every Pod target and fails later with "no such module Expo". Repair
// only the exact platform declaration and let `pod install` regenerate the
// project from the lockfile.
const podfileBefore = fs.readFileSync(podfile, "utf8");
const podPlatform = podfileBefore.match(/^platform\s+:(\w+)\s*,/m)?.[1] || "";
if (podPlatform === "tvos") {
  fs.writeFileSync(podfile, podfileBefore.replace(/^platform\s+:tvos\s*,/m, "platform :ios,"));
  console.log(`Restored iOS CocoaPods platform metadata: ${podfile}`);
} else if (podPlatform === "ios") {
  console.log(`iOS CocoaPods platform metadata already valid: ${podfile}`);
} else {
  throw new Error(
    `restore-ios-splash-storyboard: refusing unfamiliar platform ${JSON.stringify(podPlatform)} in ${podfile}`,
  );
}
