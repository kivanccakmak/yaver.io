import assert from "node:assert/strict";
import { parseDashboardChatIntent } from "./dashboard-chat-intent";

{
  const intent = parseDashboardChatIntent("open Talos for watchOS");
  assert.equal(intent?.kind, "runtime");
  assert.equal(intent?.projectQuery, "talos");
  assert.equal(intent?.surface, "watch");
  assert.equal(intent?.platform, "ios");
}

{
  const intent = parseDashboardChatIntent("run SFMG on Wear");
  assert.equal(intent?.kind, "runtime");
  assert.equal(intent?.projectQuery, "sfmg");
  assert.equal(intent?.surface, "watch");
  assert.equal(intent?.platform, "android");
}

{
  const intent = parseDashboardChatIntent("attach to the Talos Codex tmux");
  assert.equal(intent?.kind, "tmux");
  assert.equal(intent?.tmuxQuery, "talos-codex");
}

{
  const intent = parseDashboardChatIntent("show SFMG web preview");
  assert.equal(intent?.kind, "webview");
  assert.equal(intent?.projectQuery, "sfmg");
}

console.log("dashboard-chat-intent tests passed");
