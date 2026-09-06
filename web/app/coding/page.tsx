"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { agentClient, type ConnectionState, type RemoteProject, type Runner, type Task, type TaskRunnerControlCatalog } from "@/lib/agent-client";
import { useAuth } from "@/lib/use-auth";
import { useDevices, type Device } from "@/lib/use-devices";
import { CONVEX_URL } from "@/lib/constants";
import { remoteAgentConversationView, remoteAgentStatusLabel } from "@/lib/_core/taskConversation";

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
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runnerId, setRunnerId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">("medium");
  const [controlMode, setControlMode] = useState<"model" | "exit" | null>(null);
  const [controlCatalog, setControlCatalog] = useState<TaskRunnerControlCatalog | null>(null);
  const [controlModel, setControlModel] = useState("");
  const [controlEffort, setControlEffort] = useState<"none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">("medium");
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const selectedDevice = useMemo(() => devices.find((device) => device.id === deviceId), [devices, deviceId]);
  const selectedRunnerDown = selectedDevice?.online === false || selectedDevice?.runners?.every((runner) => runner.ready === false) === true;

  useEffect(() => {
    if (!deviceId && devices.length) {
      const preferred = devices.find((device) => device.online) ?? devices[0];
      setDeviceId(preferred.id);
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
      await agentClient.connect(device.host, device.port, token, device.id);
      const availableRunners = await agentClient.getRunners();
      setRunners(availableRunners);
      const defaultRunner = availableRunners.find((item) => item.isDefault) ?? availableRunners[0];
      if (defaultRunner) {
        setRunnerId(defaultRunner.id);
        setModel(defaultRunner.models?.find((item) => item.isDefault)?.id ?? defaultRunner.models?.[0]?.id ?? "");
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
    if (/^\/(model|exit)$/i.test(prompt.trim())) {
      const mode = prompt.trim().toLowerCase() === "/model" ? "model" : "exit";
      setPrompt("");
      await openControl(mode);
      return;
    }
    if (!token || !selectedDevice) return;
    setBusy(true); setTask(null); setOutput("Submitting task to the remote agent…");
    try {
      if (!agentClient.isConnected) await connect(selectedDevice);
      const created = await agentClient.sendTask(prompt.trim(), prompt.trim(), {
        model: model || undefined,
        runner: runnerId || undefined,
        reasoningEffort: runnerId === "codex" ? reasoningEffort : undefined,
      });
      setTask(created); setPrompt("");
      setOutput(`Task ${created.id} queued on ${selectedDevice.name}.`);
      for (;;) {
        const current = await agentClient.getTask(created.id);
        setTask(current);
        const view = remoteAgentConversationView(current);
        setOutput(view.assistantText || view.detail || remoteAgentStatusLabel(current.status));
        if (view.closesTurnStream) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    catch (error) { setOutput(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function openControl(mode: "model" | "exit") {
    if (!task) {
      setOutput(`Start a task before using /${mode}.`);
      return;
    }
    setControlMode(mode);
    setControlCatalog(null);
    setControlError("");
    setControlBusy(true);
    try {
      const catalog = await agentClient.getTaskRunnerControls(task.id);
      const selected = catalog.model || catalog.models.find((item) => item.isDefault)?.id || catalog.models[0]?.id || "";
      setControlCatalog(catalog);
      setControlModel(selected);
      setControlEffort(catalog.reasoningEffort || catalog.models.find((item) => item.id === selected)?.defaultReasoningEffort || "medium");
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlBusy(false);
    }
  }

  async function applyModelControl() {
    if (!task || !controlCatalog || !controlModel) return;
    setControlBusy(true);
    setControlError("");
    try {
      const result = await agentClient.applyTaskRunnerControl(task.id, { control: "model", model: controlModel, ...(controlCatalog.runnerId === "codex" ? { reasoningEffort: controlEffort } : {}) });
      setTask({ ...task, model: result.model || controlModel, reasoningEffort: result.reasoningEffort });
      setControlMode(null);
      setOutput(`Model set to ${result.model || controlModel}${result.reasoningEffort ? ` · ${result.reasoningEffort}` : ""} for the next turn.`);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlBusy(false);
    }
  }

  async function exitControl() {
    if (!task) return;
    setControlBusy(true);
    setControlError("");
    try {
      const result = await agentClient.applyTaskRunnerControl(task.id, { control: "exit", confirmed: true });
      setTask({ ...task, status: result.status || "stopped" });
      setControlMode(null);
      setOutput(result.alreadyExited ? "Runner session was already exited." : "Runner session exited.");
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlBusy(false);
    }
  }

  return <main className="min-h-screen bg-surface-950 px-6 py-10 text-surface-100"><div className="mx-auto max-w-6xl">
    <div className="mb-8 flex items-start justify-between gap-4"><div><p className="mb-2 text-xs uppercase tracking-widest text-surface-500">Yaver Web</p><h1 className="text-3xl font-bold">Remote coding workspace</h1><p className="mt-2 max-w-2xl text-sm text-surface-400">Tasks run on your selected machine using its configured runner, including OpenCode. Convex handles discovery and the relay carries the authenticated connection.</p></div><Link href="/dashboard" className="btn-secondary px-4 py-2 text-sm">Dashboard</Link></div>
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <section className="card space-y-4"><div><label className="label">Target device</label><select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Choose a device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.online ? "online" : "offline"}</option>)}</select></div><button className="btn-secondary w-full" disabled={!selectedDevice || connection === "connecting"} onClick={() => selectedDevice && connect(selectedDevice)}>{connection === "connected" ? "Connected" : "Connect to device"}</button><button className="btn-secondary w-full" onClick={refreshDevices}>Refresh devices</button><div className="rounded-lg border border-surface-800 bg-surface-950 p-3 text-xs text-surface-400"><p>Connection: <span className="text-surface-200">{connection}</span></p>{selectedDevice && <p className="mt-1">Runner: <span className={selectedRunnerDown ? "text-red-400" : "text-surface-200"}>{selectedRunnerDown ? "reported down" : "available"}</span></p>}</div><div className="border-t border-surface-800 pt-4"><div className="mb-2 flex items-center justify-between"><label className="label mb-0">Project</label><button className="text-xs text-surface-400 hover:text-surface-100" disabled={projectsLoading || connection !== "connected"} onClick={refreshProjects}>{projectsLoading ? "Scanning…" : "Refresh"}</button></div><select className="input" value={projectPath} disabled={connection !== "connected" || projectsLoading || projects.length === 0} onChange={(e) => selectProject(e.target.value)}><option value="">{projectsLoading ? "Scanning machine…" : projects.length ? "Choose a project" : "No repositories found"}</option>{projects.map((project) => <option key={project.path} value={project.path}>{project.name} · {project.branch || "detached"}</option>)}</select><p className="mt-2 text-xs text-surface-500">Tasks run from the selected repository on {selectedDevice?.name || "the remote machine"}.</p></div></section>
      <section className="card"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Remote task</h2><p className="text-xs text-surface-500">Pick a runner and model for this task.</p></div><span className={`rounded-full px-2 py-1 text-xs ${connection === "connected" ? "bg-emerald-500/10 text-emerald-400" : "bg-surface-800 text-surface-400"}`}>{connection}</span></div><div className="mb-3 grid gap-2 sm:grid-cols-3"><select className="input" value={runnerId} onChange={(e) => { const next = runners.find((item) => item.id === e.target.value); setRunnerId(e.target.value); setModel(next?.models?.find((item) => item.isDefault)?.id ?? next?.models?.[0]?.id ?? ""); }}>{runners.map((item) => <option key={item.id} value={item.id} disabled={!item.installed}>{item.name}{item.installed ? "" : " (not installed)"}</option>)}</select><select className="input" value={model} onChange={(e) => { const next = e.target.value; setModel(next); const selected = runners.find((item) => item.id === runnerId)?.models?.find((item) => item.id === next); setReasoningEffort((selected?.defaultReasoningEffort || "medium") as typeof reasoningEffort); }}>{(runners.find((item) => item.id === runnerId)?.models ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{runnerId === "codex" ? <select className="input" value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}>{(runners.find((item) => item.id === runnerId)?.models?.find((item) => item.id === model)?.supportedReasoningEfforts || []).map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort === "xhigh" ? "Extra high reasoning" : item.reasoningEffort === "max" ? "More reasoning" : `${item.reasoningEffort[0].toUpperCase()}${item.reasoningEffort.slice(1)} reasoning`}</option>)}</select> : <div />}</div><textarea className="input min-h-32 resize-y" placeholder="Ask the remote agent to inspect or change the workspace…" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn-primary mt-3" disabled={busy || !prompt.trim() || !selectedDevice} onClick={run}>{busy ? "Running…" : "Run remote task"}</button>{task ? <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-surface-500"><span>Task {task.id} · {task.model || model}{task.reasoningEffort ? ` · ${task.reasoningEffort}` : ""} · {task.status}</span><button type="button" className="rounded border border-surface-700 px-2 py-1 text-surface-300" onClick={() => void openControl("model")}>Model</button><button type="button" className="rounded border border-red-500/30 px-2 py-1 text-red-300" onClick={() => void openControl("exit")}>Exit</button></div> : null}{controlMode ? <div className="mt-3 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs"><div className="flex items-start justify-between"><div><strong>{controlMode === "model" ? "Choose this conversation’s model" : "Exit this runner session?"}</strong>{controlCatalog ? <p className="mt-1 text-surface-500">{controlCatalog.runnerId} · {controlCatalog.modelSource || "this machine"}</p> : null}</div><button type="button" onClick={() => setControlMode(null)}>×</button></div>{controlBusy && !controlCatalog ? <p className="mt-2 text-surface-400">Checking the task’s machine…</p> : null}{controlError ? <p className="mt-2 text-red-300">{controlError}</p> : null}{controlMode === "model" && controlCatalog ? <><select className="input mt-3" value={controlModel} onChange={(e) => { const next = e.target.value; setControlModel(next); setControlEffort(controlCatalog.models.find((item) => item.id === next)?.defaultReasoningEffort || controlCatalog.reasoningEffort || "medium"); }}>{controlCatalog.models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}{item.id === controlCatalog.model ? " · current" : ""}</option>)}</select>{controlCatalog.runnerId === "codex" ? <select className="input mt-2" value={controlEffort} onChange={(e) => setControlEffort(e.target.value as typeof controlEffort)}>{(controlCatalog.models.find((item) => item.id === controlModel)?.supportedReasoningEfforts || []).map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort === "xhigh" ? "Extra high" : item.reasoningEffort === "max" ? "More reasoning" : item.reasoningEffort}</option>)}</select> : null}<button type="button" disabled={controlBusy || controlCatalog.isAdopted} className="btn-primary mt-3" onClick={() => void applyModelControl()}>{controlBusy ? "Applying…" : "Use model"}</button></> : null}{controlMode === "exit" ? <div className="mt-3 flex gap-2"><button type="button" className="btn-secondary" onClick={() => setControlMode(null)}>Keep session</button><button type="button" disabled={controlBusy} className="rounded-lg bg-red-600 px-3 py-2 font-semibold text-white" onClick={() => void exitControl()}>{controlBusy ? "Exiting…" : "Exit session"}</button></div> : null}</div> : null}<div className="mt-3 rounded-lg border border-surface-800 bg-surface-950 p-3 text-xs text-surface-400"><p className="font-medium">Validation</p><p className="mt-1">{connection === "connected" ? `Executor: ${selectedDevice?.name || "selected machine"}. No compile or test result has run yet.` : "Not available in this browser alone. Connect a machine or CI executor."}</p></div><pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-4 text-sm text-surface-300">{output}</pre>{task && (task.rawOutput || task.output.length > 0) ? <details className="mt-3 rounded-lg border border-surface-800 bg-surface-950"><summary className="cursor-pointer px-3 py-2 text-xs text-surface-400">Runner details</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-surface-800 p-3 text-xs text-surface-500">{task.rawOutput || task.output.join("\n")}</pre></details> : null}</section>
    </div>
  </div></main>;
}
