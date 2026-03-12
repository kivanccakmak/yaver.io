/**
 * QUIC client for P2P communication with the desktop agent.
 *
 * This is a placeholder implementation that uses HTTP as a fallback
 * transport until a native QUIC module is available for React Native.
 * The public API mirrors what the real QUIC transport will expose.
 *
 * Improvements over the initial version:
 * - EventEmitter-style output streaming with typed events
 * - Automatic reconnection with exponential backoff
 * - Observable connection state (disconnected | connecting | connected | error)
 * - Local task + output cache via AsyncStorage for offline / P2P sync
 */

import { cacheTaskList, cacheTaskOutput, getCachedTaskList } from "./storage";

// ── Types ────────────────────────────────────────────────────────────

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  output: string[];
  createdAt: number;
  updatedAt: number;
  /** Name of the device this task is executing on. */
  deviceName?: string;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type OutputCallback = (taskId: string, line: string) => void;
export type ConnectionStateCallback = (state: ConnectionState) => void;

type EventMap = {
  output: OutputCallback;
  connectionState: ConnectionStateCallback;
};

type EventName = keyof EventMap;

// ── Client ───────────────────────────────────────────────────────────

export class QuicClient {
  private host: string | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // Reconnection
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempt = 8;
  private readonly baseBackoffMs = 1000;

  // Event listeners
  private listeners: { [K in EventName]: Array<EventMap[K]> } = {
    output: [],
    connectionState: [],
  };

  // ── Public getters ─────────────────────────────────────────────────

  get isConnected(): boolean {
    return this._connectionState === "connected";
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  // ── Connection lifecycle ───────────────────────────────────────────

  /**
   * Establish a connection to the desktop agent.
   * Currently uses HTTP; will be replaced with QUIC when native module is ready.
   */
  async connect(host: string, port: number, token: string): Promise<void> {
    this.host = host;
    this.port = port;
    this.token = token;
    this.reconnectAttempt = 0;

    await this.attemptConnect();
  }

  /** Close the connection and stop all timers. */
  disconnect(): void {
    this.clearTimers();
    this.setConnectionState("disconnected");
    this.host = null;
    this.port = null;
    this.token = null;
    this.listeners = { output: [], connectionState: [] };
  }

  // ── Task API ───────────────────────────────────────────────────────

  /** Send a new task to the desktop agent. */
  async sendTask(title: string, description: string): Promise<Task> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks`, {
      method: "POST",
      headers: { ...this.authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
    const task = (await res.json()) as Task;
    return task;
  }

  /** List all tasks from the desktop agent, falling back to cache on failure. */
  async listTasks(): Promise<Task[]> {
    if (!this.isConnected) {
      // Return cached data when offline
      return getCachedTaskList();
    }
    try {
      const res = await fetch(`${this.baseUrl}/tasks`, {
        headers: this.authHeaders,
      });
      if (!res.ok) throw new Error(`Failed to list tasks: ${res.status}`);
      const tasks = (await res.json()) as Task[];
      // Persist to local cache for offline access
      cacheTaskList(tasks);
      return tasks;
    } catch {
      // Network error — serve from cache
      return getCachedTaskList();
    }
  }

  /** Get a single task by ID. */
  async getTask(taskId: string): Promise<Task> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to get task: ${res.status}`);
    return (await res.json()) as Task;
  }

  /** Stop a running task. */
  async stopTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/stop`, {
      method: "POST",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to stop task: ${res.status}`);
  }

  /** Continue / resume a stopped or queued task. */
  async continueTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/continue`, {
      method: "POST",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to continue task: ${res.status}`);
  }

  /** Delete a completed or failed task. */
  async deleteTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      method: "DELETE",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to delete task: ${res.status}`);
  }

  // ── EventEmitter ───────────────────────────────────────────────────

  /** Register a listener for output lines. Returns an unsubscribe function. */
  on(event: "output", callback: OutputCallback): () => void;
  /** Register a listener for connection state changes. */
  on(event: "connectionState", callback: ConnectionStateCallback): () => void;
  on<E extends EventName>(event: E, callback: EventMap[E]): () => void {
    (this.listeners[event] as Array<EventMap[E]>).push(callback);
    return () => {
      const arr = this.listeners[event] as Array<EventMap[E]>;
      this.listeners[event] = arr.filter((cb) => cb !== callback) as typeof arr;
    };
  }

  /**
   * Legacy helper — identical to `on("output", callback)`.
   * Kept for backward compatibility with existing code.
   */
  onOutput(callback: OutputCallback): () => void {
    return this.on("output", callback);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private assertConnected(): void {
    if (!this.isConnected) {
      throw new Error("QuicClient is not connected. Call connect() first.");
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    for (const cb of this.listeners.connectionState) {
      try {
        cb(state);
      } catch {
        // Listener errors should not break the client.
      }
    }
  }

  private emit(event: "output", taskId: string, line: string): void {
    for (const cb of this.listeners.output) {
      try {
        cb(taskId, line);
      } catch {
        // Listener errors should not break the client.
      }
    }
  }

  private clearTimers(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Connection + reconnection ──────────────────────────────────────

  private async attemptConnect(): Promise<void> {
    this.setConnectionState("connecting");
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.authHeaders,
      });
      if (!res.ok) throw new Error(`Agent responded with ${res.status}`);
      this.reconnectAttempt = 0;
      this.setConnectionState("connected");
      this.startPolling();
    } catch (err) {
      this.setConnectionState("error");
      this.scheduleReconnect();
      // Only throw on the initial connect call (attempt 0)
      if (this.reconnectAttempt === 0) {
        this.reconnectAttempt = 1;
        throw err;
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.host || !this.port || !this.token) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempt) return;

    const delay = Math.min(
      this.baseBackoffMs * Math.pow(2, this.reconnectAttempt),
      30_000
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect().catch(() => {
        // Reconnection failure is handled inside attemptConnect.
      });
    }, delay);
  }

  /**
   * Poll the agent for new output lines.
   * This is a temporary mechanism; the real QUIC transport will push
   * output over a dedicated unidirectional stream.
   */
  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${this.baseUrl}/tasks/output/stream`, {
          headers: this.authHeaders,
        });
        if (!res.ok) return;
        const updates = (await res.json()) as Array<{
          taskId: string;
          line: string;
        }>;
        // Group output by task for caching
        const outputByTask = new Map<string, string[]>();
        for (const u of updates) {
          this.emit("output", u.taskId, u.line);
          if (!outputByTask.has(u.taskId)) {
            outputByTask.set(u.taskId, []);
          }
          outputByTask.get(u.taskId)!.push(u.line);
        }
        // Persist output to local cache
        for (const [taskId, lines] of outputByTask) {
          cacheTaskOutput(taskId, lines);
        }
      } catch {
        // Polling failure — check if connection is lost
        this.setConnectionState("error");
        this.clearTimers();
        this.scheduleReconnect();
      }
    }, 2000);
  }
}

/** Singleton client instance. */
export const quicClient = new QuicClient();
