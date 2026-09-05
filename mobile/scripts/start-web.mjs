#!/usr/bin/env node

// Expo/Metro canonicalizes packages that live behind a node_modules symlink.
// Lazy web chunks then receive filesystem-derived URLs such as
// /Volumes/.../async-storage/index.bundle, which browsers normalize and Metro
// cannot serve. Keep the logical package path and emit one complete entry
// bundle so mounted dependency volumes work on every browser lane.
process.env.EXPO_NO_METRO_LAZY = "1";
process.argv.splice(2, 0, "start", "--web");
await import("../node_modules/expo/bin/cli");
