#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yaver-share-extension-test-"));
const script = path.join(root, "scripts", "restore-ios-share-extension.js");

childProcess.execFileSync(process.execPath, [script, fixtureRoot], {
  cwd: root,
  stdio: "pipe",
});

const extensionDir = path.join(fixtureRoot, "ShareExtension");
const expected = [
  "ShareExtension-Info.plist",
  "ShareExtension.entitlements",
  "PrivacyInfo.xcprivacy",
  "MainInterface.storyboard",
  "ShareViewController.swift",
  "ShareExtensionPreprocessor.js",
];
for (const file of expected) {
  assert.ok(fs.statSync(path.join(extensionDir, file)).size > 0, `${file} was not generated`);
}

const entitlements = fs.readFileSync(
  path.join(extensionDir, "ShareExtension.entitlements"),
  "utf8",
);
assert.match(entitlements, /group\.io\.yaver\.mobile/);
const controller = fs.readFileSync(
  path.join(extensionDir, "ShareViewController.swift"),
  "utf8",
);
assert.doesNotMatch(controller, /<SCHEME>|<GROUPIDENTIFIER>/);
assert.match(controller, /group\.io\.yaver\.mobile/);

console.log("restore-ios-share-extension tests passed");
