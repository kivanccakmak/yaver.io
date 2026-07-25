/**
 * pendingDeviceCodeLoginPaths.test.ts — `npx tsx src/lib/pendingDeviceCodeLoginPaths.test.ts`.
 *
 * A STATIC guard, not a unit test. It scans every screen under app/ for a
 * successful sign-in (`await login(...)`) and fails unless that screen also
 * drains a stashed Apple TV / device-code approval.
 *
 * Why a grep-shaped test: this bug shipped twice with the same symptom — a TV
 * stuck on "Waiting for approval…" while the phone signed in fine.
 *
 *   • 2026-07-15 — app/login.tsx learned to stash + resume the code.
 *   • 2026-07-25 — app/oauth-callback.tsx (where browser OAuth on iOS actually
 *     lands, and which its own header calls "the canonical handler") still did
 *     `router.replace("/")` and threw the code away. Convex showed the TV's row
 *     still `pending`: the phone never called authorize.
 *
 * The fix is structural (one drain helper + PendingDeviceApprovalHost in
 * app/_layout.tsx), and this test is what stops the THIRD sign-in path from
 * quietly reintroducing it. Break it by deleting the
 * `resumePendingDeviceApproval` call from any screen below and re-running.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const APP_DIR = join(__dirname, "..", "..", "app");

/** Screens allowed to call login() without draining a pending device code. */
const EXEMPT = new Map<string, string>([
  // The TV's OWN sign-in screen. It is the device being approved, so a phone's
  // pending approval is meaningless here (and /approve-device is not a TV route).
  ["tv-signin.tsx", "the TV is the device being signed in, not the approver"],
]);

/** Anything that proves the screen hands off to the shared drain. */
const DRAIN_MARKERS = [
  "resumePendingDeviceApproval",
  "finishLogin", // login.tsx's local wrapper, which calls the above
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(APP_DIR);
check("found screens to scan", files.length > 0, `scanned ${APP_DIR}`);

const signInScreens = files.filter((f) => /\bawait\s+login\(/.test(readFileSync(f, "utf8")));
check(
  "found at least the known sign-in screens",
  signInScreens.length >= 4,
  `found ${signInScreens.length}`,
);

// The two paths this bug actually shipped on must be in the scanned set — if a
// refactor renames them, this test should fail loudly rather than pass vacuously.
for (const required of ["login.tsx", "oauth-callback.tsx"]) {
  check(
    `scan covers app/${required}`,
    signInScreens.some((f) => f.endsWith(required)),
    "renamed or no longer calls await login()",
  );
}

for (const file of signInScreens) {
  const name = file.slice(APP_DIR.length + 1);
  const base = name.split("/").pop() as string;
  if (EXEMPT.has(base)) {
    console.log(`skip ${name} — ${EXEMPT.get(base)}`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  check(
    `${name} drains a pending device approval after sign-in`,
    DRAIN_MARKERS.some((m) => src.includes(m)),
    "calls await login() but never resumePendingDeviceApproval() — a scanned TV code would be dropped here",
  );
}

// The backstop must stay mounted: even a compliant screen can lose its
// navigation to another redirect, and the host is what recovers that.
const layout = readFileSync(join(APP_DIR, "_layout.tsx"), "utf8");
check(
  "app/_layout.tsx mounts PendingDeviceApprovalHost",
  layout.includes("<PendingDeviceApprovalHost />"),
  "the sign-in-path backstop is not mounted",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
