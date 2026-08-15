const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// TV builds resolve *.tv.ts(x) first so local Git/LLM adapters are not bundled
// into the remote-only Cloud Studio client. Phone builds keep normal resolution.
if (process.env.EXPO_TV === "1") {
  const sourceExts = config.resolver.sourceExts;
  config.resolver.sourceExts = [
    ...sourceExts.map((extension) => `tv.${extension}`),
    ...sourceExts,
  ];
}

module.exports = config;
