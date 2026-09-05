#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaver-expo-provider-test-'));
try {
  const ios = path.join(root, 'mobile', 'ios');
  const external = path.join(root, 'external', 'mobile', 'ios', 'Pods', 'Target Support Files', 'Pods-Yaver');
  const localPods = path.join(ios, 'Pods');
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(ios, { recursive: true });
  fs.writeFileSync(path.join(external, 'ExpoModulesProvider.swift'), '// generated\n');
  fs.symlinkSync(path.join(root, 'external', 'mobile', 'ios', 'Pods'), localPods);

  const project = path.join(ios, 'Yaver.xcodeproj', 'project.pbxproj');
  fs.mkdirSync(path.dirname(project), { recursive: true });
  fs.writeFileSync(project, `
\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* ExpoModulesProvider.swift in Sources */ = {isa = PBXBuildFile; fileRef = BBBBBBBBBBBBBBBBBBBBBBBB /* ExpoModulesProvider.swift */; };
\t\tCCCCCCCCCCCCCCCCCCCCCCCC /* ExpoModulesProvider.swift in Sources */ = {isa = PBXBuildFile; fileRef = DDDDDDDDDDDDDDDDDDDDDDDD /* ExpoModulesProvider.swift */; };
\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* ExpoModulesProvider.swift */ = {isa = PBXFileReference; path = "Pods/Target Support Files/Pods-Yaver/ExpoModulesProvider.swift"; sourceTree = "<group>"; };
\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* ExpoModulesProvider.swift */ = {isa = PBXFileReference; path = "../../external/mobile/ios/Pods/Target Support Files/Pods-Yaver/ExpoModulesProvider.swift"; sourceTree = "<group>"; };
\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* ExpoModulesProvider.swift */,
\t\t\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* ExpoModulesProvider.swift */,
\t\t\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* ExpoModulesProvider.swift in Sources */,
\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCCC /* ExpoModulesProvider.swift in Sources */,
`);

  const script = path.resolve('scripts/dedupe-expo-modules-provider.mjs');
  const repaired = spawnSync(process.execPath, [script, project], { encoding: 'utf8' });
  assert.equal(repaired.status, 0, repaired.stderr);
  const result = fs.readFileSync(project, 'utf8');
  assert.match(result, /BBBBBBBBBBBBBBBBBBBBBBBB/);
  assert.match(result, /AAAAAAAAAAAAAAAAAAAAAAAA/);
  assert.doesNotMatch(result, /DDDDDDDDDDDDDDDDDDDDDDDD/);
  assert.doesNotMatch(result, /CCCCCCCCCCCCCCCCCCCCCCCC/);

  fs.rmSync(localPods);
  fs.mkdirSync(path.join(localPods, 'Target Support Files', 'Pods-Yaver'), { recursive: true });
  fs.writeFileSync(path.join(localPods, 'Target Support Files', 'Pods-Yaver', 'ExpoModulesProvider.swift'), '// distinct\n');
  fs.writeFileSync(project, `
\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* ExpoModulesProvider.swift in Sources */ = {isa = PBXBuildFile; fileRef = BBBBBBBBBBBBBBBBBBBBBBBB /* ExpoModulesProvider.swift */; };
\t\tCCCCCCCCCCCCCCCCCCCCCCCC /* ExpoModulesProvider.swift in Sources */ = {isa = PBXBuildFile; fileRef = DDDDDDDDDDDDDDDDDDDDDDDD /* ExpoModulesProvider.swift */; };
\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* ExpoModulesProvider.swift */ = {isa = PBXFileReference; path = "Pods/Target Support Files/Pods-Yaver/ExpoModulesProvider.swift"; sourceTree = "<group>"; };
\t\tDDDDDDDDDDDDDDDDDDDDDDDD /* ExpoModulesProvider.swift */ = {isa = PBXFileReference; path = "../../external/mobile/ios/Pods/Target Support Files/Pods-Yaver/ExpoModulesProvider.swift"; sourceTree = "<group>"; };
`);
  const refused = spawnSync(process.execPath, [script, project], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'distinct provider files must be refused');
  assert.match(refused.stderr, /refusing to dedupe distinct/);

  console.log('ExpoModulesProvider dedupe tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
