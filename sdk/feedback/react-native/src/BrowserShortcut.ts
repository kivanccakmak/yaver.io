/**
 * Reusable browser-shortcut export state machine.
 *
 * Yaver Mobile and third-party Feedback SDK apps use this exact controller.
 * The UI may animate snapshots, but it may never advance a phase on a timer:
 * every transition below follows a completed agent operation.
 */

export type BrowserShortcutPhase =
  | 'idle'
  | 'checking'
  | 'building'
  | 'publishing'
  | 'verifying'
  | 'ready'
  | 'blocked'
  | 'failed';

export type BrowserShortcutStep = 'connection' | 'build' | 'publish' | 'verify';

export interface BrowserShortcutBrand {
  displayName: string;
  shortName?: string;
  themeColor?: string;
  backgroundColor?: string;
}

export interface BrowserShortcutRequest {
  appId: string;
  projectPath: string;
  /** Optional dedicated origin, e.g. https://sfmg-preview.example.com. */
  publicOrigin?: string;
  /** Optional Yaver relay name. When both fields are absent, the agent safely derives one. */
  relaySubdomain?: string;
  /** Auto selects static web for Expo/Flutter and a remote runtime for Swift/Kotlin. */
  mode?: 'auto' | 'static-web' | 'remote-runtime';
  /** Optional explicit runtime target; normally ios-simulator or android-emulator. */
  runtimeTargetId?: string;
  brand: BrowserShortcutBrand;
  buildMode?: 'fast' | 'full';
}

export interface BrowserShortcutPreflight {
  ok: boolean;
  code: string;
  message: string;
  remedy?: string;
  framework?: string;
  buildTarget?: string;
  appId?: string;
  slug?: string;
  projectPath?: string;
  publicOrigin?: string;
  relaySubdomain?: string;
  mode?: 'static-web' | 'remote-runtime';
  runtimeTargetId?: string;
  brand?: BrowserShortcutBrand;
}

export interface BrowserShortcutBuildResult {
  ok: boolean;
  status?: string;
  bundleUrl?: string;
  size?: number;
  fileCount?: number;
  error?: string;
  code?: string;
  route?: BrowserShortcutFixRoute;
}

export interface BrowserShortcutFixRoute {
  method: string;
  path: string;
  stream?: string;
}

export interface BrowserShortcutRelease {
  version: number;
  appId: string;
  slug: string;
  releaseId: string;
  publicOrigin: string;
  mode: 'static-web' | 'remote-runtime';
  framework: string;
  runtimeTargetId?: string;
  installUrl: string;
  projectPath?: string;
  sourceHead?: string;
  builtAt?: string;
  publishedAt: string;
  size: number;
  fileCount: number;
  brand: BrowserShortcutBrand;
}

export interface BrowserShortcutEnrollment {
  id: string;
  code: string;
  createdAt: string;
}

export interface BrowserShortcutSnapshot {
  phase: BrowserShortcutPhase;
  /** The operation currently running, or the operation that just failed. */
  activeStep?: BrowserShortcutStep;
  message: string;
  progress: number;
  code?: string;
  remedy?: string;
  route?: BrowserShortcutFixRoute;
  release?: BrowserShortcutRelease;
}

export interface BrowserShortcutDriver {
  preflightBrowserShortcut(request: BrowserShortcutRequest, signal?: AbortSignal): Promise<BrowserShortcutPreflight>;
  buildBrowserShortcut(request: BrowserShortcutRequest, signal?: AbortSignal): Promise<BrowserShortcutBuildResult>;
  publishBrowserShortcut(request: BrowserShortcutRequest, signal?: AbortSignal): Promise<BrowserShortcutRelease>;
  verifyBrowserShortcut(release: BrowserShortcutRelease, signal?: AbortSignal): Promise<boolean>;
}

export async function verifyBrowserShortcutAssets(
  release: BrowserShortcutRelease,
  request: (url: string) => Promise<Response>,
): Promise<boolean> {
  const base = release.installUrl.replace(/\/+$/, '');
  try {
    const root = await request(release.installUrl);
    if (!root.ok) return false;
    const html = await root.text();
    if (!html.includes('manifest.webmanifest')) return false;

    const manifestResponse = await request(`${base}/manifest.webmanifest`);
    if (!manifestResponse.ok) return false;
    const manifest = await manifestResponse.json().catch(() => null) as { start_url?: string; display?: string } | null;
    if (!manifest?.start_url || manifest.display !== 'standalone') return false;

    const workerResponse = await request(`${base}/sw.js`);
    if (!workerResponse.ok || !(await workerResponse.text()).includes("addEventListener('fetch'")) return false;

    if (release.mode === 'remote-runtime') {
      const runtimeResponse = await request(`${base}/runtime.js`);
      if (!runtimeResponse.ok) return false;
      const runtime = await runtimeResponse.text();
      if (!runtime.includes('RTCPeerConnection') || !runtime.includes('run-project')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function failureDetails(error: unknown): { code?: string; message: string; remedy?: string } {
  const value = error as { code?: string; message?: string; remedy?: string; error?: string } | null;
  return {
    code: value?.code,
    message: value?.message || value?.error || (error instanceof Error ? error.message : String(error || 'Browser shortcut export failed.')),
    remedy: value?.remedy,
  };
}

export class BrowserShortcutController {
  private aborter: AbortController | null = null;

  cancel(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  async run(
    driver: BrowserShortcutDriver,
    request: BrowserShortcutRequest,
    onSnapshot?: (snapshot: BrowserShortcutSnapshot) => void,
  ): Promise<BrowserShortcutSnapshot> {
    this.cancel();
    const aborter = new AbortController();
    this.aborter = aborter;
    const emit = (snapshot: BrowserShortcutSnapshot) => {
      onSnapshot?.(snapshot);
      return snapshot;
    };
    let currentStep: BrowserShortcutStep = 'connection';
    try {
      emit({ phase: 'checking', activeStep: 'connection', progress: 0.08, message: 'Checking connection, checkout, runtime target, and HTTPS origin…' });
      const preflight = await driver.preflightBrowserShortcut(request, aborter.signal);
      if (!preflight.ok) {
        return emit({
          phase: 'blocked', activeStep: 'connection', progress: 0, code: preflight.code,
          message: preflight.message, remedy: preflight.remedy,
        });
      }

      // The normal path lets the agent reserve an isolated relay origin during
      // preflight. Carry that exact claim through build/publish; never guess it
      // independently on the phone.
      const effectiveRequest: BrowserShortcutRequest = {
        ...request,
        publicOrigin: preflight.publicOrigin || request.publicOrigin,
        relaySubdomain: preflight.relaySubdomain || request.relaySubdomain,
        mode: preflight.mode || request.mode,
        runtimeTargetId: preflight.runtimeTargetId || request.runtimeTargetId,
      };

      currentStep = 'build';
      const nativeRuntime = effectiveRequest.mode === 'remote-runtime';
      emit({
        phase: 'building', activeStep: currentStep, progress: 0.2,
        message: nativeRuntime
          ? 'Preparing the full-screen native runtime viewer…'
          : 'Building the browser app on the selected machine…',
      });
      const build = await driver.buildBrowserShortcut(effectiveRequest, aborter.signal);
      if (!build.ok) {
        return emit({
          phase: 'failed', activeStep: 'build', progress: 1, code: build.code || 'BROWSER_SHORTCUT_BUILD_FAILED',
          message: build.error || 'The browser build did not complete.', route: build.route,
          remedy: 'Open the build output, fix the named error, then retry export.',
        });
      }

      currentStep = 'publish';
      emit({ phase: 'publishing', activeStep: currentStep, progress: 0.72, message: 'Publishing the isolated installable shortcut…' });
      const release = await driver.publishBrowserShortcut(effectiveRequest, aborter.signal);

      currentStep = 'verify';
      emit({ phase: 'verifying', activeStep: currentStep, progress: 0.9, message: 'Opening the published HTTPS origin to verify the real route…', release });
      if (!await driver.verifyBrowserShortcut(release, aborter.signal)) {
        return emit({
          phase: 'failed', activeStep: 'verify', progress: 1, code: 'BROWSER_SHORTCUT_ROUTE_UNREACHABLE', release,
          message: 'The release was created, but its HTTPS origin did not serve the app.',
          remedy: 'Point the dedicated hostname at this Yaver agent, then verify again.',
        });
      }

      return emit({
        phase: 'ready', activeStep: 'verify', progress: 1,
        message: release.mode === 'remote-runtime'
          ? 'Native app shortcut verified. Opening it launches the remote simulator or emulator.'
          : 'Browser shortcut verified and ready to install.',
        release,
      });
    } catch (error) {
      if (aborter.signal.aborted) {
        return emit({ phase: 'idle', progress: 0, code: 'BROWSER_SHORTCUT_CANCELLED', message: 'Browser shortcut export cancelled.' });
      }
      const detail = failureDetails(error);
      return emit({ phase: 'failed', activeStep: currentStep, progress: 1, code: detail.code || 'BROWSER_SHORTCUT_EXPORT_FAILED', message: detail.message, remedy: detail.remedy });
    } finally {
      if (this.aborter === aborter) this.aborter = null;
    }
  }
}

/** Conservative client-side suggestion only; agent preflight is authoritative. */
export function suggestBrowserShortcutOrigin(endpoints: readonly string[]): string | null {
  for (const raw of endpoints) {
    try {
      const value = String(raw || '').trim();
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) continue;
      if (u.pathname && u.pathname !== '/') continue;
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const ipv4 = host.split('.');
      const isIPv4 = ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
      if (isIPv4 || host.includes(':')) continue;
      if (u.hostname.toLowerCase() === 'yaver.io' || u.hostname.toLowerCase().endsWith('.yaver.io')) continue;
      return u.origin;
    } catch {
      // malformed inventory entries are not candidates
    }
  }
  return null;
}
