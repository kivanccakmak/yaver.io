"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_QUEUE_BYTES = 256 * 1024;

function redactDesktopLog(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|__rp|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/((?:token|auth[_-]?token|relay[_-]?password|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 4096);
}

class DesktopLog {
  constructor({ directory, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES, maxQueueBytes = DEFAULT_QUEUE_BYTES, flushMs = 1000 } = {}) {
    if (!directory || !path.isAbsolute(directory)) throw new Error("desktop log directory must be absolute");
    this.directory = directory;
    this.filePath = path.join(directory, "yaver-desktop.log");
    this.maxBytes = maxBytes;
    this.maxFiles = Math.max(1, maxFiles);
    this.maxQueueBytes = maxQueueBytes;
    this.queue = [];
    this.queueBytes = 0;
    this.dropped = 0;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref?.();
  }

  write(level, event, detail = "") {
    const row = JSON.stringify({
      at: new Date().toISOString(),
      level: String(level || "info").slice(0, 16),
      event: redactDesktopLog(event).slice(0, 160),
      ...(detail ? { detail: redactDesktopLog(detail) } : {}),
    }) + "\n";
    const bytes = Buffer.byteLength(row);
    if (bytes > this.maxQueueBytes || this.queueBytes + bytes > this.maxQueueBytes) {
      this.dropped += 1;
      return false;
    }
    this.queue.push(row);
    this.queueBytes += bytes;
    return true;
  }

  rotate(incomingBytes) {
    let current = 0;
    try { current = fs.statSync(this.filePath).size; } catch { /* first write */ }
    if (current + incomingBytes <= this.maxBytes) return;
    const oldest = `${this.filePath}.${this.maxFiles - 1}`;
    if (this.maxFiles > 1) {
      try { fs.unlinkSync(oldest); } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (let i = this.maxFiles - 2; i >= 1; i -= 1) {
        try { fs.renameSync(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      try { fs.renameSync(this.filePath, `${this.filePath}.1`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      try { fs.truncateSync(this.filePath, 0); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  flush() {
    if (this.queue.length === 0 && this.dropped === 0) return;
    const rows = this.queue;
    const dropped = this.dropped;
    this.queue = [];
    this.queueBytes = 0;
    this.dropped = 0;
    if (dropped > 0) {
      rows.push(JSON.stringify({ at: new Date().toISOString(), level: "warn", event: "log_queue_dropped", detail: `${dropped} entries dropped to protect memory and disk` }) + "\n");
    }
    const body = rows.join("");
    try {
      this.rotate(Buffer.byteLength(body));
      fs.appendFileSync(this.filePath, body, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never crash or stall the product they observe.
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}

module.exports = { DesktopLog, redactDesktopLog, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, DEFAULT_QUEUE_BYTES };
