#!/usr/bin/env node
"use strict";

// expo-share-intent generates the ShareExtension source files during Expo
// prebuild, but mobile/ios is intentionally mostly gitignored. A deploy from a
// fresh or partially restored checkout can therefore contain a valid Xcode
// target whose entire source directory is absent. Re-run the package's own
// deterministic generator instead of asking the operator to prebuild/guess.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appConfig = require(path.join(root, "mobile", "app.json")).expo;
const plugins = Array.isArray(appConfig.plugins) ? appConfig.plugins : [];
const entry = plugins.find(
  (plugin) =>
    plugin === "expo-share-intent" ||
    (Array.isArray(plugin) && plugin[0] === "expo-share-intent"),
);

if (!entry) {
  throw new Error("restore-ios-share-extension: expo-share-intent is not configured in mobile/app.json");
}

const parameters = Array.isArray(entry) && entry[1] ? entry[1] : {};
const scheme = appConfig.scheme;
const bundleIdentifier = appConfig.ios && appConfig.ios.bundleIdentifier;
const appName = appConfig.name;
if (!scheme || !bundleIdentifier || !appName) {
  throw new Error("restore-ios-share-extension: mobile/app.json is missing name, scheme, or ios.bundleIdentifier");
}

const platformRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "mobile", "ios");
const generator = require(path.join(
  root,
  "mobile",
  "node_modules",
  "expo-share-intent",
  "plugin",
  "build",
  "ios",
  "writeIosShareExtensionFiles.js",
));

const expected = [
  "ShareExtension-Info.plist",
  "ShareExtension.entitlements",
  "PrivacyInfo.xcprivacy",
  "MainInterface.storyboard",
  "ShareViewController.swift",
  "ShareExtensionPreprocessor.js",
];

async function main() {
  await generator.writeShareExtensionFiles(
    platformRoot,
    scheme,
    bundleIdentifier,
    parameters,
    appName,
  );

  const extensionDir = path.join(platformRoot, "ShareExtension");
  for (const file of expected) {
    const absolute = path.join(extensionDir, file);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
      throw new Error(`restore-ios-share-extension: generator did not create ${absolute}`);
    }
  }
  console.log(`Share Extension sources ready: ${extensionDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
