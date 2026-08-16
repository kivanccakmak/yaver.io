"use strict";

/**
 * Yaver GUI — preload bridge (sandboxed).
 *
 * Exposes a minimal, frozen API on window.yaver and runs a DOM observer that
 * detects task-completion states in the dashboard and asks the main process
 * for a native notification.
 *
 * Detection is deliberately conservative:
 *  - watches leaf text nodes for the exact status strings the chat header
 *    renders ({activeTask.status}: "completed" | "failed" | "stopped" |
 *    "review"), throttled to 1 Hz;
 *  - dedupes by status and suppresses repeats for 45s, so list rows and
 *    transient renders can't spam;
 *  - the task title is taken from the closest `span.truncate` sibling in the
 *    header (the dashboard's title span), with a fallback to the page title.
 *
 * Nothing here touches the renderer's state; it only reads the DOM.
 */

const { contextBridge, ipcRenderer } = require("electron");

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "review"]);

let lastNotified = null; // { kind, at }
let notifiedTitle = null;

function statusText(node) {
  return node && node.nodeType === Node.TEXT_NODE ? (node.nodeValue || "").trim().toLowerCase() : "";
}

function nearestTitle(el) {
  // Header shape: <span class="truncate ...">{title}</span> next to the
  // status span. Walk up a few levels looking for a span.truncate sibling.
  let node = el;
  for (let depth = 0; depth < 4 && node; depth++) {
    const parent = node.parentElement;
    if (!parent) break;
    const titleSpan = parent.querySelector("span.truncate");
    if (titleSpan && titleSpan.textContent) {
      const t = titleSpan.textContent.trim();
      if (t && t.length < 160) return t;
    }
    node = parent;
  }
  return document.title || "";
}

function scanStatusTextNodes() {
  if (!document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const now = Date.now();
  const nodes = [];
  while (walker.nextNode()) {
    const value = statusText(walker.currentNode);
    if (TERMINAL_STATUSES.has(value)) {
      nodes.push({ value, node: walker.currentNode });
    }
  }
  if (nodes.length === 0) return;

  // Prefer the first match; the task header sits near the top of the DOM.
  const { value: kind, node } = nodes[0];
  if (lastNotified && lastNotified.kind === kind && now - lastNotified.at < 45_000) return;

  const title = nearestTitle(node);
  if (kind === "completed" && title === notifiedTitle) return; // same task re-render

  lastNotified = { kind, at: now };
  notifiedTitle = title;
  ipcRenderer.send("yaver:task-status", { kind, title });
}

let observerStarted = false;

function ensureObserver() {
  if (observerStarted) return;
  observerStarted = true;
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scanStatusTextNodes();
    }, 1000);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // First scan after the app settles.
  setTimeout(scanStatusTextNodes, 4000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureObserver, { once: true });
} else {
  ensureObserver();
}

contextBridge.exposeInMainWorld("yaver", Object.freeze({
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    app: "0.1.0",
  },
  /**
   * Manual notification hook for the dashboard to adopt later
   * (e.g. on task terminal state, agent_question handoffs). No-op safe.
   */
  notify(title, body = "") {
    ipcRenderer.send("yaver:task-status", { kind: "notice", title: body ? `${title} — ${body}` : title });
  },
  /** Toggle tray task notifications. Returns the new state. */
  setTaskNotifications(enabled) {
    ipcRenderer.send("yaver:set-task-notifications", Boolean(enabled));
    return Boolean(enabled);
  },
}));
