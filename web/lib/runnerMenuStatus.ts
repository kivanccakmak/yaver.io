export type RunnerMenuHealth = "ready" | "needs-auth" | "down" | "not-installed" | "unknown";

/**
 * The device action menu is a compact launcher, not a diagnostics surface.
 * Keep provider names, credential paths, and expiry details on the device card
 * and reduce the menu's trailing label to one stable state word or phrase.
 */
export function runnerMenuStatusText(state: {
  health: RunnerMenuHealth;
  authVerified?: boolean;
  authPresent?: boolean;
}): string {
  switch (state.health) {
    case "ready":
      return state.authVerified !== true && state.authPresent === true ? "unverified" : "signed in";
    case "needs-auth":
      return state.authVerified === false ? "verify" : "sign in";
    case "down":
      return "error";
    case "not-installed":
      return "missing";
    default:
      return "unknown";
  }
}
