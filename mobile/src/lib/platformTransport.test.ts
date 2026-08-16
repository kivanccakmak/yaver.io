/**
 * platformTransport.test.ts — `npx tsx src/lib/platformTransport.test.ts`.
 * No RN, no jest — the tiny assert harness the rest of src/lib uses.
 *
 * Guards the 2026-07-25 defect: RN-web sat on "Transport pending" forever while
 * the same account on a real iPhone showed "Relay · 301ms". The browser was
 * waiting on QUIC, which it cannot speak AT ALL. An impossible operation must
 * be stated, never rendered as a spinner.
 *
 * The table is asserted structurally (not against a mocked Platform) so this
 * stays a pure check of the contract: every kind declared, every unsupported
 * kind carrying a reason a user can act on.
 */
import {
  TRANSPORT_CAPABILITIES,
  buildTransportCapabilities,
  connectGiveUpMessage,
  explainNoTransport,
  type TransportKind,
} from "./platformTransport";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

const KINDS: TransportKind[] = ["lan-beacon", "direct-http", "relay-http", "quic-relay", "quic-direct"];

// ── Every transport kind must declare its platform support ───────────────────
{
  for (const k of KINDS) {
    ok(!!TRANSPORT_CAPABILITIES[k], `${k} is declared`);
    ok(typeof TRANSPORT_CAPABILITIES[k]?.supported === "boolean", `${k} declares supported`);
  }
  ok(
    Object.keys(TRANSPORT_CAPABILITIES).sort().join(",") === [...KINDS].sort().join(","),
    "no undeclared transport kind can slip in and default to usable",
  );
}

// ── An unsupported lane must say WHY, in words a user can act on ─────────────
{
  for (const cap of Object.values(TRANSPORT_CAPABILITIES)) {
    if (!cap.supported) ok((cap.reason?.length ?? 0) > 10, `${cap.kind} carries a plain-language reason`);
  }
}

// ── Browser HTTP lanes remain possible; only raw QUIC/UDP is unavailable ─────
{
  const web = buildTransportCapabilities(true);
  ok(web["direct-http"].supported, "direct HTTP is available in a browser");
  ok(web["relay-http"].supported, "the relay HTTPS proxy is available in a browser");
  ok(!web["quic-relay"].supported, "raw relay QUIC remains unavailable in a browser");
  ok(!web["quic-direct"].supported, "raw direct QUIC remains unavailable in a browser");
}

// ── explainNoTransport stays silent while something is still possible ────────
{
  ok(explainNoTransport(["direct-http"]) === null, "no dead-end message while direct HTTP is viable");
  const msg = explainNoTransport(["quic-relay", "quic-direct"]);
  ok(msg === null || msg.length > 20, "a dead end is explained, never left blank");
}

// ── The give-up message carries the cause the ladder preserved ───────────────
{
  const withCause = connectGiveUpMessage(5, "relay: invalid relay password (reason=bad_password)");
  ok(withCause.includes("after 5 attempts"), "give-up names the attempt count");
  ok(
    withCause.includes("reason=bad_password"),
    "give-up carries the transport cause instead of discarding it at surrender (audit T1)",
  );
  const bare = connectGiveUpMessage(5, "   ");
  ok(bare === "Could not reach device after 5 attempts", "blank cause → clean base message, no dangling dash");
  ok(
    !connectGiveUpMessage(5, "relay: HTTP 502").includes("No connection method available"),
    "a failed HTTPS relay route is not misreported as browser incapability",
  );
}

console.log(`\nplatformTransport: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
