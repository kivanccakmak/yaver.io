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

  // No device connected
  if (!isDeviceConnected) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-900 text-surface-500">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-surface-50">No device connected</h3>
          <p className="text-sm text-surface-400">
            Connect to a device from the Devices tab to manage tasks.
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
