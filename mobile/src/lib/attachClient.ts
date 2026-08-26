// attachClient.ts — talks to the agent's /attach/* endpoints.
//
// The capability itself is an HttpOnly cookie the agent sets; this module never
// sees it and must never try to. Everything here works in terms of the SESSION
// ID, which is not a secret.
//
// Keeping that split honest is the point: if this file ever gains a
// `getAttachToken()`, the security model (page JS can use the authority but
// cannot read or move it) has been quietly reverted. See
// desktop/agent/attach_session.go.

import { connectionManager } from "./connectionManager";
import { appLog } from "./logger";
import { describeDevReloadResult, devReloadReachedTarget, type AttachSessionResult, type RunnerInfo } from "./quic";
import { doctorBrowserLane, type BrowserLaneProbeResult } from "./browserLaneDoctor";
import { startBrowserProjectLane, subscribeProjectPreviewOutput } from "./projectPreviewRuntime";
import { resolveAgentPreviewUrl, waitForAgentPreviewRoute } from "./agentPreviewUrl";

export type { AttachSessionResult };

function clientFor(deviceId?: string | null) {
  const client = deviceId ? connectionManager.clientFor(deviceId) : connectionManager.active();
  if (!client?.isConnected) return null;
  return client;
}

const NOT_CONNECTED: AttachSessionResult = {
  ok: false,
  code: "ATTACH_BOX_OFFLINE",
  error: "That box isn't connected right now.",
  remedy: "Reconnect the primary device, then open Dogfood mode again.",
};

/**
 * Ask the agent to verify a directory really is Yaver's own checkout.
 *
 * The AGENT decides, from the project's declared identity (package.json name,
 * bundle id, monorepo layout). The phone cannot see the box's disk, and a
 * client-side path guess is exactly the "is it inside a folder called
 * yaver.io" heuristic that misfires on third-party fixtures under demo/.
 *
 * Fails CLOSED: anything we could not confirm is treated as "not Yaver", so a
 * network blip can never open Attach Mode on an unverified directory.
 */
export async function verifyYaverCheckout(deviceId: string, workDir: string): Promise<boolean> {
  const client = clientFor(deviceId);
  if (!client) return false;
  try {
    const caps = await client.getProjectPreviewCapabilities(workDir);
    return !!caps?.selfDevelopment;
  } catch (err) {
    appLog("warn", `attach: could not verify checkout: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function startAttachSession(deviceId: string, workDir: string): Promise<AttachSessionResult> {
  const client = clientFor(deviceId);
  if (!client) return NOT_CONNECTED;
  try {
    return await client.startAttachSession(workDir);
  } catch (err: any) {
    return {
      ok: false,
      code: "ATTACH_START_FAILED",
      error: err?.message || "Could not start Dogfood mode.",
      remedy: "Check the box is reachable, then try again.",
    };
  }
}

/** Start Yaver's own Expo target on the selected box's browser lane.
 * Uses the per-device client so capability minting and serving cannot land on
 * different boxes when the focused machine is not the primary. */
export async function startYaverBrowserLane(deviceId: string, checkoutDir: string) {
  const client = clientFor(deviceId);
  if (!client) throw new Error(NOT_CONNECTED.error);
  return startBrowserProjectLane(client, {
    workDir: checkoutDir.replace(/\/+$/, "") + "/mobile",
    framework: "expo",
  });
}

export type DogfoodPreparationResult =
  | {
      ok: true;
      sessionId: string;
      url: string;
      probe: BrowserLaneProbeResult;
      branch?: string;
      pushPolicy?: string;
    }
  | {
      ok: false;
      code: string;
      error: string;
      remedy: string;
      requiresAgent?: boolean;
      fixPrompt?: string;
    };

export type DogfoodSourceStatus = Awaited<ReturnType<NonNullable<ReturnType<typeof clientFor>>["dogfoodYaverSourceStatus"]>>;

export async function dogfoodNativeRuntimeAvailable(deviceId: string, checkoutDir: string): Promise<boolean> {
  const client = clientFor(deviceId);
  if (!client || !checkoutDir.trim()) return false;
  try {
    const caps = await client.getRemoteRuntimeCapabilities(
      checkoutDir.replace(/\/+$/, "") + "/mobile",
      "expo",
    );
    return caps.targets.some((target) => target.id !== "browser-window" && target.enabled);
  } catch {
    return false;
  }
}

/** Live runner/model inventory for the two-level Dogfood settings surface. */
export async function getDogfoodRunners(deviceId: string): Promise<RunnerInfo[]> {
  const client = clientFor(deviceId);
  if (!client) return [];
  return client.getRunners();
}

export type DogfoodCheckoutPreparation =
  | { ok: true; branch?: string; pushPolicy?: string }
  | { ok: false; code: string; error: string; remedy: string; requiresAgent?: boolean; fixPrompt?: string };

/** Git-only preparation shared by browser and native WebRTC Dogfood lanes. */
export async function prepareDogfoodCheckoutOnly(
  deviceId: string,
  checkoutDir: string,
  onProgress?: (message: string) => void,
): Promise<DogfoodCheckoutPreparation> {
  const client = clientFor(deviceId);
  if (!client) {
    return {
      ok: false, code: "DOGFOOD_PRIMARY_DISCONNECTED",
      error: "The primary device is not connected.",
      remedy: "Reconnect the primary device, then enter Dogfood mode again.",
    };
  }
  onProgress?.("Syncing Yaver with canonical main…");
  const git = await client.prepareDogfoodCheckout(checkoutDir).catch((err) => ({
    ok: false, code: "DOGFOOD_GIT_PREPARE_FAILED",
    error: err instanceof Error ? err.message : String(err),
    remedy: "Check Git and GitHub access on the primary device, then retry.",
    requiresAgent: false,
    fixPrompt: undefined,
    contributionBranch: false,
    branch: undefined,
    pushPolicy: undefined,
  }));
  if (!git.ok) {
    return {
      ok: false,
      code: git.code || "DOGFOOD_GIT_PREPARE_FAILED",
      error: git.error || "The Yaver checkout could not be prepared from canonical main.",
      remedy: git.remedy || "Fix the named Git issue, then retry Dogfood mode.",
      requiresAgent: git.requiresAgent === true,
      fixPrompt: git.fixPrompt,
    };
  }
  if (git.contributionBranch && git.branch) onProgress?.(`Contribution branch ${git.branch} ready…`);
  return { ok: true, branch: git.branch, pushPolicy: git.pushPolicy };
}

/**
 * Prove Dogfood mode before navigating away from Production.
 *
 * A dev-server PID or URL is inventory. The browser-lane doctor launches the
 * browser and waits for Yaver to paint. Any failure revokes the partially
 * minted attach capability so a rejected entry cannot leave hidden live state.
 */
export async function prepareDogfoodMode(
  deviceId: string,
  checkoutDir: string,
  onProgress?: (message: string) => void,
  onLog?: (line: string) => void,
): Promise<DogfoodPreparationResult> {
  const initialClient = clientFor(deviceId);
  if (!initialClient) {
    return {
      ok: false,
      code: "DOGFOOD_PRIMARY_DISCONNECTED",
      error: "The primary device is not connected.",
      remedy: "Reconnect the primary device, then enter Dogfood mode again.",
    };
  }

  const git = await prepareDogfoodCheckoutOnly(deviceId, checkoutDir, onProgress);
  if (!git.ok) {
    return git;
  }
  onProgress?.("Authorizing Dogfood session…");
  const session = await startAttachSession(deviceId, checkoutDir);
  if (!session.ok || !session.sessionId) {
    return {
      ok: false,
      code: session.code || "DOGFOOD_SESSION_FAILED",
      error: session.error || "Could not authorize Dogfood mode.",
      remedy: session.remedy || "Reconnect the primary device and try again.",
    };
  }

  const fail = async (code: string, error: string, remedy: string): Promise<DogfoodPreparationResult> => {
    await stopAttachSession(deviceId, session.sessionId);
    return { ok: false, code, error, remedy };
  };

  let stopDevEvents: (() => void) | null = null;
  try {
    stopDevEvents = subscribeProjectPreviewOutput(
      initialClient,
      (lines) => lines.forEach((line) => onLog?.(line)),
      (health) => { if (health?.kind === "lost") onLog?.(`[logs] ${health.message}`); },
    );
    onProgress?.("Starting Yaver with Expo…");
    const status = await startYaverBrowserLane(deviceId, checkoutDir);
    const bundlePath = String((status as any)?.previewUrl || (status as any)?.bundleUrl || "").trim();
    if (!bundlePath) {
      return fail(
        "DOGFOOD_NO_RENDER_URL",
        "Expo started, but the primary device did not report a browser URL for Yaver.",
        "Open Projects on the primary device and run Browser Reload; its doctor will name the failed stage.",
      );
    }

    const client = clientFor(deviceId);
    if (!client) {
      return fail(
        "DOGFOOD_PRIMARY_DISCONNECTED",
        "The primary device disconnected while Expo was starting.",
        "Reconnect the primary device, then enter Dogfood mode again.",
      );
    }

    // The agent normally reports /dev-web/, not an absolute URL. Resolve it
    // against THIS device's transport origin so a remote primary stays remote.
    // Dogfood uses its scoped HttpOnly attach cookie minted above. Keep the
    // reported path on this device's transport origin and never copy an owner
    // credential into the URL.
    const url = resolveAgentPreviewUrl(client.baseUrl, bundlePath);

    onProgress?.("Compiling Yaver’s Dogfood web route…");
    const routeProbe = await waitForAgentPreviewRoute(
      url,
      client.getAuthHeaders(),
      (probe, elapsedMs, attempt) => {
        // Narrate the wait without flooding the console. The old flow turned
        // the very first startup 503 into a terminal "machine disconnected"
        // error at ~3 seconds even though Expo became healthy moments later.
        if (attempt === 1 || attempt % 6 === 0) {
          const state = probe.status > 0 ? `HTTP ${probe.status}` : "transport reconnecting";
          onLog?.(`[route] Expo is still starting (${state}, ${Math.ceil(elapsedMs / 1000)}s elapsed)`);
        }
      },
    );
    if (!routeProbe.ok) {
      if (routeProbe.timedOut) {
        return fail(
          "DOGFOOD_RENDER_ROUTE_TIMEOUT",
          `Expo did not make the phone’s Dogfood route ready within two minutes (last response HTTP ${routeProbe.status || "transport failure"}).`,
          "Read the live console for the named Expo failure, then retry. The selected machine is connected; Dogfood remains off until its route serves successfully.",
        );
      }
      const suffix = routeProbe.status > 0 ? `HTTP_${routeProbe.status}` : "TRANSPORT";
      const detail = routeProbe.status > 0
        ? `The exact Dogfood URL returned HTTP ${routeProbe.status} before the WebView opened.`
        : `The phone could not reach the exact Dogfood URL: ${routeProbe.error || "transport failed"}.`;
      return fail(
        `DOGFOOD_RENDER_ROUTE_${suffix}`,
        detail,
        routeProbe.status === 404
          ? "Update Yaver so the relay keeps the selected device prefix, then retry Dogfood mode."
          : routeProbe.status === 401 || routeProbe.status === 403
            ? "Refresh the Dogfood authorization and retry; the preview route rejected this session."
            : "Retry after fixing the named route failure. Dogfood remains off until the phone route answers successfully.",
      );
    }
    onLog?.(`[route] phone handoff HTTP ${routeProbe.status} (${routeProbe.contentType})`);

    onProgress?.("Proving Yaver renders in the browser…");
    let probe = await doctorBrowserLane(client, 45);
    if (!probe) {
      return fail(
        "DOGFOOD_RENDER_PROBE_UNAVAILABLE",
        "The primary device could not verify that Yaver rendered in its browser lane.",
        "Update or restart the Yaver agent, then retry. Dogfood mode stays off until this probe answers.",
      );
    }
    if (!probe.ok && probe.stage === "compiling") {
      onProgress?.("Compiling Yaver’s first web build…");
      onLog?.(probe.detail || "Metro is compiling the first web bundle");
      // Older agents return `compiling` immediately even though their doctor
      // accepts a waitSeconds parameter. Keep the launch screen alive and
      // re-probe the real browser operation until Metro paints or the overall
      // first-build allowance expires. Newer agents also wait internally, so
      // this remains a bounded compatibility loop rather than a second lane.
      const compileDeadline = Date.now() + 90_000;
      while (!probe.ok && probe.stage === "compiling" && Date.now() < compileDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const remainingSeconds = Math.max(1, Math.ceil((compileDeadline - Date.now()) / 1000));
        probe = await doctorBrowserLane(client, Math.min(15, remainingSeconds));
        if (!probe.ok && probe.stage === "compiling") {
          onLog?.(probe.detail || "Metro is still compiling the first web bundle");
        }
      }
    }
    if (!probe.ok) {
      return fail(
        `DOGFOOD_RENDER_${String(probe.stage || "FAILED").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        probe.detail || `Yaver's browser lane stopped at ${probe.stage || "an unknown stage"}.`,
        probe.remedy || "Fix the named browser-lane stage, then enter Dogfood mode again.",
      );
    }

    return { ok: true, sessionId: session.sessionId, url, probe, branch: git.branch, pushPolicy: git.pushPolicy };
  } catch (err) {
    return fail(
      "DOGFOOD_EXPO_START_FAILED",
      err instanceof Error ? err.message : String(err),
      "Check the primary device connection and Expo installation, then retry.",
    );
  } finally {
    stopDevEvents?.();
  }
}

/** Build and deliver Yaver's own RN bundle into the installed Yaver host.
 * The way out is native on both platforms (iOS AppDelegate/CoreMotion;
 * Android native guest unload), so the guest JS cannot capture it. */
export async function startDogfoodHermesLane(
  deviceId: string,
  checkoutDir: string,
): Promise<{ ok: true; deliveredTo?: number; message: string } | { ok: false; code: string; error: string; remedy: string }> {
  const client = clientFor(deviceId);
  if (!client) {
    return {
      ok: false, code: "DOGFOOD_PRIMARY_DISCONNECTED",
      error: "The selected device is not connected.",
      remedy: "Reconnect that device, then retry Hermes Dogfood.",
    };
  }
  const projectPath = checkoutDir.replace(/\/+$/, "") + "/mobile";
  const result = await client.reloadDevServerDetailed({
    mode: "bundle",
    projectName: "Yaver",
    projectPath,
  });
  if (!devReloadReachedTarget(result)) {
    return {
      ok: false,
      code: String((result as any)?.code || "DOGFOOD_HERMES_DELIVERY_FAILED"),
      error: describeDevReloadResult(result),
      remedy: result.nativeChangesDetected
        ? "Native files changed. Install a fresh Yaver build on the phone, then retry Hermes Dogfood."
        : "Read the live compiler output, fix the named Hermes build or delivery failure, then retry.",
    };
  }
  return {
    ok: true,
    deliveredTo: result.deliveredTo,
    message: describeDevReloadResult(result),
  };
}

/** Escalate only after deterministic Dogfood preparation/render recovery has
 * no answer. The task runs on the selected primary against the same checkout. */
export async function requestDogfoodFixWithAI(
  deviceId: string,
  checkoutDir: string,
  runner: string,
  prompt: string,
): Promise<{ taskId: string }> {
  const client = clientFor(deviceId);
  if (!client) throw new Error("The primary device disconnected before the AI fix could start.");
  const task = await client.sendTask(
    "Fix Yaver Dogfood mode",
    prompt,
    undefined,
    runner || undefined,
    undefined,
    undefined,
    undefined,
    checkoutDir,
    undefined,
    undefined,
    true,
  );
  return { taskId: task.id };
}

/** Resolve the checkout from the box's real repo inventory. Empty means the
 * source is not present; callers then keep the explicit path route visible. */
export async function discoverYaverCheckout(deviceId: string): Promise<string> {
  const client = clientFor(deviceId);
  if (!client) return "";
  const status = await client.dogfoodYaverSourceStatus();
  return status.ready ? String(status.path || "") : "";
}

/** Agent-owned source/Git readiness. The phone never infers remote disk state. */
export async function getDogfoodSourceStatus(deviceId: string, workDir?: string): Promise<DogfoodSourceStatus> {
  const client = clientFor(deviceId);
  if (!client) {
    return {
      ok: false,
      ready: false,
      code: "ATTACH_BOX_OFFLINE",
      message: NOT_CONNECTED.error || "That box is offline.",
      remedy: NOT_CONNECTED.remedy,
    };
  }
  return client.dogfoodYaverSourceStatus(workDir);
}

export async function installDogfoodSource(
  deviceId: string,
  runner: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const client = clientFor(deviceId);
  if (!client) return { ok: false, error: NOT_CONNECTED.error };
  return client.dogfoodYaverSourceInstall(undefined, { autoInit: false, runner });
}

export async function installDogfoodGit(
  deviceId: string,
  onProgress?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const client = clientFor(deviceId);
  if (!client) return { ok: false, error: NOT_CONNECTED.error };
  const result = await client.installRunner("git", { onProgress });
  return { ok: result.ok, error: result.error };
}

export async function refreshAttachSession(deviceId: string, sessionId: string): Promise<AttachSessionResult> {
  const client = clientFor(deviceId);
  if (!client) return NOT_CONNECTED;
  try {
    return await client.refreshAttachSession(sessionId);
  } catch (err: any) {
    return { ok: false, code: "ATTACH_REFRESH_FAILED", error: err?.message || "Could not refresh Dogfood mode." };
  }
}

/**
 * Detach. Revokes SERVER-SIDE; the caller also clears local state.
 *
 * Both halves matter. Clearing only the client would leave a live capability
 * on the box — the inventory says detached while the operation says still
 * attached, which is the false-green shape this repo keeps finding.
 */
export async function stopAttachSession(deviceId: string, sessionId?: string | null): Promise<boolean> {
  const client = clientFor(deviceId);
  if (!client) return false;
  try {
    return await client.stopAttachSession(sessionId);
  } catch (err) {
    appLog("warn", `attach: detach failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** How often the host re-mints while the surface is open. Comfortably inside
 *  the agent's 10-minute token TTL so a slow network cannot let it lapse. */
export const ATTACH_REFRESH_MS = 4 * 60 * 1000;
