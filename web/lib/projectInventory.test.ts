import assert from "node:assert/strict";

import { mergeProjectInventory } from "./projectInventory";

const accountHome = "/account-home";
const workspace = `${accountHome}/workspace`;
const projects = [
  {
    name: "sfmg",
    path: `${workspace}/sfmg`,
    framework: "expo",
    gitRemote: "https://example.test/sfmg.git",
  },
  {
    name: "yaver.io",
    path: `${workspace}/yaver.io`,
    framework: "monorepo",
    gitRemote: "https://example.test/yaver.io.git",
  },
];

// Regression: an accidental $HOME/.git made /repos/list return HOME. The
// desktop/web merge then treated HOME as the outermost project and collapsed
// every real checkout below it, leaving the Projects screen at
// one broad unknown row while mobile and the device card still found everything.
{
  const got = mergeProjectInventory(projects, [
    { name: "account-home", path: accountHome, stack: {} },
    { name: "yaver.io", path: `${workspace}/yaver.io`, stack: { type: "monorepo" } },
  ]);
  assert.deepEqual(
    got.map((project) => project.path).sort(),
    [`${workspace}/sfmg`, `${workspace}/yaver.io`],
    "a supplemental ancestor must not erase canonical discovered projects",
  );
}

// A browser can control a Windows remote box, so path semantics come from the
// remote path shape—not from the browser host operating system.
{
  const drive = "D:\\work";
  const got = mergeProjectInventory(
    [{ name: "app", path: `${drive}\\app` }],
    [{ name: "work", path: drive.toLowerCase(), stack: {} }],
  );
  assert.deepEqual(got.map((project) => project.name), ["app"]);
}

// /repos/list remains useful when it contributes a genuine sibling repo that
// the heavier discovery endpoint has not returned yet.
{
  const got = mergeProjectInventory(projects, [
    { name: "api", path: `${workspace}/api`, stack: { type: "backend", frameworks: ["go"] } },
  ]);
  assert.deepEqual(
    got.map((project) => project.path).sort(),
    [`${workspace}/api`, `${workspace}/sfmg`, `${workspace}/yaver.io`],
  );
}

console.log("web project inventory merge checks passed");
