// renderCapability.ts — the client-side failure contract for preview surfaces.
//
// A missing runner is a capability constraint, not a transient loading state.
// Keep the code and route stable so mobile, tvOS, visionOS, and future native
// surfaces can render the same honest answer without matching prose.

export const REMOTE_RENDER_REQUIRED = "surface.remote_render_required";

export type RenderCapabilityFailure = {
  code: typeof REMOTE_RENDER_REQUIRED;
  title: string;
  message: string;
  action: { label: string; route: "/devices" };
};

export function remoteRenderRequiredFailure(surface: string): RenderCapabilityFailure {
  return {
    code: REMOTE_RENDER_REQUIRED,
    title: "Remote runtime required",
    message: `${surface} can edit or audit locally, but rendering, builds, simulators, and dev servers require a connected remote runner. Select or activate one before choosing a preview target.`,
    action: { label: "Select a runner", route: "/devices" },
  };
}
