/**
 * Browser-compatible agent client for P2P communication with the desktop agent.
 *
 * Mirrors the mobile QuicClient API but runs in the browser using fetch().
 * Uses HTTP as the transport (same fallback path as mobile).
 */

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

class AgentClient {
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

  async connect(host: string, port: number, token: string): Promise<void> {
    this.host = host;
    this.port = port;
    this.token = token;
    this.reconnectAttempt = 0;

    await this.attemptConnect();
  }

  disconnect(): void {
    this.clearTimers();
    this.setConnectionState("disconnected");
    this.host = null;
    this.port = null;
    this.token = null;
  }

  // ── Task API ───────────────────────────────────────────────────────

  async sendTask(title: string, description: string): Promise<Task> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks`, {
      method: "POST",
      headers: { ...this.authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
    return (await res.json()) as Task;
  }

  async listTasks(): Promise<Task[]> {
    if (!this.isConnected) {
      return this.getCachedTasks();
    }
    try {
      const res = await fetch(`${this.baseUrl}/tasks`, {
        headers: this.authHeaders,
      });
      if (!res.ok) throw new Error(`Failed to list tasks: ${res.status}`);
      const tasks = (await res.json()) as Task[];
      this.cacheTasks(tasks);
      return tasks;
    } catch {
      return this.getCachedTasks();
    }
  }

  async getTask(taskId: string): Promise<Task> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to get task: ${res.status}`);
    return (await res.json()) as Task;
  }

  async stopTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/stop`, {
      method: "POST",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to stop task: ${res.status}`);
  }

  async continueTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/continue`, {
      method: "POST",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to continue task: ${res.status}`);
  }

  async deleteTask(taskId: string): Promise<void> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      method: "DELETE",
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to delete task: ${res.status}`);
  }

  // ── EventEmitter ───────────────────────────────────────────────────

  on(event: "output", callback: OutputCallback): () => void;
  on(event: "connectionState", callback: ConnectionStateCallback): () => void;
  on<E extends EventName>(event: E, callback: EventMap[E]): () => void {
    (this.listeners[event] as Array<EventMap[E]>).push(callback);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = this.listeners[event] as any[];
      (this.listeners as any)[event] = arr.filter((cb: any) => cb !== callback);
    };
  }

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
      throw new Error("AgentClient is not connected. Call connect() first.");
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
      30_000,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect().catch(() => {
        // Reconnection failure is handled inside attemptConnect.
      });
    }, delay);
  }

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
        for (const u of updates) {
          this.emit("output", u.taskId, u.line);
        }
      } catch {
        this.setConnectionState("error");
        this.clearTimers();
        this.scheduleReconnect();
      }
    }, 2000);
  }

  // ── Local cache (localStorage) ─────────────────────────────────────

  private cacheTasks(tasks: Task[]): void {
    try {
      localStorage.setItem("yaver_cached_tasks", JSON.stringify(tasks));
    } catch {
      // localStorage may be unavailable.
    }
  }

  private getCachedTasks(): Task[] {
    try {
      const raw = localStorage.getItem("yaver_cached_tasks");
      return raw ? (JSON.parse(raw) as Task[]) : [];
    } catch {
      return [];
    }
  }
}

/** Singleton client instance. */
export const agentClient = new AgentClient();
