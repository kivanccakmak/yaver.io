/**
 * A task's execution protocol is separate from the phone-to-agent connection.
 * The former answers whether the runner negotiated ACP or used the legacy CLI
 * path; the latter is LAN/relay/tunnel transport. Keeping these labels apart
 * prevents a healthy relay connection from masquerading as ACP evidence.
 */
export function taskRunnerTransportLabel(transport?: string | null): string | null {
  const normalized = String(transport || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "acp") return "ACP";
  if (normalized === "cli-pty") return "CLI / PTY";
  return normalized;
}
