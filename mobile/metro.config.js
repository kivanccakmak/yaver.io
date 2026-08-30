// Metro config for the Yaver mobile app.
//
// The only customization: register `.bin` as a bundled asset extension so
// the on-device whisper STT model (assets/models/ggml-whisper-tiny.bin)
// can be loaded via `require()` and embedded into the app binary by Expo.
// Without this, metro treats `.bin` as source and the model never ships —
// whisper.rn then fails with "Failed to load the model" (the on-device
// voice path the Tasks tab mic relies on).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
const mobileNodeModules = path.resolve(__dirname, "node_modules");

// Yaver mobile is the first real consumer of the published Dogfood runtime in
// sdk/feedback/react-native. Watch only that SDK package (not the monorepo root)
// so Metro can compile the exact source third-party apps receive without
// pulling unrelated workspaces into module discovery.
config.watchFolders = [
  ...(config.watchFolders || []),
  path.resolve(__dirname, "../sdk/feedback/react-native"),
];

// Files under the sibling SDK are outside `mobile/`, so Metro's normal
// hierarchical lookup starts beside that file. CI intentionally installs only
// mobile/node_modules; without this explicit workspace root, React/React Native
// resolve locally only when an unrelated sdk/node_modules happens to exist.
// That false green reached Xcode's expo-updates asset phase before failing.
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths || []),
  mobileNodeModules,
];

// The sibling SDK imports React hooks. When Metro resolves those files from
// outside `mobile/`, hierarchical lookup can produce a second React instance
// or a missing dispatcher on device, which surfaces as "Cannot read property
// 'use' of null" when Dogfood launches. Pin the core React entrypoints to the
// app workspace so the SDK and host share one runtime.
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  react: path.join(mobileNodeModules, "react"),
  "react/jsx-runtime": path.join(mobileNodeModules, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.join(mobileNodeModules, "react/jsx-dev-runtime"),
  "react-native": path.join(mobileNodeModules, "react-native"),
};

if (!config.resolver.assetExts.includes("bin")) {
  config.resolver.assetExts.push("bin");
}

module.exports = config;
