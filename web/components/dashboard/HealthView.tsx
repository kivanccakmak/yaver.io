"use client";

import { useState, useEffect, useRef } from "react";
import { agentClient, type DevelopmentDoctorCheck, type DevelopmentDoctorReport } from "@/lib/agent-client";

interface HealthTarget { id: string; url: string; name?: string; status?: string; responseTime?: number; }
type Machine = Awaited<ReturnType<typeof agentClient.machineHealth>>;
type Peer = Awaited<ReturnType<typeof agentClient.machinePeers>>[number];
type DesktopConnectivityCheck = {
  id: string;
  name: string;
  status: "pass" | "info" | "warn" | "fail";
  detail: string;
  fix?: { id: string; label: string };
  aiEligible?: boolean;
};
type DesktopConnectivityReport = { ok: boolean; platform: string; checks: DesktopConnectivityCheck[] };

function desktopConnectivityBridge() {
  if (typeof window === "undefined") return null;
  return (window as typeof window & {
    yaver?: {
      surface?: string;
      runConnectivityDiagnostics?: () => Promise<DesktopConnectivityReport>;
      applyConnectivityFix?: (id: string) => Promise<{ ok?: boolean; error?: string; requiresUserAction?: boolean }>;
    };
  }).yaver;
}

export default function HealthView() {
  const [targets, setTargets] = useState<HealthTarget[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [machine, setMachine] = useState<Machine>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [doctor, setDoctor] = useState<DevelopmentDoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(true);
  const [doctorError, setDoctorError] = useState("");
  const [installing, setInstalling] = useState("");
  const [installLines, setInstallLines] = useState<string[]>([]);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [desktopReport, setDesktopReport] = useState<DesktopConnectivityReport | null>(null);
  const [desktopLoading, setDesktopLoading] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState("");
  const [desktopMessage, setDesktopMessage] = useState("");
  const stopInstallStream = useRef<null | (() => void)>(null);

  useEffect(() => {
    loadTargets();
    loadMachine();
    loadDoctor();
    const bridge = desktopConnectivityBridge();
    if (bridge?.surface === "desktop-gui" && typeof bridge.runConnectivityDiagnostics === "function") {
      setDesktopAvailable(true);
      void loadDesktopConnectivity();
    }
    const i = setInterval(() => {
      loadTargets();
      loadMachine();
    }, 15000);
    return () => {
      clearInterval(i);
      stopInstallStream.current?.();
    };
  }, []);

  async function loadDesktopConnectivity() {
    const bridge = desktopConnectivityBridge();
    if (typeof bridge?.runConnectivityDiagnostics !== "function") return;
    setDesktopLoading(true);
    setDesktopMessage("");
    try {
      setDesktopReport(await bridge.runConnectivityDiagnostics());
    } catch (err) {
      setDesktopMessage(err instanceof Error ? err.message : "Desktop connectivity diagnostics could not run");
    } finally {
      setDesktopLoading(false);
    }
  }

  async function applyDesktopFix(check: DesktopConnectivityCheck) {
    const bridge = desktopConnectivityBridge();
    if (!check.fix || typeof bridge?.applyConnectivityFix !== "function") return;
    setDesktopBusy(check.id);
    setDesktopMessage(`Starting ${check.fix.label.toLowerCase()}…`);
    try {
      const result = await bridge.applyConnectivityFix(check.fix.id);
      if (!result?.ok) throw new Error(result?.error || "The repair did not complete");
      setDesktopMessage(result.requiresUserAction
        ? "The operating-system screen is open. Complete the local consent, then rescan."
        : "Repair completed. Rescanning the real operations…");
      if (!result.requiresUserAction) await loadDesktopConnectivity();
    } catch (err) {
      setDesktopMessage(err instanceof Error ? err.message : "Desktop repair failed");
    } finally {
      setDesktopBusy("");
    }
  }

  async function fixDesktopWithAI(check: DesktopConnectivityCheck) {
    setDesktopBusy(`ai:${check.id}`);
    setDesktopMessage("Starting an OpenCode troubleshooting task on this machine…");
    try {
      const task = await agentClient.createTask({
        title: `Repair desktop connectivity: ${check.name}`,
        description: [
          "Diagnose and repair this Yaver desktop connectivity finding on the current machine.",
          `Finding: ${check.name}. Evidence: ${check.detail}`,
          "Re-run the real operation probes before changing anything and again afterward.",
          "Prefer deterministic Yaver doctor/ops fixes. Do not disable a firewall, expose a Public firewall profile, enable Microsoft RDP, change Tailscale ownership/ACLs, or grant screen/control permissions without asking the local owner first.",
          "If an OS consent or elevation prompt is required, stop and name the exact one-click action for the user.",
        ].join("\n"),
        runner: "opencode",
        includeYaverMcp: true,
      });
      setDesktopMessage(`OpenCode task ${task.id} started. Open Tasks to follow its live console.`);
    } catch (err) {
      setDesktopMessage(err instanceof Error ? err.message : "OpenCode troubleshooting could not start");
    } finally {
      setDesktopBusy("");
    }
  }

  async function loadDoctor() {
    setDoctorLoading(true);
    setDoctorError("");
    try {
      setDoctor(await agentClient.developmentDoctor());
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : "Development Doctor could not run");
    } finally {
      setDoctorLoading(false);
    }
  }

  function openDoctorDestination(check: DevelopmentDoctorCheck) {
    const fix = check.fix;
    if (!fix) return;
    if (fix.kind === "open-url" && fix.url) {
      window.open(fix.url, "_blank", "noopener,noreferrer");
      return;
    }
    const next = new URL(window.location.href);
    next.searchParams.set("tab", fix.tab || "tools");
    window.location.assign(next.toString());
  }

  async function applyDoctorFix(check: DevelopmentDoctorCheck) {
    const fix = check.fix;
    if (!fix) return;
    if (fix.kind !== "install") {
      openDoctorDestination(check);
      return;
    }
    const match = fix.path?.match(/^\/install\/([^/?#]+)$/);
    const tool = match ? decodeURIComponent(match[1]) : "";
    if (!tool) {
      setDoctorError(`${check.name} advertised an invalid install route`);
      return;
    }
    stopInstallStream.current?.();
    setInstalling(check.id || tool);
    setInstallLines([`Starting ${check.name}…`]);
    setDoctorError("");
    const started = await agentClient.installTool(tool);
    if (!started.ok) {
      setInstalling("");
      setDoctorError(started.error || `${check.name} install could not start`);
      return;
    }
    let terminal = false;
    stopInstallStream.current = agentClient.streamLog(
      started.stream || fix.stream || `install:${tool}`,
      (event) => {
        const line = typeof event?.text === "string" ? event.text : typeof event?.line === "string" ? event.line : "";
        if (line) setInstallLines((old) => [...old.slice(-7), line]);
        if (event?.type !== "result") return;
        terminal = true;
        stopInstallStream.current?.();
        stopInstallStream.current = null;
        setInstalling("");
        if (event.status === "ok") {
          setInstallLines((old) => [...old.slice(-7), `${check.name} is installed. Rescanning…`]);
          void loadDoctor();
        } else {
          setDoctorError(typeof event.error === "string" ? event.error : `${check.name} install failed`);
        }
      },
      () => {
        if (!terminal) {
          setInstalling("");
          setDoctorError(`${check.name} install stream closed before reporting a result`);
        }
      },
    );
  }

  async function loadTargets() {
    try {
      setTargets(await agentClient.listHealthTargets());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  }

  async function loadMachine() {
    try {
      const [m, p] = await Promise.all([
        agentClient.machineHealth(),
        agentClient.machinePeers(),
      ]);
      setMachine(m);
      setPeers(p);
    } catch {}
  }

  async function addTarget() {
    if (!input.trim()) return;
    await agentClient.addHealthTarget({ url: input.trim(), name: input.trim() });
    setInput("");
    loadTargets();
  }

  async function deleteTarget(id: string) {
    await agentClient.deleteHealthTarget(id);
    loadTargets();
  }

  function statusColor(s?: string) {
    if (s === "up") return "bg-emerald-400";
    if (s === "warning") return "bg-amber-400";
    return "bg-red-400";
  }

  const developmentChecks = doctor?.checks.filter((check) =>
    ["platform", "config", "auth", "agent", "connectivity", "network", "relay", "remote-access", "runners", "development", "provider-auth", "onboarding"].includes(check.section),
  ) ?? [];
  const findings = developmentChecks.filter((check) => check.status !== "pass");
  const passed = developmentChecks.length - findings.length;

  return (
    <div className="space-y-4">
      {desktopAvailable && (
        <section className="rounded-xl border border-surface-800 bg-surface-900/60 p-4" aria-label="Desktop Connectivity Doctor">
          <div className="flex items-start gap-3">
            <div className={`mt-1 h-2.5 w-2.5 rounded-full ${desktopReport?.checks.some((check) => check.status === "fail") ? "bg-red-400" : desktopReport?.checks.some((check) => check.status === "warn") ? "bg-amber-400" : desktopReport ? "bg-emerald-400" : "bg-surface-600"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-surface-100">Connectivity &amp; Remote Access</h2>
                  <p className="mt-0.5 text-xs text-surface-500">
                    Local agent, Convex identity, LAN/Tailscale discovery, firewall, and remote-desktop readiness.
                  </p>
                </div>
                <button disabled={desktopLoading || !!desktopBusy} onClick={loadDesktopConnectivity} className="shrink-0 rounded-md bg-surface-800 px-3 py-1.5 text-xs text-surface-300 hover:bg-surface-700 disabled:opacity-50">
                  {desktopLoading ? "Probing…" : "Rescan"}
                </button>
              </div>

              {desktopReport && (
                <div className="mt-3 space-y-2">
                  {desktopReport.checks.filter((check) => check.status !== "pass").map((check) => (
                    <div key={check.id} className="rounded-lg border border-surface-800 bg-surface-950/50 p-3">
                      <div className="flex items-start gap-3">
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${check.status === "fail" ? "bg-red-400" : check.status === "warn" ? "bg-amber-400" : "bg-sky-400"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-surface-200">{check.name}</div>
                          <div className="mt-0.5 break-words text-xs text-surface-500">{check.detail}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {check.fix && (
                            <button disabled={!!desktopBusy} onClick={() => void applyDesktopFix(check)} className="rounded-md bg-indigo-500 px-2.5 py-1.5 text-xs text-white hover:bg-indigo-400 disabled:opacity-50">
                              {desktopBusy === check.id ? "Working…" : check.fix.label}
                            </button>
                          )}
                          {check.aiEligible && (
                            <button disabled={!!desktopBusy} onClick={() => void fixDesktopWithAI(check)} className="rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-xs text-surface-300 hover:bg-surface-800 disabled:opacity-50" title="Uses OpenCode with this machine/account's configured provider and model">
                              {desktopBusy === `ai:${check.id}` ? "Starting…" : "Fix with AI"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {desktopReport.checks.every((check) => check.status === "pass") && (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-300">All local connectivity checks passed. Remote candidates still remain operation-probed per peer.</div>
                  )}
                </div>
              )}
              {desktopMessage && <div className="mt-3 rounded-md bg-surface-950/60 px-3 py-2 text-xs text-surface-400" aria-live="polite">{desktopMessage}</div>}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-surface-800 bg-surface-900/60 p-4" aria-label="Development Doctor">
        <div className="flex items-start gap-3">
          <div className={`mt-1 h-2.5 w-2.5 rounded-full ${doctorError ? "bg-red-400" : findings.length ? "bg-amber-400" : doctor ? "bg-emerald-400" : "bg-surface-600"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-surface-100">Development Doctor</h2>
                <p className="mt-0.5 text-xs text-surface-500">
                  {doctorLoading ? "Checking runners, provider auth, Git, mobile, and cloud toolchains…" : doctorError ? doctorError : findings.length ? `${findings.length} item${findings.length === 1 ? "" : "s"} need attention · ${passed} ready` : `${passed} checks ready`}
                </p>
              </div>
              <button disabled={doctorLoading || !!installing} onClick={loadDoctor} className="shrink-0 rounded-md bg-surface-800 px-3 py-1.5 text-xs text-surface-300 hover:bg-surface-700 disabled:opacity-50">
                {doctorLoading ? "Scanning…" : "Rescan"}
              </button>
            </div>

            {!doctorLoading && findings.length > 0 && (
              <div className="mt-3 space-y-2">
                {findings.slice(0, 6).map((check, index) => (
                  <div key={`${check.section}:${check.id || check.name}:${index}`} className="flex items-start gap-3 rounded-lg border border-surface-800 bg-surface-950/50 p-3">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${check.status === "fail" ? "bg-red-400" : "bg-amber-400"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-surface-200">{check.name}</div>
                      <div className="mt-0.5 break-words text-xs text-surface-500">{check.detail}</div>
                    </div>
                    {check.fix && (
                      <button disabled={!!installing} onClick={() => applyDoctorFix(check)} className="shrink-0 rounded-md bg-indigo-500 px-2.5 py-1.5 text-xs text-white hover:bg-indigo-400 disabled:opacity-50">
                        {installing === (check.id || check.fix.path?.split("/").pop()) ? "Installing…" : check.fix.label}
                      </button>
                    )}
                  </div>
                ))}
                {findings.length > 6 && (
                  <div className="px-1 text-xs text-surface-500">{findings.length - 6} more findings are listed under “Show all checks”.</div>
                )}
              </div>
            )}

            {installLines.length > 0 && (
              <div className="mt-3 max-h-36 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-5 text-surface-400" aria-live="polite">
                {installLines.map((line, index) => <div key={index}>{line}</div>)}
              </div>
            )}

            {!doctorLoading && developmentChecks.length > 0 && (
              <details className="mt-3 text-xs text-surface-500">
                <summary className="cursor-pointer select-none hover:text-surface-300">Show all {developmentChecks.length} checks</summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {developmentChecks.map((check, index) => (
                    <div key={`all:${check.section}:${check.id || check.name}:${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-surface-950/40 px-2 py-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${check.status === "pass" ? "bg-emerald-400" : check.status === "fail" ? "bg-red-400" : "bg-amber-400"}`} />
                      <span className="truncate text-surface-300">{check.name}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      </section>

      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTarget()}
          placeholder="https://example.com" className="flex-1 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 placeholder-surface-500 outline-none focus:border-indigo-500" />
        <button onClick={addTarget} className="px-4 py-2 text-sm rounded-lg bg-indigo-500 text-white hover:bg-indigo-400">Add</button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-surface-500 text-sm">Loading...</div>
      ) : loadError ? (
        <div className="text-center py-8 text-sm space-y-2">
          <div className="text-surface-400">Couldn't load health targets — the agent may be unreachable.</div>
          <button onClick={loadTargets} className="text-xs px-3 py-1 rounded-md bg-surface-800 text-surface-300 hover:bg-surface-700">Retry</button>
        </div>
      ) : targets.length === 0 ? (
        <div className="text-center py-8 text-surface-500 text-sm">No health monitoring targets. Add a URL to start monitoring.</div>
      ) : (
        <div className="space-y-1">
          {targets.map((t) => (
            <div key={t.id} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3 flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${statusColor(t.status)}`} />
              <span className="flex-1 text-sm truncate">{t.url || t.name}</span>
              {t.responseTime != null && <span className="text-xs text-surface-500 font-mono">{t.responseTime}ms</span>}
              <span className="text-xs text-surface-500">{t.status || "unknown"}</span>
              <button onClick={() => deleteTarget(t.id)} className="text-surface-600 hover:text-red-400 text-xs">&#x2715;</button>
            </div>
          ))}
        </div>
      )}

      {machine && (
        <div className="mt-6">
          <h3 className="text-xs uppercase text-surface-500 font-semibold mb-2">
            Host: {machine.hostname} ({machine.os}) · last scan {machine.updatedAt?.slice(0, 19)}
          </h3>
          {machine.alerts && machine.alerts.length > 0 && (
            <div className="mb-3 rounded-lg border border-red-500/40 bg-red-900/20 p-3 space-y-1">
              {machine.alerts.map((a, i) => (
                <div key={i} className="text-xs text-red-400 font-semibold">⚠ {a}</div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            {machine.filesystems.map((f) => {
              const tone =
                f.usedPct >= 95
                  ? "bg-red-400"
                  : f.usedPct >= 85
                    ? "bg-amber-400"
                    : "bg-emerald-400";
              return (
                <div key={f.mount} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 text-sm truncate font-mono">{f.mount}</span>
                    <span className="text-xs text-surface-500">
                      {f.usedGb.toFixed(1)} / {f.totalGb.toFixed(1)} GB
                    </span>
                    <span className="text-xs font-mono">{Math.round(f.usedPct)}%</span>
                  </div>
                  <div className="mt-2 h-1 w-full bg-surface-800 rounded-full">
                    <div
                      className={`h-1 rounded-full ${tone}`}
                      style={{ width: `${Math.min(100, f.usedPct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {machine.drives.length > 0 && (
            <div className="mt-4 space-y-1">
              <h4 className="text-xs uppercase text-surface-500 font-semibold mb-1">SMART</h4>
              {machine.drives.map((d) => (
                <div key={d.device} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3 flex items-center gap-3">
                  <div
                    className={`w-2 h-2 rounded-full ${d.health === "passed" ? "bg-emerald-400" : d.health === "failing" ? "bg-red-400" : "bg-surface-500"}`}
                  />
                  <span className="flex-1 text-sm truncate">
                    <span className="font-mono">{d.device}</span>
                    {d.model && <span className="text-surface-500"> · {d.model}</span>}
                  </span>
                  {d.temperatureC != null && d.temperatureC > 0 && (
                    <span className="text-xs text-surface-500">{d.temperatureC}°C</span>
                  )}
                  <span className="text-xs font-mono uppercase">{d.health}</span>
                </div>
              ))}
            </div>
          )}

          {peers.length > 0 && (
            <div className="mt-4 space-y-1">
              <h4 className="text-xs uppercase text-surface-500 font-semibold mb-1">Peer heartbeats</h4>
              {peers.map((p) => (
                <div key={p.deviceId} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3 flex items-center gap-3">
                  <div
                    className={`w-2 h-2 rounded-full ${p.state === "online" ? "bg-emerald-400" : p.state === "offline" ? "bg-red-400" : "bg-amber-400"}`}
                  />
                  <span className="flex-1 text-sm truncate">{p.name || p.deviceId.slice(0, 8)}</span>
                  <span className="text-xs text-surface-500">{p.lastSeen?.slice(0, 19)}</span>
                  <span className="text-xs font-mono uppercase">{p.state}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
