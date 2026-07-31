export function machineRolesSaveErrorMessage(statusOrMessage: number | string, body?: unknown): string {
  const status = typeof statusOrMessage === "number" ? statusOrMessage : 0;
  const raw = typeof statusOrMessage === "string"
    ? statusOrMessage.trim()
    : typeof body === "object" && body && "error" in body
    ? String((body as { error?: unknown }).error || "")
    : "";
  const lower = raw.toLowerCase();
  if (status === 401 || status === 403 || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "Not signed in. Sign in again, then save the runner/render route.";
  }
  if (lower.includes("must refer to one of the caller's devices")) {
    return "That route includes a machine this account does not own. Refresh Devices, pick one of your connected machines, then save again.";
  }
  if (lower.includes("runnerdeviceid")) {
    return "Pick a runner machine from your own device list before saving this route.";
  }
  if (lower.includes("renderdeviceid")) {
    return "Pick a render machine from your own device list before saving this route.";
  }
  return raw || `settings: HTTP ${status}`;
}
