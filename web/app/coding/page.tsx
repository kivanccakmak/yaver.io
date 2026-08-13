"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { pushBrowserWorkspace, runBrowserPrompt, type BrowserWorkspace, type GitProvider, type WebProvider } from "@/lib/coding-runtime";

const initialWorkspace: BrowserWorkspace = { name: "yaver-web-workspace", branch: "main", files: { "README.md": "# Yaver Web Workspace\n\nBrowser local mode.\n" } };

export default function CodingPage() {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<WebProvider>("deepseek");
  const [model, setModel] = useState("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [gitProvider, setGitProvider] = useState<GitProvider>("github");
  const [gitToken, setGitToken] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [output, setOutput] = useState("Browser local workspace ready.");
  const [busy, setBusy] = useState(false);
  const files = useMemo(() => Object.keys(workspace.files), [workspace.files]);

  async function run() {
    if (!prompt.trim()) return;
    setBusy(true); setOutput("Working locally in the browser...");
    try { setOutput(await runBrowserPrompt(apiKey, provider, model, prompt, workspace, setWorkspace)); setPrompt(""); }
    catch (error) { setOutput(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function push() {
    setBusy(true);
    try { await pushBrowserWorkspace(gitToken, { ...workspace, repoUrl, provider: gitProvider }, "Yaver Web: update workspace"); setOutput("Committed and pushed successfully."); }
    catch (error) { setOutput(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-surface-950 px-6 py-10 text-surface-100"><div className="mx-auto max-w-6xl">
    <div className="mb-8 flex items-start justify-between gap-4"><div><p className="mb-2 text-xs uppercase tracking-widest text-surface-500">Yaver Web</p><h1 className="text-3xl font-bold">Browser coding workspace</h1><p className="mt-2 max-w-2xl text-sm text-surface-400">Local browser mode supports file work and provider-backed Git. Shell, builds, Docker, and deploy hand off to a remote machine or CI.</p></div><Link href="/dashboard" className="btn-secondary px-4 py-2 text-sm">Dashboard</Link></div>
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <section className="card space-y-4"><div><label className="label">LLM provider</label><select className="input" value={provider} onChange={(e) => setProvider(e.target.value as WebProvider)}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI-compatible</option></select></div><div><label className="label">Model</label><input className="input" value={model} onChange={(e) => setModel(e.target.value)} /></div><div><label className="label">API key (browser session only)</label><input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div><div className="border-t border-surface-800 pt-4"><label className="label">Repository URL</label><input className="input" placeholder="https://github.com/org/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} /><div className="mt-2 flex gap-2"><select className="input" value={gitProvider} onChange={(e) => setGitProvider(e.target.value as GitProvider)}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select><input className="input" type="password" placeholder="Git token (session only)" value={gitToken} onChange={(e) => setGitToken(e.target.value)} /></div><button className="btn-primary mt-3 w-full" disabled={busy} onClick={push}>Commit & push</button></div><p className="text-xs text-surface-500">Browser secrets are kept in memory only and are cleared on refresh.</p></section>
      <section className="card"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">{workspace.name}</h2><p className="text-xs text-surface-500">{workspace.branch} · browser-local · no shell</p></div><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400">Local</span></div><div className="mb-4 rounded-lg border border-surface-800 bg-surface-950 p-3"><p className="mb-2 text-xs uppercase tracking-wider text-surface-500">Files</p>{files.map((file) => <p key={file} className="font-mono text-xs text-surface-300">{file}</p>)}</div><textarea className="input min-h-32 resize-y" placeholder="Ask the agent to inspect or change the workspace..." value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn-primary mt-3" disabled={busy || !prompt.trim()} onClick={run}>{busy ? "Working..." : "Run local task"}</button><pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-4 text-sm text-surface-300">{output}</pre></section>
    </div>
  </div></main>;
}
