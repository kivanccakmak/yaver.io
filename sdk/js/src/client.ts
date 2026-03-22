import type { Task, CreateTaskOptions, AgentInfo, ImageAttachment, ExecSession, ExecOptions } from './types';

/**
 * Yaver client — connects to a Yaver agent's HTTP API.
 * Works in Node.js, React Native, and browsers.
 */
export class YaverClient {
  baseURL: string;
  authToken: string;
  timeout: number;

  constructor(baseURL: string, authToken: string, timeout = 30000) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.authToken = authToken;
    this.timeout = timeout;
  }

  /** Check if the agent is reachable. */
  async health(): Promise<{ status: string }> {
    return this.get('/health');
  }

  /** Measure round-trip time in milliseconds. */
  async ping(): Promise<number> {
    const start = Date.now();
    await this.health();
    return Date.now() - start;
  }

  /** Get agent status information. */
  async info(): Promise<AgentInfo> {
    const result = await this.get<{ ok: boolean; info: AgentInfo }>('/info');
    return result.info;
  }

  /** Create a new task on the remote agent. */
  async createTask(prompt: string, opts?: CreateTaskOptions): Promise<Task> {
    const body: Record<string, unknown> = { title: prompt };
    if (opts?.model) body.model = opts.model;
    if (opts?.runner) body.runner = opts.runner;
    if (opts?.customCommand) body.customCommand = opts.customCommand;
    if (opts?.speechContext) body.speechContext = opts.speechContext;
    if (opts?.images?.length) body.images = opts.images;

    const result = await this.post<{
      ok: boolean; taskId: string; status: string; runnerId: string; error?: string;
    }>('/tasks', body);

    if (!result.ok) throw new Error(result.error || 'Failed to create task');

    return {
      id: result.taskId,
      title: prompt,
      status: result.status as Task['status'],
      runnerId: result.runnerId,
      createdAt: new Date().toISOString(),
    };
  }

  /** Get task details by ID. */
  async getTask(taskId: string): Promise<Task> {
    const result = await this.get<{ ok: boolean; task: Task }>(`/tasks/${taskId}`);
    return result.task;
  }

  /** List all tasks. */
  async listTasks(): Promise<Task[]> {
    const result = await this.get<{ ok: boolean; tasks: Task[] }>('/tasks');
    return result.tasks;
  }

  /** Stop a running task. */
  async stopTask(taskId: string): Promise<void> {
    const result = await this.post<{ ok: boolean; error?: string }>(`/tasks/${taskId}/stop`);
    if (!result.ok) throw new Error(result.error || 'Failed to stop task');
  }

  /** Delete a task. */
  async deleteTask(taskId: string): Promise<void> {
    await this.del(`/tasks/${taskId}`);
  }

  /** Send a follow-up message to a running task. */
  async continueTask(taskId: string, message: string, images?: ImageAttachment[]): Promise<void> {
    const body: Record<string, unknown> = { input: message };
    if (images?.length) body.images = images;
    const result = await this.post<{ ok: boolean; error?: string }>(
      `/tasks/${taskId}/continue`, body
    );
    if (!result.ok) throw new Error(result.error || 'Failed to continue task');
  }

  /** Clean up old tasks, images, and logs on the agent. */
  async clean(days = 30): Promise<{ tasksRemoved: number; imagesRemoved: number; bytesFreed: number }> {
    const result = await this.post<{ ok: boolean; result: { tasksRemoved: number; imagesRemoved: number; bytesFreed: number } }>(
      '/agent/clean', { days }
    );
    return result.result;
  }

  /**
   * Stream task output. Yields new output chunks as they arrive.
   * @param taskId - Task ID to stream
   * @param pollIntervalMs - Polling interval (default: 500ms)
   */
  async *streamOutput(taskId: string, pollIntervalMs = 500): AsyncGenerator<string> {
    let lastLen = 0;
    while (true) {
      const task = await this.getTask(taskId);
      const output = task.output || '';
      if (output.length > lastLen) {
        yield output.substring(lastLen);
        lastLen = output.length;
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'stopped') {
        return;
      }
      await sleep(pollIntervalMs);
    }
  }

  /** Start a command on the remote agent. */
  async startExec(command: string, opts?: ExecOptions): Promise<{ execId: string; pid: number }> {
    const body: Record<string, unknown> = { command };
    if (opts?.workDir) body.workDir = opts.workDir;
    if (opts?.timeout) body.timeout = opts.timeout;
    if (opts?.env) body.env = opts.env;
    const result = await this.post<{ ok: boolean; execId: string; pid: number; error?: string }>('/exec', body);
    if (!result.ok) throw new Error(result.error || 'Failed to start exec');
    return { execId: result.execId, pid: result.pid };
  }

  /** Get exec session details. */
  async getExec(execId: string): Promise<ExecSession> {
    const result = await this.get<{ ok: boolean; exec: ExecSession }>(`/exec/${execId}`);
    return result.exec;
  }

  /** List all exec sessions. */
  async listExecs(): Promise<ExecSession[]> {
    const result = await this.get<{ ok: boolean; execs: ExecSession[] }>('/exec');
    return result.execs;
  }

  /** Send stdin input to a running exec session. */
  async sendExecInput(execId: string, input: string): Promise<void> {
    await this.post(`/exec/${execId}/input`, { input });
  }

  /** Send a signal to a running exec session. */
  async signalExec(execId: string, signal: string): Promise<void> {
    await this.post(`/exec/${execId}/signal`, { signal });
  }

  /** Kill and remove an exec session. */
  async killExec(execId: string): Promise<void> {
    await this.del(`/exec/${execId}`);
  }

  /** Stream exec output. Yields new stdout/stderr chunks as they arrive. */
  async *streamExecOutput(execId: string, pollIntervalMs = 300): AsyncGenerator<{ type: 'stdout' | 'stderr'; text: string }> {
    let lastStdoutLen = 0;
    let lastStderrLen = 0;
    while (true) {
      const exec = await this.getExec(execId);
      if (exec.stdout.length > lastStdoutLen) {
        yield { type: 'stdout', text: exec.stdout.substring(lastStdoutLen) };
        lastStdoutLen = exec.stdout.length;
      }
      if (exec.stderr.length > lastStderrLen) {
        yield { type: 'stderr', text: exec.stderr.substring(lastStderrLen) };
        lastStderrLen = exec.stderr.length;
      }
      if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'killed') {
        return;
      }
      await sleep(pollIntervalMs);
    }
  }

  // ── HTTP helpers ─────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const resp = await fetchWithTimeout(`${this.baseURL}${path}`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    }, this.timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetchWithTimeout(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, this.timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  private async del(path: string): Promise<void> {
    const resp = await fetchWithTimeout(`${this.baseURL}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.authToken}` },
    }, this.timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
