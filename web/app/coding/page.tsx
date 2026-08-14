"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { agentClient, type ConnectionState, type RemoteProject, type RunnerInfo, type Task } from "@/lib/agent-client";
import { useAuth } from "@/lib/use-auth";
import { useDevices, type Device } from "@/lib/use-devices";
import { CONVEX_URL } from "@/lib/constants";

export default function CodingPage() {
  const { token, isLoading, isAuthenticated } = useAuth();
  const { devices, refreshDevices } = useDevices(token);
  const [prompt, setPrompt] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [output, setOutput] = useState("Sign in and choose an online device.");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [task, setTask] = useState<Task | null>(null);
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [runnerId, setRunnerId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("medium");
  const selectedDevice = useMemo(() => devices.find((device) => device.deviceId === deviceId), [devices, deviceId]);

  useEffect(() => {
    if (!deviceId && devices.length) {
      const preferred = devices.find((device) => device.online && !device.runnerDown) ?? devices[0];
      setDeviceId(preferred.deviceId);
    }
  }, [deviceId, devices]);

  useEffect(() => {
    const unsubscribe = agentClient.on("connectionState", setConnection);
    return () => {
      unsubscribe();
      agentClient.disconnect();
    };
  }, []);

  if (!isLoading && !isAuthenticated) {
    if (typeof window !== "undefined") window.location.href = "/auth";
    return null;
  }

  if (isLoading) return <main className="flex min-h-screen items-center justify-center bg-surface-950 text-surface-400">Loading account…</main>;

  async function connect(device: Device) {
    if (!token) return;
    setOutput(`Connecting to ${device.name}…`);
    try {
      const configResponse = await fetch(`${CONVEX_URL}/config`);
      const config = await configResponse.json() as { relayServers?: Parameters<typeof agentClient.setRelayServers>[0] };
      agentClient.setRelayServers(config.relayServers ?? []);
      await agentClient.connect(device.host, device.port, token, device.deviceId);
      const availableRunners = await agentClient.getRunners();
      setRunners(availableRunners);
      const defaultRunner = availableRunners.find((item) => item.isDefault) ?? availableRunners[0];
      if (defaultRunner) {
        setRunnerId(defaultRunner.id);
        setModel(defaultRunner.models.find((item) => item.isDefault)?.id ?? defaultRunner.models[0]?.id ?? "");
      }
      setProjectsLoading(true);
      try {
        let discovered = await agentClient.listProjects();
        if (discovered.length === 0) discovered = await agentClient.listProjects(true);
        setProjects(discovered);
        const firstProject = discovered[0]?.path ?? "";
        setProjectPath(firstProject);
        if (firstProject) await agentClient.setWorkDir(firstProject);
      } finally {
        setProjectsLoading(false);
      }
      setOutput(`Connected to ${device.name}. Ready for a task.`);
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshProjects() {
    if (!agentClient.isConnected) return;
    setProjectsLoading(true);
    try {
      const discovered = await agentClient.listProjects(true);
      setProjects(discovered);
      if (!discovered.some((project) => project.path === projectPath)) {
        const firstProject = discovered[0]?.path ?? "";
        setProjectPath(firstProject);
        if (firstProject) await agentClient.setWorkDir(firstProject);
      }
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectsLoading(false);
    }
  }

  async function selectProject(path: string) {
    setProjectPath(path);
    if (!path || !agentClient.isConnected) return;
    try {
      await agentClient.setWorkDir(path);
      setOutput(`Project selected: ${path}`);
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    }
  }

  async function run() {
    if (!prompt.trim()) return;
    if (!token || !selectedDevice) return;
    setBusy(true); setTask(null); setOutput("Submitting task to the remote agent…");
    try {
      if (!agentClient.isConnected) await connect(selectedDevice);
      const created = await agentClient.sendTask(prompt.trim(), prompt.trim(), model || undefined, runnerId || undefined, runnerId === "codex" ? reasoningEffort : undefined);
      setTask(created); setPrompt("");
      setOutput(`Task ${created.id} queued on ${selectedDevice.name}.`);
      for (;;) {
        const current = await agentClient.getTask(created.id);
        setTask(current);
        setOutput([...current.output, current.resultText ?? ""].filter(Boolean).join("\n") || `${current.status}…`);
        if (["completed", "failed", "stopped"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    catch (error) { setOutput(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-surface-950 px-6 py-10 text-surface-100"><div className="mx-auto max-w-6xl">
    <div className="mb-8 flex items-start justify-between gap-4"><div><p className="mb-2 text-xs uppercase tracking-widest text-surface-500">Yaver Web</p><h1 className="text-3xl font-bold">Remote coding workspace</h1><p className="mt-2 max-w-2xl text-sm text-surface-400">Tasks run on your selected machine using its configured runner, including OpenCode. Convex handles discovery and the relay carries the authenticated connection.</p></div><Link href="/dashboard" className="btn-secondary px-4 py-2 text-sm">Dashboard</Link></div>
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <section className="card space-y-4"><div><label className="label">Target device</label><select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Choose a device</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name} · {device.online ? "online" : "offline"}</option>)}</select></div><button className="btn-secondary w-full" disabled={!selectedDevice || connection === "connecting"} onClick={() => selectedDevice && connect(selectedDevice)}>{connection === "connected" ? "Connected" : "Connect to device"}</button><button className="btn-secondary w-full" onClick={refreshDevices}>Refresh devices</button><div className="rounded-lg border border-surface-800 bg-surface-950 p-3 text-xs text-surface-400"><p>Connection: <span className="text-surface-200">{connection}</span></p>{selectedDevice && <p className="mt-1">Runner: <span className={selectedDevice.runnerDown ? "text-red-400" : "text-surface-200"}>{selectedDevice.runnerDown ? "reported down" : "available"}</span></p>}</div><div className="border-t border-surface-800 pt-4"><div className="mb-2 flex items-center justify-between"><label className="label mb-0">Project</label><button className="text-xs text-surface-400 hover:text-surface-100" disabled={projectsLoading || connection !== "connected"} onClick={refreshProjects}>{projectsLoading ? "Scanning…" : "Refresh"}</button></div><select className="input" value={projectPath} disabled={connection !== "connected" || projectsLoading || projects.length === 0} onChange={(e) => selectProject(e.target.value)}><option value="">{projectsLoading ? "Scanning machine…" : projects.length ? "Choose a project" : "No repositories found"}</option>{projects.map((project) => <option key={project.path} value={project.path}>{project.name} · {project.branch || "detached"}</option>)}</select><p className="mt-2 text-xs text-surface-500">Tasks run from the selected repository on {selectedDevice?.name || "the remote machine"}.</p></div></section>
      <section className="card"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Remote task</h2><p className="text-xs text-surface-500">Pick a runner and model for this task.</p></div><span className={`rounded-full px-2 py-1 text-xs ${connection === "connected" ? "bg-emerald-500/10 text-emerald-400" : "bg-surface-800 text-surface-400"}`}>{connection}</span></div><div className="mb-3 grid gap-2 sm:grid-cols-3"><select className="input" value={runnerId} onChange={(e) => { const next = runners.find((item) => item.id === e.target.value); setRunnerId(e.target.value); setModel(next?.models.find((item) => item.isDefault)?.id ?? next?.models[0]?.id ?? ""); }}>{runners.map((item) => <option key={item.id} value={item.id} disabled={!item.installed}>{item.name}{item.installed ? "" : " (not installed)"}</option>)}</select><select className="input" value={model} onChange={(e) => setModel(e.target.value)}>{(runners.find((item) => item.id === runnerId)?.models ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{runnerId === "codex" ? <select className="input" value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value as "low" | "medium" | "high")}><option value="low">Low reasoning</option><option value="medium">Medium reasoning</option><option value="high">High reasoning</option></select> : <div />}</div><textarea className="input min-h-32 resize-y" placeholder="Ask the remote agent to inspect or change the workspace…" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn-primary mt-3" disabled={busy || !prompt.trim() || !selectedDevice} onClick={run}>{busy ? "Running…" : "Run remote task"}</button>{task && <p className="mt-3 text-xs text-surface-500">Task {task.id} · {task.runnerId || runnerId} · {task.model || model} · {task.status}</p>}<pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-4 text-sm text-surface-300">{output}</pre></section>
    </div>
  </div></main>;
}
