// React Native injects this at bundle time. The headless surrogate imports the
// same mobile library source, so its typecheck needs the matching compile-time
// contract even though Bun never reads the value on native-only branches.
declare const __DEV__: boolean;
