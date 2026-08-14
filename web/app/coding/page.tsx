"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { agentClient, type ConnectionState, type Task } from "@/lib/agent-client";
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
      setOutput(`Connected to ${device.name}. Ready for a task.`);
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
      const created = await agentClient.sendTask(prompt.trim(), prompt.trim());
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
      <section className="card space-y-4"><div><label className="label">Target device</label><select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Choose a device</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name} · {device.online ? "online" : "offline"}</option>)}</select></div><button className="btn-secondary w-full" disabled={!selectedDevice || connection === "connecting"} onClick={() => selectedDevice && connect(selectedDevice)}>{connection === "connected" ? "Connected" : "Connect to device"}</button><button className="btn-secondary w-full" onClick={refreshDevices}>Refresh devices</button><div className="rounded-lg border border-surface-800 bg-surface-950 p-3 text-xs text-surface-400"><p>Connection: <span className="text-surface-200">{connection}</span></p>{selectedDevice && <p className="mt-1">Runner: <span className={selectedDevice.runnerDown ? "text-red-400" : "text-surface-200"}>{selectedDevice.runnerDown ? "reported down" : "available"}</span></p>}</div></section>
      <section className="card"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Remote task</h2><p className="text-xs text-surface-500">Authenticated agent transport · relay-first</p></div><span className={`rounded-full px-2 py-1 text-xs ${connection === "connected" ? "bg-emerald-500/10 text-emerald-400" : "bg-surface-800 text-surface-400"}`}>{connection}</span></div><textarea className="input min-h-32 resize-y" placeholder="Ask the remote agent to inspect or change the workspace…" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn-primary mt-3" disabled={busy || !prompt.trim() || !selectedDevice} onClick={run}>{busy ? "Running…" : "Run remote task"}</button>{task && <p className="mt-3 text-xs text-surface-500">Task {task.id} · {task.status}</p>}<pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-4 text-sm text-surface-300">{output}</pre></section>
    </div>
  </div></main>;
}
