// webview-preload.js — the Electron <webview> bridge for Yaver's DOM MODE.
//
// The guest page runs TOP-LEVEL inside the webview (window.parent === window),
// so the dom probe's self-post is the only delivery path — the parent-branch
// of sendUp() never fires. This preload listens on the guest window for
// DOM-mode messages and relays them to the host renderer over
// ipcRenderer.sendToHost. The host renderer then forwards to the agent over
// its own authenticated agentRequest channel (/dev/ is unauthenticated by
// design, so the page must never talk to the agent directly).
//
// ipcRenderer here is the GUEST's ipcRenderer, bridged through the webview
// (the host's <webview preload="...">). sendToHost targets the embedding
// renderer, exactly like the handoff specifies.

const { ipcRenderer } = require("electron");

// The host renderer asks us to flip DOM mode on/off in the guest page.
ipcRenderer.on("yaver-dom-mode", (_e, enabled) => {
  window.postMessage({ source: "yaver-dom", t: "yaver-dom-mode", enabled: !!enabled }, "*");
});

// Relay the probe's element/inventory messages up to the host renderer.
window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  if (e.data.source !== "yaver-dom") return;
  if (e.data.t === "yaver-dom-element" || e.data.t === "yaver-dom-items-list") {
    ipcRenderer.sendToHost("yaver-dom", e.data);
  }
});
