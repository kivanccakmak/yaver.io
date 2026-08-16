// Tiny cross-tab store: lets the Projects screen hand a chosen project to the
// Vibing screen (which then auto-starts its preview).
let pendingVibingProject: string | null = null;

export function setPendingVibingProject(path: string): void {
  pendingVibingProject = path;
}

export function takePendingVibingProject(): string | null {
  const p = pendingVibingProject;
  pendingVibingProject = null;
  return p;
}
