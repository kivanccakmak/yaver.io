#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const projectPath = path.resolve(process.argv[2] || 'mobile/ios/Yaver.xcodeproj/project.pbxproj');
const projectDir = path.dirname(path.dirname(projectPath));
let source = fs.readFileSync(projectPath, 'utf8');

const refPattern = /^\s*([A-F0-9]{24}) \/\* ExpoModulesProvider\.swift \*\/ = \{[^\n]*?path = ("(?:[^"\\]|\\.)*"|[^;]+);[^\n]*$/gm;
const refs = [];
for (const match of source.matchAll(refPattern)) {
  const rawPath = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].trim();
  const absolutePath = path.resolve(projectDir, rawPath);
  let realPath = '';
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    realPath = '';
  }
  refs.push({ id: match[1], rawPath, absolutePath, realPath });
}

if (refs.length <= 1) process.exit(0);

if (refs.some((ref) => !ref.realPath)) {
  const missing = refs.filter((ref) => !ref.realPath).map((ref) => ref.absolutePath).join('\n  ');
  throw new Error(`refusing to dedupe missing ExpoModulesProvider paths:\n  ${missing}`);
}
const physicalPaths = new Set(refs.map((ref) => ref.realPath));
if (physicalPaths.size !== 1) {
  throw new Error(`refusing to dedupe distinct ExpoModulesProvider files:\n  ${[...physicalPaths].join('\n  ')}`);
}

// Prefer the shortest project-relative reference. With an external Pods
// symlink this preserves the stable `Pods/Target Support Files/...` entry and
// removes CocoaPods' newly-added ../../Volumes/... alias of the same file.
const keep = [...refs].sort((a, b) => a.rawPath.length - b.rawPath.length || a.rawPath.localeCompare(b.rawPath))[0];
const removedRefIDs = new Set(refs.filter((ref) => ref.id !== keep.id).map((ref) => ref.id));
const removedBuildIDs = new Set();
const buildPattern = /^\s*([A-F0-9]{24}) \/\* ExpoModulesProvider\.swift in Sources \*\/ = \{[^\n]*?fileRef = ([A-F0-9]{24}) /gm;
for (const match of source.matchAll(buildPattern)) {
  if (removedRefIDs.has(match[2])) removedBuildIDs.add(match[1]);
}

if (removedBuildIDs.size !== removedRefIDs.size) {
  throw new Error('refusing to dedupe ExpoModulesProvider: file/build reference counts disagree');
}

const removedIDs = new Set([...removedRefIDs, ...removedBuildIDs]);
source = source
  .split('\n')
  .filter((line) => ![...removedIDs].some((id) => line.includes(id)))
  .join('\n');
fs.writeFileSync(projectPath, source);
console.log(`Removed ${removedRefIDs.size} duplicate ExpoModulesProvider reference(s); kept ${keep.rawPath}`);
