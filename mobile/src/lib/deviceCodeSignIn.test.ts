// deviceCodeSignIn.test.ts — `npx tsx src/lib/deviceCodeSignIn.test.ts`
//
// The poll loop is the part that can strand a user, so it is the part that is
// tested. Three properties, each of which has already shipped broken somewhere
// in this codebase:
//
//   1. it ENDS. A wait with no wall-clock bound is the wedge that pinned the
//      connect pill at "Connecting" for thirty minutes on a healthy relay.
//   2. a transport failure is NOT reported as "waiting for approval". Those look
//      identical on screen and mean opposite things.
//   3. cancellation is honoured, so a dismissed screen stops polling instead of
//      holding a timer for ten minutes.

import { formatUserCode, waitForDeviceCodeToken } from "./deviceCodeSignIn";

let failures = 0;
function eq(got: unknown, want: unknown, label: string) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL ${label}\n  got:  ${a}\n  want: ${b}`);
    failures += 1;
  } else {
    console.log(`ok ${label}`);
  }
}

// The loop calls the real pollDeviceCode, which calls fetch. Swap fetch itself
// so the test drives the state machine without a network — and so a regression
// in the LOOP cannot hide behind a mocked loop.
const realFetch = globalThis.fetch;
function stubFetch(replies: Array<Record<string, unknown> | "network-error">) {
  let i = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === "network-error") throw new Error("connection refused");
    return {
      ok: true,
      status: 200,
      json: async () => reply,
    } as unknown as Response;
  }) as typeof fetch;
  return () => i;
}
const noSleep = async () => {};

async function main() {
  // ── 1. authorized → the token comes back ──────────────────────────────────
  stubFetch([{ status: "pending" }, { status: "pending" }, { status: "authorized", token: "tok_abc" }]);
  eq(
    await waitForDeviceCodeToken("dc", { sleep: noSleep, baseUrl: "https://example.invalid" }),
    { kind: "token", token: "tok_abc" },
    "authorized poll yields the token",
  );

  // ── 2. expired is terminal, not an infinite wait ──────────────────────────
  stubFetch([{ status: "expired" }]);
  eq(await waitForDeviceCodeToken("dc", { sleep: noSleep, baseUrl: "https://example.invalid" }), { kind: "expired" }, "expired ends the wait");

  // ── 3. IT ENDS. A server that says "pending" forever must still terminate. ─
  stubFetch([{ status: "pending" }]);
  const t = await waitForDeviceCodeToken("dc", { timeoutMs: 50, sleep: noSleep, baseUrl: "https://example.invalid" });
  eq((t as { kind: string }).kind, "timeout", "a permanently-pending code times out instead of hanging forever");

  // ── 4. a transport failure is REPORTED, not disguised as "waiting" ────────
  stubFetch(["network-error"]);
  const ticks: Array<string | undefined> = [];
  const unreachable = await waitForDeviceCodeToken("dc", {
    timeoutMs: 50,
    sleep: noSleep,
    baseUrl: "https://example.invalid",
    onTick: (s) => ticks.push(s.unreachableReason),
  });
  eq((unreachable as { kind: string }).kind, "timeout", "unreachable server still terminates");
  eq(
    ticks.some((r) => typeof r === "string" && r.length > 0),
    true,
    "the UI is told the server was unreachable — 'pending' alone would render as 'waiting for you to approve'",
  );

  // ── 5. cancellation stops the loop ────────────────────────────────────────
  const calls = stubFetch([{ status: "pending" }]);
  let cancelled = false;
  const res = await waitForDeviceCodeToken("dc", {
    timeoutMs: 60_000,
    sleep: noSleep,
    baseUrl: "https://example.invalid",
    isCancelled: () => cancelled,
    onTick: () => {
      cancelled = true;
    },
  });
  eq(res, { kind: "cancelled" }, "cancellation ends the wait");
  eq(calls() <= 2, true, "cancellation stops polling promptly rather than draining the budget");

  // ── 6. the broker path's second step is taken, not stranded ───────────────
  stubFetch([
    { status: "authorized", claimRequired: true, claimHandle: "h1" },
    { status: "authorized", token: "tok_claimed" },
  ]);
  eq(
    await waitForDeviceCodeToken("dc", { sleep: noSleep, baseUrl: "https://example.invalid" }),
    { kind: "token", token: "tok_claimed" },
    "claimRequired is followed through to the claim call",
  );

  globalThis.fetch = realFetch;

  // ── presentation ──────────────────────────────────────────────────────────
  eq(formatUserCode("abcdefgh"), "ABCD-EFGH", "user code is grouped for reading aloud");
  eq(formatUserCode("ab"), "AB", "short codes are not mangled");
  eq(formatUserCode(" a1b2-c3d4 "), "A1B2-C3D4", "already-grouped input round-trips");

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall device-code sign-in checks passed");
}

void main();
