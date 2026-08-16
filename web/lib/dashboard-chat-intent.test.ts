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

// Regression (2026-08-10): a normal vibe prompt sent with Enter used to be
// misrouted into the terminal. "I did not like the experience … deep audit
// analysis … download speech and convert text with whisper then analyze"
// contains none of the explicit tmux verbs, yet the OLD wantsTmux test
// (`session|attach|resume` in prose) could fire on a common word and opened a
// WebShell that 400'd. A bare Enter must behave exactly like the Send button:
// this prompt is a TASK, not a tmux attach.
{
  const prompt = "so in last at ai.tusrehber.com i did not like experience i had deep audit analysis first download speech and convert text with whisper then analyze etc deeply";
  const intent = parseDashboardChatIntent(prompt);
  assert.equal(intent, null, "deep-audit prose must NOT become a tmux intent");
}

// And the genuine tmux commands must still attach:
{
  const intent = parseDashboardChatIntent("attach to my codex session");
  assert.equal(intent?.kind, "tmux");
}
{
  const intent = parseDashboardChatIntent("resume the claude tmux");
  assert.equal(intent?.kind, "tmux");
}
// A bare "resume" alone is prose, not an attach:
{
  const intent = parseDashboardChatIntent("resume");
  assert.equal(intent, null);
}

console.log("dashboard-chat-intent tests passed");
