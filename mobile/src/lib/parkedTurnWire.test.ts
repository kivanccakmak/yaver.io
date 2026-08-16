// parkedTurnWire.test.ts — closed loop over the actual wire contract.
//   run with: npx tsx src/lib/parkedTurnWire.test.ts
//
// WHAT THIS CLOSES. The parked-turn promise spans three independently-authored
// layers: the Go handler that emits the 409, the TS interface that parses it, and
// the notice the user reads. Each has its own tests. Nothing until now checked
// that the three AGREE — and a mismatch there fails in the most expensive way
// possible: silently, at runtime, on the surface the user is holding, turning
// "message saved" back into "failed" so they retype a prompt the agent is about
// to replay.
//
// Deliberately cheap. A real HTTP server on a random port and the exact parse
// branch the clients run — no browser, no Metro, no Go build, no agent, no
// account. Seconds, not minutes. The heavyweight browser lane is still worth
// having for pixels; this covers the contract, which is where drift actually
// lives.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ParkedTurnError, parkedTurnNotice, type ParkedTurnRejection } from "./parkedTurn";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

/**
 * The exact branch mobile/src/lib/quic.ts and web/lib/agent-client.ts run on a
 * continue response. Kept in one place here so the test exercises the decision,
 * not a paraphrase of it.
 */
async function clientContinueParse(res: Response): Promise<void> {
  if (res.status === 409) {
    let parked: ParkedTurnRejection | null = null;
    try {
      parked = (await res.json()) as ParkedTurnRejection;
    } catch {
      /* fall through */
    }
    if (parked?.parked) throw new ParkedTurnError(parked);
    if (parked?.error) throw new Error(parked.error);
  }
  if (!res.ok) throw new Error(`Failed to continue task: ${res.status}`);
}

async function withServer(
  handler: (req: any, res: any) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The body desktop/agent/httpserver.go: continueTask actually writes. */
const AGENT_409_BODY = {
  ok: false,
  taskId: "task-abc",
  code: "runner.codex.refresh_lineage_lost",
  error:
    "This machine's Codex refresh token is no longer accepted. Sign in again on this machine with `codex login --device-auth`.",
  parked: true,
  reauthable: true,
  runner: "codex",
};

async function main() {
  console.log("wire: agent 409 -> client -> notice");

  await withServer(
    (_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify(AGENT_409_BODY));
    },
    async (base) => {
      const res = await fetch(`${base}/tasks/task-abc/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "keep going" }),
      });
      let thrown: unknown = null;
      try {
        await clientContinueParse(res);
      } catch (e) {
        thrown = e;
      }
      check("a parked 409 throws ParkedTurnError", thrown instanceof ParkedTurnError, String(thrown));
      if (thrown instanceof ParkedTurnError) {
        check("carries the code", thrown.code === AGENT_409_BODY.code, thrown.code);
        check("carries reauthable", thrown.reauthable === true);
        check("carries the runner", thrown.runner === "codex", thrown.runner);
        const n = parkedTurnNotice(thrown);
        check("renders 'saved', not 'failed'", /saved/i.test(n.line) && !/fail/i.test(n.line), n.line);
        check("offers the sign-in", n.action?.kind === "signin", JSON.stringify(n.action));
      }
    },
  );

  // A 409 that is NOT parked must still be a plain error — never silently
  // swallowed into "your message is safe" when it is not.
  await withServer(
    (_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, taskId: "t", error: "some other conflict" }));
    },
    async (base) => {
      const res = await fetch(`${base}/tasks/t/continue`, { method: "POST" });
      let thrown: any = null;
      try {
        await clientContinueParse(res);
      } catch (e) {
        thrown = e;
      }
      check("non-parked 409 is a normal error", thrown instanceof Error && !(thrown instanceof ParkedTurnError), String(thrown));
      check("non-parked 409 keeps its message", /some other conflict/.test(String(thrown?.message)), String(thrown?.message));
    },
  );

  // A malformed 409 body must not crash the send path.
  await withServer(
    (_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end("<html>not json</html>");
    },
    async (base) => {
      const res = await fetch(`${base}/tasks/t/continue`, { method: "POST" });
      let thrown: any = null;
      try {
        await clientContinueParse(res);
      } catch (e) {
        thrown = e;
      }
      check("unparseable 409 still errors cleanly", thrown instanceof Error && !(thrown instanceof ParkedTurnError), String(thrown));
    },
  );

  // Success must stay untouched — the whole change is additive.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, taskId: "t", status: "running" }));
    },
    async (base) => {
      const res = await fetch(`${base}/tasks/t/continue`, { method: "POST" });
      let thrown: any = null;
      try {
        await clientContinueParse(res);
      } catch (e) {
        thrown = e;
      }
      check("a normal 200 continue still succeeds", thrown === null, String(thrown));
    },
  );

  console.log("\nwire: Go handler keys <-> TS interface");
  {
    const goSrc = readFileSync(join(repo, "desktop/agent/httpserver.go"), "utf8");
    // The block continueTask writes on the parked path.
    const idx = goSrc.indexOf('"parked":');
    check("Go emits a `parked` field", idx > 0);
    const block = goSrc.slice(Math.max(0, idx - 600), idx + 400);
    for (const key of ["ok", "taskId", "code", "error", "parked", "reauthable", "runner"]) {
      check(`Go emits "${key}"`, block.includes(`"${key}":`), "the TS interface expects it");
    }
    const tsSrc = readFileSync(join(here, "parkedTurn.ts"), "utf8");
    for (const key of ["taskId", "code", "error", "parked", "reauthable", "runner"]) {
      check(`TS interface declares ${key}`, new RegExp(`\\b${key}\\??:`).test(tsSrc));
    }

    // Every code the agent can put in that field must be one the surfaces know.
    const reasonSrc = readFileSync(join(repo, "desktop/agent/reason_codes.go"), "utf8");
    const codexCodes = (reasonSrc.match(/"runner\.codex\.[a-z_]+"/g) || []).map((s) => s.replace(/"/g, ""));
    check("found codex reason codes in Go", codexCodes.length >= 4, String(codexCodes.length));
    for (const code of codexCodes) {
      // Only codes reachable on the continue path need a surface branch; the
      // rest must at least not be unknown to the module.
      check(`surfaces know ${code}`, tsSrc.includes(`"${code}"`), "add it to RUNNER_AUTH_CODES or it renders the generic line");
    }
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
