/**
 * sseClient.test.ts — `npx tsx src/lib/sseClient.test.ts`.
 *
 * Frames arrive split across progress events, so the framing rules are the part
 * that silently loses data. Every case here is a shape the agent actually sends.
 */
import { parseSseBuffer } from "./sseClient";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("parseSseBuffer — complete frames");
{
  const { frames, rest } = parseSseBuffer('data: {"type":"log","logLine":"hello"}\n\n');
  check("one frame parsed", frames.length === 1, JSON.stringify(frames));
  check("data extracted", frames[0]?.data === '{"type":"log","logLine":"hello"}');
  check("nothing left over", rest === "");
}

console.log("parseSseBuffer — the agent's keep-alive comment (`:hello <ts>`)");
{
  const { frames } = parseSseBuffer(':hello 1784962434\n\ndata: {"type":"heartbeat"}\n\n');
  check("comment ignored, real frame kept", frames.length === 1 && frames[0].data === '{"type":"heartbeat"}');
}

console.log("parseSseBuffer — split across progress events (the data-loss bug)");
{
  // XHR onprogress fires mid-frame; both halves must survive.
  const first = parseSseBuffer('data: {"type":"log","logL');
  check("incomplete frame yields nothing yet", first.frames.length === 0);
  check("incomplete tail is carried", first.rest === 'data: {"type":"log","logL');
  const second = parseSseBuffer(first.rest + 'ine":"Compiling..."}\n\n');
  check("frame completes on the next chunk", second.frames.length === 1);
  check(
    "payload is intact across the boundary",
    second.frames[0]?.data === '{"type":"log","logLine":"Compiling..."}',
    second.frames[0]?.data,
  );
}

console.log("parseSseBuffer — several frames in one chunk");
{
  const { frames, rest } = parseSseBuffer(
    'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\ndata: {"n":4',
  );
  check("all complete frames returned", frames.length === 3, `${frames.length}`);
  check("partial fourth is carried", rest === 'data: {"n":4');
}

console.log("parseSseBuffer — CRLF and multi-line data");
{
  const { frames } = parseSseBuffer('data: {"a":1}\r\n\r\n');
  check("CRLF separator handled", frames.length === 1 && frames[0].data === '{"a":1}');
  const multi = parseSseBuffer("data: line one\ndata: line two\n\n");
  check("multi-line data joined with newline", multi.frames[0]?.data === "line one\nline two");
}

console.log("parseSseBuffer — named events and stray input");
{
  const { frames } = parseSseBuffer('event: reload\ndata: {"type":"reload"}\n\n');
  check("event name captured", frames[0]?.event === "reload");
  const empty = parseSseBuffer("");
  check("empty buffer is safe", empty.frames.length === 0 && empty.rest === "");
  const noData = parseSseBuffer("event: ping\n\n");
  check("frame with no data line is dropped", noData.frames.length === 0);
}

console.log("parseSseBuffer — a real captured burst from the agent");
{
  const captured =
    ":hello 1784962434\n\n" +
    'data: {"type":"starting","framework":"flutter","message":"Starting flutter dev server..."}\n\n' +
    'data: {"type":"resources","port":9100,"preferredPort":9100,"message":"Serving on :9100"}\n\n' +
    'data: {"type":"log","logLine":"Launching lib/main.dart on Web Server in debug mode..."}\n\n' +
    'data: {"type":"ready","bundleUrl":"/dev/"}\n\n';
  const { frames, rest } = parseSseBuffer(captured);
  const types = frames.map((f) => JSON.parse(f.data).type);
  check(
    "every frame type survives the burst",
    JSON.stringify(types) === JSON.stringify(["starting", "resources", "log", "ready"]),
    JSON.stringify(types),
  );
  check("no residue", rest === "");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
