/**
 * Embeddable Dogfood orchestration for React Native hosts.
 *
 * The SDK deliberately does not own the host's button, WebView, navigation, or
 * Yaver transport. It owns the failure-prone lifecycle underneath them:
 * explicit trigger -> prepare -> start -> ready, bounded log retention,
 * generation-safe Retry, and deterministic cleanup of partial sessions.
 *
 * Yaver mobile uses this class for Yaver-on-Yaver. Third-party apps use the
 * same class with their own project descriptor and a driver backed by
 * P2PClient (or another authenticated Yaver transport).
 */

export type DogfoodLane = 'browser' | 'hermes' | 'webrtc';
export type DogfoodPhase =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'compiling'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface DogfoodProject {
  name: string;
  workDir: string;
  framework: string;
  lane: DogfoodLane;
  /** Optional source URL for drivers that can clone missing source. */
  repositoryUrl?: string;
  /** Optional native target from /remote-runtime/capabilities for WebRTC. */
  nativeTargetId?: string;
}

export interface DogfoodLaneOption {
  lane: DogfoodLane;
  label: string;
  supported: boolean;
  default: boolean;
  reason?: string;
}

/** One framework-to-lane matrix for Yaver and third-party consumers. */
export function dogfoodLaneOptions(
  framework: string,
  capabilities: {
    nativeRuntimeAvailable?: boolean;
    browserRuntimeAvailable?: boolean;
    selfDevelopment?: boolean;
  } = {},
): DogfoodLaneOption[] {
  const normalized = String(framework || '').trim().toLowerCase();
  const reactNative = normalized === 'expo' || normalized === 'react-native';
  // The framework matrix is the safe default. A positively detected browser
  // target may add an exception (for example SwiftWasm/Tokamak), but a missing
  // browser binary must not incorrectly remove RN/Flutter's browser build lane.
  const browserCapable = capabilities.browserRuntimeAvailable === true || reactNative || [
    'flutter', 'web', 'next', 'nextjs', 'vite', 'remix', 'svelte', 'vue', 'angular',
  ].includes(normalized);
  const nativeAvailable = capabilities.nativeRuntimeAvailable === true;
  const hermesReason = reactNative
    ? undefined
    : 'Hermes is available only for Expo and React Native projects.';
  const browserReason = browserCapable
    ? undefined
    : 'The browser lane is available for browser-capable projects such as React Native, Expo, Flutter, and web apps.';
  return [
    { lane: 'browser', label: 'Browser lane', supported: browserCapable, default: browserCapable, reason: browserReason },
    { lane: 'hermes', label: 'Hermes', supported: !hermesReason, default: false, reason: hermesReason },
    {
      lane: 'webrtc', label: 'WebRTC native', supported: nativeAvailable, default: false,
      reason: nativeAvailable ? undefined : 'No native simulator, emulator, or device runtime is available on this machine.',
    },
  ];
}

export function defaultDogfoodLane(
  framework: string,
  capabilities: {
    nativeRuntimeAvailable?: boolean;
    browserRuntimeAvailable?: boolean;
    selfDevelopment?: boolean;
  } = {},
): DogfoodLane {
  const options = dogfoodLaneOptions(framework, capabilities);
  return options.find((option) => option.default && option.supported)?.lane
    || options.find((option) => option.supported)?.lane
    || 'browser';
}

export interface DogfoodLogLine {
  text: string;
  at: number;
  stream?: 'stdout' | 'stderr' | 'system';
}

export interface DogfoodFailure {
  code: string;
  error: string;
  remedy: string;
  retryable: boolean;
  fixPrompt?: string;
}

export interface DogfoodResult {
  lane: DogfoodLane;
  url?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface DogfoodSnapshot {
  phase: DogfoodPhase;
  attempt: number;
  project: DogfoodProject;
  message: string;
  logs: readonly DogfoodLogLine[];
  startedAt?: number;
  lastOutputAt?: number;
  result?: DogfoodResult;
  failure?: DogfoodFailure;
}

export interface DogfoodRunContext {
  project: DogfoodProject;
  attempt: number;
  /** Raw package-manager/compiler output. ANSI is intentionally preserved. */
  log(line: string | DogfoodLogLine): void;
  setPhase(phase: Extract<DogfoodPhase, 'preparing' | 'starting' | 'compiling'>, message: string): void;
  /**
   * Register cleanup immediately after acquiring a resource.
   *
   * `session` cleanups run on failure/stop. `transient` cleanups also run when
   * ownership is handed to another screen (normally an SSE subscription).
   */
  registerCleanup(cleanup: () => void | Promise<void>, scope?: 'session' | 'transient'): void;
  isCurrent(): boolean;
}

export interface DogfoodDriver {
  prepare?(context: DogfoodRunContext): Promise<void>;
  start(context: DogfoodRunContext): Promise<DogfoodResult>;
}

export interface DogfoodControllerOptions {
  maxLogLines?: number;
  onChange?: (snapshot: DogfoodSnapshot) => void;
}

export class DogfoodRuntimeError extends Error {
  readonly failure: DogfoodFailure;

  constructor(failure: DogfoodFailure) {
    super(failure.error);
    this.name = 'DogfoodRuntimeError';
    this.failure = failure;
  }
}

type Cleanup = { fn: () => void | Promise<void>; scope: 'session' | 'transient' };

export function validateDogfoodProject(project: DogfoodProject): DogfoodFailure | null {
  const framework = String(project.framework || '').trim().toLowerCase();
  if (!String(project.workDir || '').trim()) {
    return {
      code: 'DOGFOOD_PROJECT_PATH_REQUIRED',
      error: 'Dogfood needs the project directory on the selected machine.',
      remedy: 'Choose or clone the project source, then trigger Dogfood again.',
      retryable: false,
    };
  }
  if (project.lane === 'hermes' && framework !== 'expo' && framework !== 'react-native') {
    return {
      code: 'DOGFOOD_HERMES_FRAMEWORK_UNSUPPORTED',
      error: `Hermes cannot run a ${framework || 'non-React-Native'} project.`,
      remedy: framework === 'flutter'
        ? 'Use the browser lane (Flutter web) or WebRTC for a native Flutter runtime.'
        : 'Use the browser or WebRTC lane, or select an Expo/React Native project.',
      retryable: false,
    };
  }
  return null;
}

/** Convert one /dev/events frame into console lines without hiding raw output. */
export function runtimeLogLinesFromDevEvent(event: any): string[] {
  if (!event || typeof event !== 'object') return [];
  if (event.type === 'log' && typeof event.logLine === 'string') {
    return event.logLine.trimEnd() ? [event.logLine.trimEnd()] : [];
  }
  if (event.type === 'snapshot' && Array.isArray(event.snapshot?.recentLogs)) {
    return event.snapshot.recentLogs
      .map((line: unknown) => String(line).trimEnd())
      .filter(Boolean);
  }
  if (event.type === 'progress' || event.type === 'phase') {
    const phase = typeof event.phase === 'string' ? event.phase.replace(/_/g, ' ') : 'working';
    const pct = typeof event.pct === 'number' ? ` ${Math.round(event.pct)}%` : '';
    const file = typeof event.currentFile === 'string' && event.currentFile
      ? ` · ${String(event.currentFile).split('/').slice(-2).join('/')}`
      : '';
    return [`${phase}${pct}${file}`.trim()];
  }
  if (event.type === 'error') {
    return String(event.message || 'Dev server failed')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
  }
  if (typeof event.message === 'string' && event.message.trim() &&
      ['starting', 'building', 'phase', 'ready', 'reload', 'stopped'].includes(String(event.type))) {
    return [event.message.trimEnd()];
  }
  return [];
}

/** Backwards-friendly name for consumers that discovered this via Dogfood. */
export const dogfoodLogLinesFromDevEvent = runtimeLogLinesFromDevEvent;

function failureFrom(error: unknown): DogfoodFailure {
  if (error instanceof DogfoodRuntimeError) return error.failure;
  const candidate = error as Partial<DogfoodFailure> | undefined;
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'DOGFOOD_START_FAILED',
    error: error instanceof Error ? error.message : String(error || 'Dogfood could not start.'),
    remedy: typeof candidate?.remedy === 'string'
      ? candidate.remedy
      : 'Fix the named project or runtime failure, then retry Dogfood.',
    retryable: candidate?.retryable !== false,
    fixPrompt: typeof candidate?.fixPrompt === 'string' ? candidate.fixPrompt : undefined,
  };
}

export class DogfoodController {
  readonly project: DogfoodProject;
  private readonly driver: DogfoodDriver;
  private generation = 0;
  // Cleanup ownership is per attempt. An old async attempt may finish after
  // Stop + Retry has already acquired a new runtime; a shared list lets that
  // obsolete attempt tear down the newer session. Generation-keyed ownership
  // makes that race impossible while keeping Stop able to release everything.
  private cleanups = new Map<number, Cleanup[]>();
  private runPromise: Promise<DogfoodResult> | null = null;
  private readonly maxLogLines: number;
  private readonly onChange?: (snapshot: DogfoodSnapshot) => void;
  private state: DogfoodSnapshot;

  constructor(
    project: DogfoodProject,
    driver: DogfoodDriver,
    options: DogfoodControllerOptions = {},
  ) {
    this.project = project;
    this.driver = driver;
    this.maxLogLines = Math.max(20, options.maxLogLines ?? 200);
    this.onChange = options.onChange;
    this.state = { phase: 'idle', attempt: 0, project, message: 'Ready to dogfood', logs: [] };
  }

  snapshot(): DogfoodSnapshot {
    return { ...this.state, logs: [...this.state.logs] };
  }

  /** Nothing starts until the host calls this method from its explicit action. */
  trigger(): Promise<DogfoodResult> {
    if (this.runPromise) return this.runPromise;
    const promise = this.run();
    this.runPromise = promise;
    void promise.finally(() => {
      if (this.runPromise === promise) this.runPromise = null;
    }).catch(() => {});
    return promise;
  }

  retry(): Promise<DogfoodResult> {
    return this.trigger();
  }

  private async run(): Promise<DogfoodResult> {
    const generation = ++this.generation;
    const attempt = this.state.attempt + 1;
    await this.runCleanups('all');
    const invalid = validateDogfoodProject(this.project);
    if (invalid) {
      this.replace({ phase: 'failed', attempt, project: this.project, message: invalid.error, logs: [], failure: invalid });
      throw new DogfoodRuntimeError(invalid);
    }
    this.replace({
      phase: 'preparing', attempt, project: this.project,
      message: `Preparing ${this.project.name}…`, logs: [], startedAt: Date.now(),
    });

    const context: DogfoodRunContext = {
      project: this.project,
      attempt,
      log: (line) => {
        if (generation !== this.generation) return;
        const entry: DogfoodLogLine = typeof line === 'string'
          ? { text: line, at: Date.now(), stream: 'stdout' }
          : { ...line, at: line.at || Date.now() };
        if (!entry.text.trim()) return;
        const logs = [...this.state.logs, entry].slice(-this.maxLogLines);
        this.replace({ ...this.state, logs, lastOutputAt: entry.at });
      },
      setPhase: (phase, message) => {
        if (generation === this.generation) this.replace({ ...this.state, phase, message });
      },
      registerCleanup: (cleanup, scope = 'session') => {
        if (generation !== this.generation) {
          void Promise.resolve(cleanup()).catch(() => {});
          return;
        }
        const owned = this.cleanups.get(generation) || [];
        owned.push({ fn: cleanup, scope });
        this.cleanups.set(generation, owned);
      },
      isCurrent: () => generation === this.generation,
    };

    try {
      await this.driver.prepare?.(context);
      if (!context.isCurrent()) throw new DogfoodRuntimeError({
        code: 'DOGFOOD_ATTEMPT_REPLACED', error: 'A newer Dogfood attempt replaced this one.',
        remedy: 'Wait for the newer attempt.', retryable: true,
      });
      context.setPhase('starting', `Starting ${this.project.name} on the ${this.project.lane} lane…`);
      const result = await this.driver.start(context);
      if (!context.isCurrent()) {
        await this.runCleanups('all', generation);
        throw new DogfoodRuntimeError({
          code: 'DOGFOOD_ATTEMPT_REPLACED', error: 'A newer Dogfood attempt replaced this one.',
          remedy: 'Wait for the newer attempt.', retryable: true,
        });
      }
      this.replace({ ...this.state, phase: 'ready', message: `${this.project.name} is ready`, result, failure: undefined });
      return result;
    } catch (error) {
      const failure = failureFrom(error);
      await this.runCleanups('all', generation);
      if (generation === this.generation) {
        this.replace({ ...this.state, phase: 'failed', message: failure.error, failure, result: undefined });
      }
      throw error instanceof DogfoodRuntimeError ? error : new DogfoodRuntimeError(failure);
    }
  }

  /** Stop the active/partial run and release every resource. Idempotent. */
  async stop(): Promise<void> {
    ++this.generation;
    this.runPromise = null;
    this.replace({ ...this.state, phase: 'stopping', message: `Stopping ${this.project.name}…` });
    await this.runCleanups('all');
    this.replace({ ...this.state, phase: 'stopped', message: `${this.project.name} stopped`, result: undefined });
  }

  /**
   * Transfer the live session to a host-owned preview screen. Stream/timer
   * cleanups run; session cleanup is discarded because the receiving screen
   * now owns it.
   */
  async handoff(): Promise<DogfoodResult | undefined> {
    if (this.state.phase !== 'ready') return undefined;
    await this.runCleanups('transient', this.generation);
    // The receiving screen now owns the live session. Forget its session
    // cleanup without touching cleanups belonging to any other generation.
    this.cleanups.delete(this.generation);
    return this.state.result;
  }

  private async runCleanups(which: 'all' | 'transient', generation?: number): Promise<void> {
    const generations = generation === undefined ? [...this.cleanups.keys()] : [generation];
    const selected: Cleanup[] = [];
    for (const key of generations) {
      const owned = this.cleanups.get(key) || [];
      selected.push(...(which === 'all' ? owned : owned.filter((item) => item.scope === 'transient')));
      const retained = which === 'all' ? [] : owned.filter((item) => item.scope !== 'transient');
      if (retained.length) this.cleanups.set(key, retained);
      else this.cleanups.delete(key);
    }
    for (const cleanup of selected.reverse()) {
      try { await cleanup.fn(); } catch { /* cleanup is best-effort but never skipped */ }
    }
  }

  private replace(next: DogfoodSnapshot): void {
    this.state = next;
    this.onChange?.(this.snapshot());
  }
}
