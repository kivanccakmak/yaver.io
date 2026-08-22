// One explicit execution-mode contract for the mobile app.
//
// `remote-preferred` is deliberately the default. `local-only` is entered only
// after the user selects “No remote box” and suppresses every automatic device
// connection until the user selects a real box again. `auto-fallback` remains
// readable for older installs, but the new picker never enables it implicitly.

export type MobileExecutionMode = "remote-preferred" | "local-only" | "auto-fallback";

export function normalizeMobileExecutionMode(value: unknown): MobileExecutionMode {
  return value === "local-only" || value === "auto-fallback" ? value : "remote-preferred";
}

export function allowsRemoteAutoConnect(mode: MobileExecutionMode): boolean {
  return mode !== "local-only";
}

export function isExplicitRemoteless(mode: MobileExecutionMode): boolean {
  return mode === "local-only";
}
