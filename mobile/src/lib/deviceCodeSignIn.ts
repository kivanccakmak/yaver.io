// deviceCodeSignIn.ts — sign this phone in with a short code, no browser.
//
// WHY IT EXISTS. `backend/convex/deviceCode.ts` has shipped the whole RFC-8628
// flow, and six live HTTP routes, for a long time — and `mobile/app/login.tsx`
// had NO code-entry path at all: OAuth, passkey and email only. Every one of
// those needs an interactive browser round-trip, which means:
//
//   • no way to hand a session to a new phone or a simulator without a human
//     driving a browser, so every automated iOS/Android arc died at sign-in
//     (docs/handoff/session-2026-08-03-remaining-work.md #3, blocking #5 + #6);
//   • a real user moving to a new phone hits the same wall, with a working
//     mechanism sitting unused behind it.
//
// tvOS has done this for ages (tvos/YaverTV/Backend.swift). This is the same
// two calls, on the surface that lacked them.
//
// THE CONTRACT, measured against backend/convex/http.ts + deviceCode.ts:
//
//   POST {convexSite}/auth/device-code
//        {machineName?, platform?, environment?, deviceId?, ownerUserIdHint?}
//     -> { userCode, deviceCode, expiresAt }
//
//   GET  {convexSite}/auth/device-code/poll?device_code=<deviceCode>
//     -> { status: "pending" }
//      | { status: "expired" }
//      | { status: "authorized", token }
//      | { status: "authorized", claimRequired: true }     (broker path only)
//
// NOTE WHICH SECRET DRIVES IT. poll/claim key off `deviceCode` — the 40-hex
// SECRET — not the short `userCode` the human reads. So the phone must CREATE
// the code and hold it; it cannot merely accept a code typed by someone else.
// Getting that backwards produces a screen that asks for a code and can never
// complete, which is worse than no screen at all.
//
// BOUNDED, ALWAYS. Every network call here goes through boundedFetch, which
// ABORTS on its deadline: RN's `fetch` has no default timeout and will hang
// forever, and a hung sign-in is the exact wedge CLAUDE.md's connectivity rule
// exists to forbid. The poll loop carries a wall-clock deadline of its own, so
// "waiting for approval" can never become permanent.

/** One network call's budget. Generous enough for a cold Convex function, far
 *  short of "forever". */
const CALL_TIMEOUT_MS = 15_000;

/**
 * fetch with a HARD deadline that actually cancels the request.
 *
 * Deliberately NOT connectGuard's withDeadline: that helper races the work
 * against a timer and resolves to a FALLBACK VALUE, which is right for a
 * fire-and-read like NetInfo.fetch() but wrong here — there is no sensible
 * fallback Response, and abandoning the request leaves the socket open. For a
 * request/response call the sanctioned shape is an AbortController (CLAUDE.md,
 * connectivity robustness), so the request is torn down and the caller gets a
 * real error it can name.
 */
async function boundedFetch(url: string, init?: RequestInit, label = "request"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** How often to ask. The backend's own device-code TTL is minutes; 2s is the
 *  same cadence tvOS uses and is polite to a shared deployment. */
export const POLL_INTERVAL_MS = 2_000;

export type DeviceCodeStart = {
  /** The SHORT code a human reads aloud or types. Display this. */
  userCode: string;
  /** The 40-hex SECRET this device polls with. Never display it, never log it. */
  deviceCode: string;
  expiresAt: number;
};

export type DeviceCodePoll =
  | { status: "pending"; unreachableReason?: string }
  | { status: "expired" }
  | { status: "authorized"; token?: string; claimRequired?: boolean; claimHandle?: string };

function siteUrl(path: string, explicitBaseUrl?: string): string {
  // Keep the polling state machine importable by the headless guard. Loading
  // backendConfig at module scope pulls React Native's Flow entrypoint into a
  // plain Node test, so resolve it only on the real app path. Metro still sees
  // this literal require and bundles the module normally.
  const base = (explicitBaseUrl || require("./backendConfig").getConvexSiteUrlSync()).replace(/\/+$/, "");
  return `${base}${path}`;
}

/**
 * Create a code for THIS device. Returns the short code to show and the secret
 * to poll with.
 *
 * Throws on failure rather than returning null: a sign-in screen that cannot
 * start must say why, and a null here previously became "nothing happened when
 * I tapped it" — the silence this whole codebase keeps paying for.
 */
export async function startDeviceCodeSignIn(opts?: {
  machineName?: string;
  platform?: string;
  environment?: string;
  deviceId?: string;
  ownerUserIdHint?: string;
}): Promise<DeviceCodeStart> {
  const res = await boundedFetch(
    siteUrl("/auth/device-code"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machineName: opts?.machineName ?? "Phone",
        platform: opts?.platform ?? "mobile",
        environment: opts?.environment ?? "mobile",
        ...(opts?.deviceId ? { deviceId: opts.deviceId } : {}),
        ...(opts?.ownerUserIdHint ? { ownerUserIdHint: opts.ownerUserIdHint } : {}),
      }),
    },
    "device-code create",
  );
  if (!res.ok) {
    throw new Error(`Couldn't start code sign-in (HTTP ${res.status}). Check your connection.`);
  }
  const body = (await res.json()) as Partial<DeviceCodeStart>;
  if (!body?.userCode || !body?.deviceCode) {
    throw new Error("The server did not return a sign-in code.");
  }
  return {
    userCode: body.userCode,
    deviceCode: body.deviceCode,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now() + 10 * 60_000,
  };
}

/**
 * Ask once whether the code has been approved.
 *
 * A transport failure comes back as `pending` WITH `unreachableReason` set —
 * never as a bare `pending`. That distinction is the whole reason tvOS added
 * the field: a device that cannot reach Convex at all otherwise renders exactly
 * the same "Waiting for approval…" as a device waiting on a human, for as long
 * as the human cares to stare at it.
 */
export async function pollDeviceCode(deviceCode: string, baseUrl?: string): Promise<DeviceCodePoll> {
  try {
    const res = await boundedFetch(
      siteUrl(`/auth/device-code/poll?device_code=${encodeURIComponent(deviceCode)}`, baseUrl),
      undefined,
      "device-code poll",
    );
    if (!res.ok) {
      return { status: "pending", unreachableReason: `server returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as DeviceCodePoll;
    if (body?.status === "authorized" || body?.status === "expired" || body?.status === "pending") {
      return body;
    }
    return { status: "pending", unreachableReason: "unrecognised reply from the server" };
  } catch (err) {
    return {
      status: "pending",
      unreachableReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The broker path's second step. Only reachable when the code carries a
 * claimHandle (i.e. it was minted for this device by an already-authenticated
 * session), which a phone-initiated code never does — but handling it costs one
 * call and NOT handling it would strand that flow on a screen that says
 * "authorized" and never proceeds.
 */
export async function claimDeviceCode(deviceCode: string, claimHandle?: string, baseUrl?: string): Promise<DeviceCodePoll> {
  try {
    const res = await boundedFetch(
      siteUrl("/auth/device-code/claim", baseUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode, ...(claimHandle ? { claimHandle } : {}) }),
      },
      "device-code claim",
    );
    if (!res.ok) {
      return { status: "pending", unreachableReason: `claim returned HTTP ${res.status}` };
    }
    return (await res.json()) as DeviceCodePoll;
  } catch (err) {
    return { status: "pending", unreachableReason: err instanceof Error ? err.message : String(err) };
  }
}

export type DeviceCodeWaitResult =
  | { kind: "token"; token: string }
  | { kind: "expired" }
  | { kind: "timeout"; lastReason?: string }
  | { kind: "cancelled" };

/**
 * Poll until the code is approved, expires, or the caller's deadline passes.
 *
 * The wall-clock bound is not optional. Without it this is an unbounded await
 * behind a spinner — the shape that pinned the connect pill at "Connecting" for
 * thirty minutes on a healthy relay (memory: netinfo-wedges-connect-guard).
 */
export async function waitForDeviceCodeToken(
  deviceCode: string,
  opts?: {
    /** Total wall-clock budget. Default: the backend's own TTL, roughly. */
    timeoutMs?: number;
    /** Called after every poll so the UI can narrate instead of spinning. */
    onTick?: (state: { elapsedMs: number; unreachableReason?: string }) => void;
    /** Return true to abandon (screen unmounted, user cancelled). */
    isCancelled?: () => boolean;
    /** Injected in tests so the loop does not actually sleep. */
    sleep?: (ms: number) => Promise<void>;
    /** Headless-test seam; production resolves the live hosted config. */
    baseUrl?: string;
  },
): Promise<DeviceCodeWaitResult> {
  const timeoutMs = opts?.timeoutMs ?? 10 * 60_000;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  let lastReason: string | undefined;

  while (Date.now() - started < timeoutMs) {
    if (opts?.isCancelled?.()) return { kind: "cancelled" };

    let result = await pollDeviceCode(deviceCode, opts?.baseUrl);
    if (result.status === "authorized" && !result.token && result.claimRequired) {
      result = await claimDeviceCode(deviceCode, result.claimHandle, opts?.baseUrl);
    }

    if (result.status === "authorized" && result.token) {
      return { kind: "token", token: result.token };
    }
    if (result.status === "expired") {
      return { kind: "expired" };
    }
    lastReason = result.status === "pending" ? result.unreachableReason : undefined;
    opts?.onTick?.({ elapsedMs: Date.now() - started, unreachableReason: lastReason });

    if (opts?.isCancelled?.()) return { kind: "cancelled" };
    await sleep(POLL_INTERVAL_MS);
  }
  return { kind: "timeout", lastReason };
}

/** Group the short code for reading aloud: "ABCD-EFGH". Purely presentational —
 *  never send the grouped form anywhere. */
export function formatUserCode(code: string): string {
  const clean = (code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length <= 4) return clean;
  const mid = Math.ceil(clean.length / 2);
  return `${clean.slice(0, mid)}-${clean.slice(mid)}`;
}
