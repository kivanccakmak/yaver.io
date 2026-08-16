/**
 * machineResources.test.ts — `npx tsx src/lib/machineResources.test.ts`.
 * Pure harness (no RN) for the co-vibe formatters every surface shares.
 */
import {
  canDrive,
  describeMachine,
  describeParticipants,
  describePort,
  describeResources,
  mySeat,
  roleLabel,
  sortParticipants,
  surfaceLabel,
  whyCannotDrive,
  type VibeParticipant,
  type VibeSession,
} from "./machineResources";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const seat = (over: Partial<VibeParticipant>): VibeParticipant => ({
  id: "u@web",
  userId: "u",
  displayName: "Someone",
  surface: "web",
  role: "viewer",
  isGuest: false,
  ...over,
});

console.log("describePort — the client must never have to guess the port");
check("no status → nothing to say", describePort(null) === null);
check("plain port", describePort({ port: 9100 }) === "serving on :9100");
check(
  "substituted port explains itself",
  describePort({ port: 9103, preferredPort: 9100, portSubstituted: true }) ===
    "serving on :9103 (:9100 was already in use on this machine)",
  describePort({ port: 9103, preferredPort: 9100, portSubstituted: true }) ?? "null",
);
check(
  "substitution flag with equal ports is not narrated",
  describePort({ port: 9100, preferredPort: 9100, portSubstituted: true }) === "serving on :9100",
);

console.log("describeResources");
check("empty", describeResources([]) === "");
check(
  "ports and devices in one line",
  describeResources([
    { type: "port", kind: "flutter", value: "9100", label: "flutter on :9100" },
    { type: "device", kind: "ios-simulator", value: "323C65E7", label: "ios-simulator 323C65E7" },
  ]) === "flutter on :9100 · ios-simulator 323C65E7",
);

console.log("labels");
check("surface ios normalised upstream → Phone", surfaceLabel("mobile") === "Phone");
check("unknown surface passes through", surfaceLabel("submarine") === "submarine");
check("driver reads as an ability", roleLabel("driver") === "Can vibe");
check("viewer reads as passive", roleLabel("viewer") === "Watching");

console.log("sortParticipants — owner, drivers, then viewers");
const sorted = sortParticipants([
  seat({ id: "v@web", userId: "v", displayName: "Zoe", role: "viewer" }),
  seat({ id: "d@tv", userId: "d", displayName: "Ada", role: "driver" }),
  seat({ id: "o@web", userId: "o", displayName: "Owner", role: "owner" }),
]);
check("owner first", sorted[0].role === "owner");
check("driver second", sorted[1].role === "driver");
check("viewer last", sorted[2].role === "viewer");

console.log("describeParticipants — silence when solo, news when joint");
check("solo says nothing", describeParticipants([seat({ role: "owner" })], "u") === "");
check("empty says nothing", describeParticipants([], "u") === "");
const joint = describeParticipants(
  [
    seat({ id: "o@web", userId: "o", displayName: "Kivanc", role: "owner", surface: "web" }),
    seat({ id: "g@mobile", userId: "g", displayName: "Batikan", role: "viewer", surface: "mobile" }),
  ],
  "o",
);
check("counts everyone", joint.startsWith("2 here"), joint);
check("names the other person and their surface", joint.includes("Batikan (Phone)"), joint);
check("says how many can type", joint.includes("1 can vibe"), joint);

console.log("canDrive / whyCannotDrive — a dead control must explain itself");
check("owner drives", canDrive("owner"));
check("driver drives", canDrive("driver"));
check("viewer does not", !canDrive("viewer"));
check("missing role does not", !canDrive(undefined));
check("owner has no reason to show", whyCannotDrive("owner") === null);
check(
  "viewer is told who to ask",
  (whyCannotDrive("viewer") ?? "").includes("owner"),
  whyCannotDrive("viewer") ?? "null",
);
check(
  "absent participant is told to re-join",
  (whyCannotDrive(undefined) ?? "").includes("re-join"),
  whyCannotDrive(undefined) ?? "null",
);

console.log("mySeat — the same person on two surfaces has two seats");
const session: VibeSession = {
  id: "vs_1",
  ownerUserId: "o",
  project: "e-mobile",
  participants: [
    seat({ id: "o@web", userId: "o", role: "owner", surface: "web" }),
    seat({ id: "o@mobile", userId: "o", role: "owner", surface: "mobile" }),
  ],
  resources: [],
};
check("picks the seat for MY surface", mySeat(session, "o", "mobile")?.surface === "mobile");
check("falls back to any seat", mySeat(session, "o")?.userId === "o");
check("stranger has no seat", mySeat(session, "stranger") === null);

console.log("describeMachine");
check(
  "idle machine says so",
  describeMachine({ sessions: [] }) === "No active sessions on this machine.",
);
const machine = describeMachine({
  sessions: [
    {
      ...session,
      resources: [{ type: "port", kind: "flutter", value: "9100", label: "flutter on :9100" }],
    },
    {
      id: "vs_2",
      ownerUserId: "o",
      project: "todo-rn",
      participants: [seat({ id: "b@mobile", userId: "b", surface: "mobile" })],
      resources: [{ type: "device", kind: "android-emulator", value: "emulator-5554", label: "android-emulator emulator-5554" }],
    },
  ],
});
check("counts sessions", machine.includes("2 sessions"), machine);
check("names projects", machine.includes("e-mobile") && machine.includes("todo-rn"), machine);
check("counts distinct people, not seats", machine.includes("2 people"), machine);
check("counts resources", machine.includes("2 resources"), machine);
check(
  "singular reads correctly",
  describeMachine({ sessions: [{ ...session, participants: [seat({})], resources: [] }] }).includes(
    "1 session",
  ),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
