/**
 * QUIC client for P2P communication with the desktop agent.
 *
 * This is a placeholder implementation that uses HTTP as a fallback
 * transport until a native QUIC module is available for React Native.
 * The public API mirrors what the real QUIC transport will expose.
 */

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  output: string[];
  createdAt: number;
  updatedAt: number;
}

export type OutputCallback = (taskId: string, line: string) => void;

export class QuicClient {
  private host: string | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private connected = false;
  private outputListeners: OutputCallback[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Establish a connection to the desktop agent.
   * Currently uses HTTP; will be replaced with QUIC when native module is ready.
   */
  async connect(host: string, port: number, token: string): Promise<void> {
    this.host = host;
    this.port = port;
    this.token = token;

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.authHeaders,
      });
      if (!res.ok) throw new Error(`Agent responded with ${res.status}`);
      this.connected = true;
      this.startPolling();
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  /** Send a new task to the desktop agent. */
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

  /** List all tasks from the desktop agent. */
  async listTasks(): Promise<Task[]> {
    this.assertConnected();
    const res = await fetch(`${this.baseUrl}/tasks`, {
      headers: this.authHeaders,
    });
    if (!res.ok) throw new Error(`Failed to list tasks: ${res.status}`);
    return (await res.json()) as Task[];
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

  /** Register a listener for streaming output. */
  onOutput(callback: OutputCallback): () => void {
    this.outputListeners.push(callback);
    return () => {
      this.outputListeners = this.outputListeners.filter((cb) => cb !== callback);
    };
  }

  /** Close the connection. */
  disconnect(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    this.host = null;
    this.port = null;
    this.token = null;
    this.outputListeners = [];
  }

  // ── private helpers ──────────────────────────────────────────────

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("QuicClient is not connected. Call connect() first.");
    }
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
        const updates = (await res.json()) as Array<{ taskId: string; line: string }>;
        for (const u of updates) {
          for (const cb of this.outputListeners) {
            cb(u.taskId, u.line);
          }
        }
      } catch {
        // Polling failure is non-fatal; we'll retry next tick.
      }
    }, 2000);
  }
}

/** Singleton client instance. */
export const quicClient = new QuicClient();
