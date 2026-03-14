/**
 * In-memory ring buffer logger for connection diagnostics.
 * Keeps the last N log entries in memory for display in the UI.
 */

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
}

const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];
const listeners: Array<() => void> = [];

export function appLog(level: LogEntry["level"], message: string) {
  const entry: LogEntry = { timestamp: Date.now(), level, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  for (const cb of listeners) cb();
  // Also forward to console
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[App] ${message}`);
}

export function getLogEntries(): LogEntry[] {
  return [...entries];
}

export function clearLogEntries() {
  entries.length = 0;
  for (const cb of listeners) cb();
}

export function onLogsChanged(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
