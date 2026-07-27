import assert from "node:assert/strict";
import {
  resolveRuntimeProjectPreference,
  runtimeProjectCatalogMap,
  runtimeProjectDefaultMap,
  runtimeProjectIdentityScore,
  runtimeProjectPreferenceFor,
  type RuntimeProjectSeed,
} from "./runtimeProjectSettings";

const mobile: RuntimeProjectSeed = {
  projectName: "yaver / mobile",
  repoName: "yaver.io",
  gitProvider: "github",
  gitRemote: "https://github.com/yaver-io/yaver.io.git",
  branch: "main",
  framework: "expo",
};

const web: RuntimeProjectSeed = {
  projectName: "yaver / web",
  repoName: "yaver.io",
  gitProvider: "github",
  gitRemote: "https://github.com/yaver-io/yaver.io.git",
  branch: "main",
  framework: "nextjs",
};

const pref = runtimeProjectPreferenceFor("box-1", mobile);

assert.equal(pref.deviceId, "box-1");
assert.equal(pref.projectName, "yaver / mobile");
assert.ok(runtimeProjectIdentityScore(mobile, pref) > 0);
assert.equal(resolveRuntimeProjectPreference([web, mobile], pref), mobile);

const catalogs = runtimeProjectCatalogMap([{ deviceId: "box-1", projects: [mobile, web] }]);
assert.equal(catalogs["box-1"].projects.length, 2);

const defaults = runtimeProjectDefaultMap([pref]);
assert.equal(defaults["box-1"].framework, "expo");

console.log("web runtime project settings checks passed");

