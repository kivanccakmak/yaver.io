// Bundled host manifest. Loaded via require so Metro inlines it at
// build time — guarantees the JS side reports exactly what the iOS /
// Android binary linked, without a native bridge hop. Source of truth
// is mobile/sdk-manifest.json (TestSDKManifestInSync gates drift).
import sdkManifestJSON from "../../sdk-manifest.json";

export type NativeBuildConsumerContract = {
  consumerVersion?: string;
  consumerBuild?: string;
  consumerSdkVersion?: string;
  consumerHermesBCVersion?: number;
  consumerCurrentRuntimeFamilyId?: string;
  consumerDefaultRuntimeFamilyId?: string;
  consumerRuntimeFamilies?: Array<Record<string, unknown>>;
};

// hostNativeModulesFromBundledManifest extracts the {name: version}
// map from the bundled sdk-manifest.json. Used as the dynamic
// handshake payload (consumerNativeModules) so the agent's compat
// check sees what THIS host actually links — not a stale agent copy.
export function hostNativeModulesFromBundledManifest(): Record<string, string> {
  const m = (sdkManifestJSON as { nativeModules?: Record<string, string> })?.nativeModules;
  return m && typeof m === "object" ? m : {};
}

export function buildNativeBuildRequest(
  platform: "ios" | "android",
  contract?: NativeBuildConsumerContract,
  // `project` pins the request to a specific guest project so the agent
  // never falls back to whatever dev server happens to be running. The
  // agent (≥ 1.99.187) returns 400 PROJECT_REQUIRED when none of these
  // are set; older agents continue to honour the legacy fallback.
  project?: { projectPath?: string; projectName?: string; bundleId?: string },
) {
  const nativeModules = hostNativeModulesFromBundledManifest();
  return {
    platform,
    ...(project?.projectPath ? { projectPath: project.projectPath } : {}),
    ...(project?.projectName ? { projectName: project.projectName } : {}),
    ...(project?.bundleId ? { bundleId: project.bundleId } : {}),
    ...(contract?.consumerVersion ? { consumerVersion: contract.consumerVersion } : {}),
    ...(contract?.consumerBuild ? { consumerBuild: contract.consumerBuild } : {}),
    ...(contract?.consumerSdkVersion ? { consumerSdkVersion: contract.consumerSdkVersion } : {}),
    ...(typeof contract?.consumerHermesBCVersion === "number" && contract.consumerHermesBCVersion > 0
      ? { consumerHermesBCVersion: contract.consumerHermesBCVersion }
      : {}),
    ...(contract?.consumerCurrentRuntimeFamilyId ? { consumerCurrentRuntimeFamilyId: contract.consumerCurrentRuntimeFamilyId } : {}),
    ...(contract?.consumerDefaultRuntimeFamilyId ? { consumerDefaultRuntimeFamilyId: contract.consumerDefaultRuntimeFamilyId } : {}),
    ...(Array.isArray(contract?.consumerRuntimeFamilies) && contract.consumerRuntimeFamilies.length > 0
      ? { consumerRuntimeFamilies: contract.consumerRuntimeFamilies }
      : {}),
    ...(Object.keys(nativeModules).length > 0
      ? { consumerNativeModules: nativeModules }
      : {}),
  };
}

export function nativeBuildFailureMessage(buildResult: any): string {
  const lines = [
    buildResult?.phase ? `phase: ${buildResult.phase}` : null,
    compatibilitySummary(buildResult) || buildResult?.error || "Build failed",
    runtimeFamilySummary(buildResult),
    compatibilityDetails(buildResult),
    buildResult?.helpHint || null,
  ].filter(Boolean);
  // /dev/build-native returns the last 120 lines of subprocess stderr+stdout
  // in `output` on HTTP-error responses (devserver_http.go:2789). Surface a
  // tail so the user sees the actual failure (npm error, missing dep, expo
  // CLI quirk, etc.) instead of just "Build failed".
  if (typeof buildResult?.output === "string" && buildResult.output.trim()) {
    const tail = buildResult.output.split("\n").filter((l: string) => l.trim()).slice(-25).join("\n");
    if (tail) {
      lines.push("---");
      lines.push(tail);
    }
  }
  return lines.join("\n");
}

/**
 * The extra sentence to append under the agent's own error, or "" for none.
 *
 * ── Why this is a pure function in a testable file ─────────────────────────
 *
 * It used to be an if/else chain inline in apps.tsx, keyed off SUBSTRINGS of
 * the agent's prose. One of its tests was `lower.includes("hermes")` — in a
 * product whose bundle format IS Hermes, so every message in the subsystem
 * matches it and the branch could not fail to fire.
 *
 * Measured on a real phone, TestFlight build 500, 2026-08-03: the agent
 * refused a Yaver-in-Yaver build with "refusing to build a Hermes bundle of
 * Yaver for the Yaver container… Use the browser/WebRTC preview instead" — a
 * deliberate, correct guard. The substring matched, and the phone appended
 * "Hermes bytecode version mismatch between the guest app and the selected
 * Yaver host family." The user was shown two causes that cannot both be true:
 * the build was REFUSED, so there is no bundle whose bytecode could mismatch.
 *
 * The agent had already sent `code` on that response and it was ignored in
 * favour of a regex over the sentence — the "signal with no consumer" failure,
 * and exactly why CLAUDE.md says a bare error string "forces every surface to
 * invent a regex, and the regexes drift".
 *
 * So: CODES FIRST, always. The remaining substring tests are last-resort and
 * only for shapes the agent has no code for; each is narrow enough that it
 * cannot match a message about something else.
 */
export function buildFailureHint(buildResult: any, rawMessage: string): string {
  const code = buildResult?.code;
  const lower = (rawMessage || "").toLowerCase();

  // A refusal is complete on its own. Anything appended contradicts it.
  if (code === "YAVER_SELF_DEVELOPMENT_RECURSION") return "";

  if (code === "RUNTIME_FAMILY_MISMATCH" || code === "FRAMEWORK_VERSION_MISMATCH") {
    return "\n\nYaver picked the nearest supported runtime family, but the project app still does not match it exactly. "
      + "Align the project app to one of Yaver's supported families or switch to a native build fallback.";
  }
  if (code === "BC_VERSION_MISMATCH") {
    return "\n\nHermes bytecode version mismatch between the project app and the selected Yaver host family. "
      + "Align the project runtime to a supported family and retry.";
  }
  if (lower.includes("did not become ready") || lower.includes("dev server")) {
    return "\n\nMetro didn't start on the dev machine. Check Node.js is installed and the project has a valid package.json.";
  }
  if (lower.includes("yaverbundleloader")) {
    return "\n\nYaver's native bundle loader is missing from this build — update Yaver to the latest version, "
      + "or run the app directly on the dev machine.";
  }
  return "";
}

export function nativeBuildFailureTitle(buildResult: any): string {
  // NOT a failure. Yaver declining to load Yaver into Yaver is the guard
  // working exactly as designed, and titling it "Load Failed" tells the user
  // something broke when nothing did.
  if (buildResult?.code === "YAVER_SELF_DEVELOPMENT_RECURSION") return "Preview Yaver a Different Way";
  if (buildResult?.code === "NATIVE_MODULE_INCOMPATIBLE") return "Some Features Unavailable";
  if (buildResult?.code === "NATIVE_MODULE_VERSION_MISMATCH") return "Compatibility Blocked";
  if (buildResult?.code === "REACT_VERSION_MISMATCH") return "Compatibility Blocked";
  if (buildResult?.code === "FRAMEWORK_VERSION_MISMATCH") return "Compatibility Blocked";
  if (buildResult?.code === "RUNTIME_FAMILY_MISMATCH") return "Compatibility Blocked";
  if (buildResult?.code === "BC_VERSION_MISMATCH") return "Hermes Version Mismatch";
  return "Load Failed";
}

function compatibilitySummary(buildResult: any): string | null {
  if (buildResult?.code === "NATIVE_MODULE_INCOMPATIBLE") {
    // Missing modules are warning-only as of 2026-07-20 (agent gate + doctor):
    // a module absent from the host throws only if the app calls it unguarded, so
    // a guarded require() loads fine. This code only reaches a phone talking to an
    // OLDER agent; keep the copy honest either way — it may be unavailable, not
    // "would crash".
    return "Some native modules this project declares are not in Yaver's mobile host. The app still loads; those features may be unavailable if it calls them.";
  }
  if (buildResult?.code === "NATIVE_MODULE_VERSION_MISMATCH") {
    return "Yaver blocked restart because the project's native runtime contract does not match the mobile host.";
  }
  if (buildResult?.code === "REACT_VERSION_MISMATCH") {
    return "Yaver blocked restart because the project's React runtime does not match the mobile host.";
  }
  if (buildResult?.code === "FRAMEWORK_VERSION_MISMATCH") {
    return "Yaver blocked restart because the project app does not match the selected mobile host runtime family.";
  }
  if (buildResult?.code === "RUNTIME_FAMILY_MISMATCH") {
    return "Yaver blocked restart because the project app does not match the selected mobile host runtime family.";
  }
  if (buildResult?.code === "BC_VERSION_MISMATCH") {
    return buildResult?.error || "Hermes bytecode version mismatch.";
  }
  return null;
}

function compatibilityDetails(buildResult: any): string | null {
  if (Array.isArray(buildResult?.incompatibleNativeModules) && buildResult.incompatibleNativeModules.length > 0) {
    return `Missing in Yaver: ${buildResult.incompatibleNativeModules.join(", ")}`;
  }
  if (Array.isArray(buildResult?.nativeModuleVersionMismatches) && buildResult.nativeModuleVersionMismatches.length > 0) {
    return buildResult.nativeModuleVersionMismatches
      .map((item: any) => `${item.name}: project ${item.projectVersion} vs host ${item.hostVersion}`)
      .join("\n");
  }
  if (buildResult?.reactVersionMismatch) {
    return `React: project ${buildResult.reactVersionMismatch.projectVersion} vs host ${buildResult.reactVersionMismatch.hostVersion}`;
  }
  if (buildResult?.reactNativeVersionMismatch || buildResult?.expoVersionMismatch) {
    return [
      buildResult?.reactNativeVersionMismatch
        ? `React Native: project ${buildResult.reactNativeVersionMismatch.projectVersion} vs host ${buildResult.reactNativeVersionMismatch.hostVersion}`
        : null,
      buildResult?.reactVersionMismatch
        ? `React: project ${buildResult.reactVersionMismatch.projectVersion} vs host ${buildResult.reactVersionMismatch.hostVersion}`
        : null,
      buildResult?.expoVersionMismatch
        ? `Expo: project ${buildResult.expoVersionMismatch.projectVersion} vs host ${buildResult.expoVersionMismatch.hostVersion}`
        : null,
    ].filter(Boolean).join("\n");
  }
  return null;
}

function runtimeFamilySummary(buildResult: any): string | null {
  const selection = buildResult?.runtimeFamilySelection;
  if (!selection?.selected) return null;
  const selected = selection.selected;
  const selectedLabel = selected.label || selected.id || "unknown host family";
  const guest = selection.guest || buildResult?.guestRuntime || {};
  const guestLabel = [
    guest.expoVersion ? `Expo ${guest.expoVersion}` : null,
    guest.reactNativeVersion ? `RN ${guest.reactNativeVersion}` : null,
    guest.reactVersion ? `React ${guest.reactVersion}` : null,
  ].filter(Boolean).join(" / ");
  const supported = Array.isArray(selection.supported) && selection.supported.length > 0
    ? selection.supported.map((family: any) => family.label || family.id).join("; ")
    : "";
  if (selection.exactMatch) {
    return `Runtime family matched: ${selectedLabel}${guestLabel ? ` ← ${guestLabel}` : ""}`;
  }
  return [
    `Closest host family: ${selectedLabel}${guestLabel ? ` ← ${guestLabel}` : ""}`,
    selection.reason ? `Why: ${selection.reason}` : null,
    supported ? `Host supports: ${supported}` : null,
  ].filter(Boolean).join("\n");
}
