"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { agentClient, type Task, type ConnectionState } from "@/lib/agent-client";

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-green-500";
    case "queued":
      return "bg-yellow-500";
    case "completed":
      return "bg-blue-500";
    case "failed":
      return "bg-red-500";
    case "stopped":
      return "bg-surface-500";
    default:
      return "bg-surface-600";
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function ConnectionBanner({ status }: { status: ConnectionState }) {
  if (status === "connected") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg bg-green-500/10 px-4 py-2 text-sm text-green-400">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
        Connected to agent
      </div>
    );
  }
  if (status === "connecting") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg bg-yellow-500/10 px-4 py-2 text-sm text-yellow-400">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
        Connecting to agent...
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-400">
        <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
        Connection error -- reconnecting...
      </div>
    );
  }
  return null;
}

interface TasksViewProps {
  connectionStatus: ConnectionState;
  isDeviceConnected: boolean;
}

export default function TasksView({ connectionStatus, isDeviceConnected }: TasksViewProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [outputLines, setOutputLines] = useState<Record<string, string[]>>({});
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Fetch tasks
  const fetchTasks = useCallback(async () => {
    try {
      const list = await agentClient.listTasks();
      setTasks(list);
    } catch {
      // Ignore fetch errors.
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    // Re-fetch every 5 seconds when connected
    if (connectionStatus === "connected") {
      const interval = setInterval(fetchTasks, 5000);
      return () => clearInterval(interval);
    }
  }, [connectionStatus, fetchTasks]);

  // Listen for output stream
  useEffect(() => {
    const unsub = agentClient.onOutput((taskId, line) => {
      setOutputLines((prev) => ({
        ...prev,
        [taskId]: [...(prev[taskId] || []), line],
      }));
    });
    return unsub;
  }, []);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputLines, selectedTask]);

  // Re-fetch selected task to update status
  useEffect(() => {
    if (!selectedTask || connectionStatus !== "connected") return;
    const interval = setInterval(async () => {
      try {
        const updated = await agentClient.getTask(selectedTask.id);
        setSelectedTask(updated);
      } catch {
        // Ignore.
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedTask, connectionStatus]);

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setSubmitting(true);
    try {
      const task = await agentClient.sendTask(newTitle.trim(), newDescription.trim());
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      setNewDescription("");
      setShowNewTask(false);
    } catch {
      // Could show error toast.
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop(taskId: string) {
    try {
      await agentClient.stopTask(taskId);
      fetchTasks();
    } catch {
      // Ignore.
    }
  }

  async function handleContinue(taskId: string) {
    try {
      await agentClient.continueTask(taskId);
      fetchTasks();
    } catch {
      // Ignore.
    }
  }

  async function handleDelete(taskId: string) {
    try {
      await agentClient.deleteTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      if (selectedTask?.id === taskId) setSelectedTask(null);
    } catch {
      // Ignore.
    }
  }

  // No device connected — show setup instructions
  if (!isDeviceConnected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-xl">
          <h3 className="mb-1 text-lg font-semibold text-surface-50">Get Started</h3>
          <p className="mb-6 text-sm text-surface-400">
            Install the Yaver agent on your development machine to connect.
          </p>

          {/* macOS */}
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <svg className="h-4 w-4 text-surface-400" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
              <span className="text-sm font-medium text-surface-300">macOS</span>
            </div>
            <div className="rounded-lg border border-surface-800 bg-surface-950 p-3 font-mono text-[13px]">
              <div className="text-surface-500"># Install via Homebrew</div>
              <div className="mt-1 select-all text-surface-200">brew tap kivanccakmak/yaver && brew install yaver</div>
            </div>
          </div>

          {/* Linux */}
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <svg className="h-4 w-4 text-surface-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.585.047 1.18-.13 1.683-.529.355.21.757.315 1.152.315.694 0 1.37-.395 1.725-.967.312-.5.437-1.009.662-1.457.147-.292.309-.568.465-.824a1.4 1.4 0 00.107-.163c.152-.243.313-.506.407-.825.13-.433.155-.883.101-1.299-.054-.414-.166-.844-.37-1.228a1.67 1.67 0 00-.32-.384c-.06-.054-.12-.1-.181-.14.01-.036.013-.075.023-.11.2-.58.287-1.205.087-1.845-.201-.645-.66-1.215-1.24-1.655-.592-.442-1.29-.755-1.838-1.195-.382-.308-.664-.616-.87-1.02-.107-.209-.188-.43-.25-.665a3.05 3.05 0 01-.098-.78c.002-.397.078-.784.184-1.167.206-.74.478-1.456.637-2.28.17-.892.163-1.87-.134-2.812-.297-.937-.871-1.782-1.745-2.344C14.554.207 13.573 0 12.504 0z"/></svg>
              <span className="text-sm font-medium text-surface-300">Linux</span>
            </div>
            <div className="rounded-lg border border-surface-800 bg-surface-950 p-3 font-mono text-[13px]">
              <div className="text-surface-500"># Download latest binary</div>
              <div className="mt-1 select-all text-surface-200">curl -fsSL https://yaver.io/install.sh | bash</div>
            </div>
          </div>

          {/* Then authenticate */}
          <div className="mt-6">
            <div className="mb-2 flex items-center gap-2">
              <svg className="h-4 w-4 text-surface-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
              </svg>
              <span className="text-sm font-medium text-surface-300">Then authenticate & start</span>
            </div>
            <div className="rounded-lg border border-surface-800 bg-surface-950 p-3 font-mono text-[13px]">
              <div className="select-all text-surface-200">yaver auth</div>
              <div className="mt-1 select-all text-surface-200">yaver serve</div>
            </div>
          </div>

          <p className="mt-6 text-xs text-surface-500">
            Once the agent is running, your device will appear in the Devices tab.
          </p>
        </div>
      </div>
    );
  }

  const currentOutput = selectedTask ? [...(selectedTask.output || []), ...(outputLines[selectedTask.id] || [])] : [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ConnectionBanner status={connectionStatus} />

      <div className="flex flex-1 overflow-hidden">
        {/* Task list */}
        <div className="flex w-full flex-col overflow-hidden lg:w-1/2 lg:border-r lg:border-surface-800">
          <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
            <h2 className="text-lg font-semibold text-surface-50">Tasks</h2>
            <button
              onClick={() => setShowNewTask(!showNewTask)}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              {showNewTask ? "Cancel" : "New Task"}
            </button>
          </div>

          {showNewTask && (
            <form onSubmit={handleCreateTask} className="border-b border-surface-800 p-4">
              <input
                type="text"
                placeholder="Task title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="mb-2 w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-200 placeholder-surface-500 outline-none focus:border-surface-600"
              />
              <textarea
                placeholder="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                rows={3}
                className="mb-3 w-full resize-none rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-200 placeholder-surface-500 outline-none focus:border-surface-600"
              />
              <button
                type="submit"
                disabled={submitting || !newTitle.trim()}
                className="btn-primary w-full px-3 py-2 text-sm disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Create Task"}
              </button>
            </form>
          )}

          <div className="flex-1 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm text-surface-400">No tasks yet.</p>
                <p className="mt-1 text-xs text-surface-500">
                  Create a new task to get started.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-surface-800">
                {tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTask(task)}
                    className={`w-full px-4 py-3 text-left transition-colors hover:bg-surface-900 ${
                      selectedTask?.id === task.id ? "bg-surface-900" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="truncate text-sm font-medium text-surface-50">
                        {task.title}
                      </h3>
                      <div className="ml-2 flex items-center gap-1.5">
                        <span className={`inline-block h-2 w-2 rounded-full ${statusColor(task.status)}`} />
                        <span className="whitespace-nowrap text-xs text-surface-500">
                          {statusLabel(task.status)}
                        </span>
                      </div>
                    </div>
                    {task.description && (
                      <p className="mt-1 truncate text-xs text-surface-400">
                        {task.description}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-surface-500">
                      {formatRelativeTime(task.updatedAt || task.createdAt)}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Task detail */}
        <div className="hidden flex-1 flex-col overflow-hidden lg:flex">
          {selectedTask ? (
            <>
              <div className="border-b border-surface-800 p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold text-surface-50">
                      {selectedTask.title}
                    </h3>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${statusColor(selectedTask.status)}`} />
                      <span className="text-sm text-surface-400">
                        {statusLabel(selectedTask.status)}
                      </span>
                      <span className="text-xs text-surface-500">
                        {formatRelativeTime(selectedTask.updatedAt || selectedTask.createdAt)}
                      </span>
                    </div>
                    {selectedTask.description && (
                      <p className="mt-2 text-sm text-surface-400">
                        {selectedTask.description}
                      </p>
                    )}
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    {selectedTask.status === "running" && (
                      <button
                        onClick={() => handleStop(selectedTask.id)}
                        className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
                      >
                        Stop
                      </button>
                    )}
                    {(selectedTask.status === "stopped" || selectedTask.status === "queued") && (
                      <button
                        onClick={() => handleContinue(selectedTask.id)}
                        className="rounded-lg border border-green-500/30 px-3 py-1.5 text-xs text-green-400 transition-colors hover:bg-green-500/10"
                      >
                        Continue
                      </button>
                    )}
                    {(selectedTask.status === "completed" || selectedTask.status === "failed") && (
                      <button
                        onClick={() => handleDelete(selectedTask.id)}
                        className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-surface-400 transition-colors hover:border-red-500/30 hover:text-red-400"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Output stream */}
              <div className="flex-1 overflow-hidden p-4">
                <div className="flex h-full flex-col rounded-xl border border-surface-700 bg-surface-950">
                  <div className="flex items-center gap-2 border-b border-surface-800 px-4 py-2.5">
                    <span className="h-3 w-3 rounded-full bg-red-500" />
                    <span className="h-3 w-3 rounded-full bg-yellow-500" />
                    <span className="h-3 w-3 rounded-full bg-green-500" />
                    <span className="ml-2 text-xs text-surface-500">Output</span>
                  </div>
                  <div
                    ref={outputRef}
                    className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-surface-300"
                  >
                    {currentOutput.length === 0 ? (
                      <span className="text-surface-500">
                        {selectedTask.status === "queued"
                          ? "Waiting for execution..."
                          : "No output yet."}
                      </span>
                    ) : (
                      currentOutput.map((line, i) => (
                        <div key={i} className="whitespace-pre-wrap break-all">
                          {line}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-surface-500">
                Select a task to view details.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
