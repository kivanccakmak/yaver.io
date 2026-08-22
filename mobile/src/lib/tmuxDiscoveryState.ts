export type TmuxDiscoveryView = "loading" | "error" | "empty" | "ready";

/** Terminal presentation for one discovery source. Error intentionally wins
 * over an empty result: a failed operation is not proof there are no sessions. */
export function tmuxDiscoveryView(input: {
  loading: boolean;
  error?: string | null;
  count: number;
}): TmuxDiscoveryView {
  // Keep last-known rows visible during a refresh; a spinner must not replace
  // usable session controls for the whole timeout window.
  if (input.count > 0) return "ready";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return "empty";
}
