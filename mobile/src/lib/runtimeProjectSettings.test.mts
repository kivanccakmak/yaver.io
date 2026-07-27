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
  gitRemote: "https://github.com/yaver/yaver.io.git",
  branch: "main",
  framework: "expo",
};

const web: RuntimeProjectSeed = {
  projectName: "yaver / web",
  repoName: "yaver.io",
  gitProvider: "github",
  gitRemote: "https://github.com/yaver/yaver.io.git",
  branch: "main",
  framework: "nextjs",
};

const other: RuntimeProjectSeed = {
  projectName: "infra",
  repoName: "infra",
  gitProvider: "github",
  gitRemote: "https://github.com/yaver/infra.git",
  branch: "main",
};

const pref = runtimeProjectPreferenceFor("box-1", mobile);

assert.equal(pref.deviceId, "box-1");
assert.equal(pref.projectName, "yaver / mobile");
assert.equal(pref.gitRemote, "https://github.com/yaver/yaver.io.git");

assert.ok(runtimeProjectIdentityScore(mobile, pref) > runtimeProjectIdentityScore(other, pref));
assert.equal(resolveRuntimeProjectPreference([other, mobile], pref), mobile);

const frameworkSpecific = runtimeProjectPreferenceFor("box-1", {
  ...mobile,
  projectName: "renamed locally",
});
assert.equal(resolveRuntimeProjectPreference([web, mobile], frameworkSpecific), mobile);

const catalogs = runtimeProjectCatalogMap([
  { deviceId: "box-1", projects: [mobile] },
  { deviceId: "box-2", projects: [other] },
]);
assert.equal(catalogs["box-1"].projects[0].projectName, "yaver / mobile");
assert.equal(catalogs["box-2"].projects[0].repoName, "infra");

const defaults = runtimeProjectDefaultMap([pref]);
assert.equal(defaults["box-1"].repoName, "yaver.io");

console.log("runtime project settings checks passed");

