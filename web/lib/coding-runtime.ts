"use client";

export type WebProvider = "deepseek" | "openai-compatible";
export type GitProvider = "github" | "gitlab";

export interface BrowserWorkspace {
  name: string;
  repoUrl?: string;
  provider?: GitProvider;
  branch: string;
  files: Record<string, string>;
}

const endpoint = (provider: WebProvider) => provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";

const tools = [
  { type: "function", function: { name: "fs_read", description: "Read a workspace file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "fs_write", description: "Write a workspace file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "fs_search", description: "Search workspace text", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
];

function safePath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid workspace path");
  return normalized;
}

export async function runBrowserPrompt(apiKey: string, provider: WebProvider, model: string, prompt: string, workspace: BrowserWorkspace, onWorkspace: (next: BrowserWorkspace) => void): Promise<string> {
  if (!apiKey.trim()) throw new Error("Enter a provider API key for this browser session.");
  const messages: any[] = [
    { role: "system", content: "You are Yaver Web local mode. You can read, search, and edit this browser workspace. You cannot run shell commands, Docker, native builds, or deploy. Be explicit when remote or CI execution is required." },
    { role: "user", content: prompt },
  ];
  for (let turn = 0; turn < 8; turn++) {
    const response = await fetch(endpoint(provider), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.1 }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Provider returned HTTP ${response.status}`);
    const message = data.choices?.[0]?.message || {};
    messages.push(message);
    if (!message.tool_calls?.length) return message.content || "Done.";
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      let result: unknown;
      try {
        if (call.function.name === "fs_read") result = workspace.files[safePath(args.path)] || "File not found.";
        else if (call.function.name === "fs_search") result = Object.entries(workspace.files).filter(([, content]) => content.toLowerCase().includes(String(args.query).toLowerCase())).map(([path]) => path);
        else if (call.function.name === "fs_write") {
          const path = safePath(args.path);
          const next = { ...workspace, files: { ...workspace.files, [path]: String(args.content) } };
          onWorkspace(next); result = { ok: true, path };
        } else result = { error: "Unknown tool" };
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "The browser agent reached its safe tool-call limit. Review the workspace and continue or hand off remotely.";
}

function repoParts(repoUrl: string): { owner: string; name: string } {
  const parts = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Use a full GitHub/GitLab repository URL.");
  return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

export async function pushBrowserWorkspace(token: string, workspace: BrowserWorkspace, message: string): Promise<void> {
  if (!workspace.repoUrl || !workspace.provider) throw new Error("Add a GitHub or GitLab repository URL first.");
  if (!token.trim()) throw new Error("Enter a Git provider token for this browser session.");
  const { owner, name } = repoParts(workspace.repoUrl);
  if (workspace.provider === "github") {
    for (const [path, content] of Object.entries(workspace.files)) {
      const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;
      const existing = await fetch(url, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } });
      const old = await existing.json().catch(() => ({}));
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ message, content: btoa(unescape(encodeURIComponent(content))), branch: workspace.branch, ...(old.sha ? { sha: old.sha } : {}) }) });
      if (!response.ok) throw new Error(`GitHub push failed for ${path} (HTTP ${response.status}).`);
    }
  } else {
    const response = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${name}`)}/repository/commits`, { method: "POST", headers: { "Content-Type": "application/json", "PRIVATE-TOKEN": token }, body: JSON.stringify({ branch: workspace.branch, commit_message: message, actions: Object.entries(workspace.files).map(([file_path, content]) => ({ action: "upsert", file_path, content })) }) });
    if (!response.ok) throw new Error(`GitLab push failed (HTTP ${response.status}).`);
  }
}
