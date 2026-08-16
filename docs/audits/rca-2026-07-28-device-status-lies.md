# RCA — the device-status family of lies (2026-07-28)

One user-visible sentence — *"Re-auth failed: all transports failed. relay ·
public-free/direct: device not connected to relay"* — sat on top of **five
independent defects**, each of which can hurt any user, none of which is
specific to this account or this box.

This is written for the next person who sees a device card claiming something
the machine is not doing. Read §6 first if you are in a hurry.

---

## 1. What the user saw

- Sidebar: `ubuntu-4gb-hel1-1 · Linux · v1.99.389 · needs auth`, with a
  **RE-AUTH** button and a panel headed *"Yaver agent needs auth"*.
- Device card: **"Alive · can't reach (Unauthorized)"**.
- Pressing RE-AUTH: *"all transports failed … device not connected to relay"*.

## 2. What was actually true at that moment

- The box was **healthy and reachable**: `GET https://public.yaver.io/d/5e79cf10…/health`
  returned **HTTP 200**, agent v1.99.389, and coding tasks were running on it
  end-to-end throughout.
- Convex reported that device `needsAuth: false`.
- A **second** agent existed on the same machine — `yaver-sim.service`
  ("Yaver isolated circuit-simulator service (relay-only, circuit-scoped)"),
  `/usr/local/bin/yaver-sim serve --port 18090 --quic-port 4434 --relay-only`,
  bound to **127.0.0.1:18090** (loopback only, verified with `ss -ltnp`),
  registered as its **own device row** with its **own hardwareId**, v1.99.259,
  `needsAuth: true`, and **no relay tunnel**.

## 3. The five defects

### D1 — A scoped service cell registers as a peer MACHINE
`yaver-sim` is a *cell*: one capability, loopback-bound, deliberately not a
general-purpose box. Nothing in registration says so, so it lands in
`devices` as a full machine with the **same display name** as its host, and
every surface offers it as a connect target. The user opened *its* workspace
(the card showed "Close Workspace" while the healthy card still said "Try
Connect") — an entirely reasonable click, because the two rows are visually
near-identical.

> **Lesson: capability ≠ machine.** Anything that registers must declare what it
> is. A thing that cannot host a session must never be offered as one.

### D2 — Identity and state render from different sources
The connected-device pill draws `name`/`needsAuth` from the device row but
`version` from `agentInfo` — the *currently connected agent's* `/info`
(`web/app/dashboard/page.tsx` ~2933). When those two are different devices the
pill is a chimera: the cell's `needsAuth` wearing the healthy box's `v1.99.389`.
That is why the sidebar could say "v1.99.389 · needs auth" when **no single
device was in that state**.

> **Lesson: one row, one source.** Never compose a status line from two
> identities. If they can disagree, they will, and the composite describes
> nothing that exists.

### D3 — A transport-credential 401 is reported as a device state
The relay answers a missing/stale account relay password with
`HTTP 401 {"code":"Unauthorized","error":"relay password missing — sign in again to fetch it"}`.
`code` there is merely `http.StatusText(401)`. The dashboard rendered that
literal token as the machine's condition: **"Alive · can't reach
(Unauthorized)"**. Proven in one pair of requests against the same device,
seconds apart: **with** `X-Relay-Password` → 200; **without** → 401.

> **Lesson: attribute a failure to the layer that produced it.** "I could not
> authenticate to the relay" is not "the agent is unauthenticated". A middlebox
> refusing *my* credential says nothing about the far end.

### D4 — The remedy offered could not possibly run
RE-AUTH/RECLAIM renders on a Convex flag alone, with no reachability
precondition — even though `deriveBrowserReach` / `canBrowserActOnDevice`
already exist for exactly this (`web/lib/device-lifecycle.ts`). Its transports
are `${relay}/d/<deviceId>/auth/recover` and `/auth/pair/owner-claim`; the relay
resolves tunnels by **exact** deviceId (hardened in `82d8bb805`), and the cell
has no tunnel, so both 502. The LAN lane is skipped by design from an https
origin. **Zero viable transports — structurally impossible, not flaky.**

> **Lesson: a button is a promise.** Do not offer a fix whose only channel is
> the one that just failed. Gate the CTA on the capability, not on the symptom.
> This is the same circular trap as the dead-token box whose only remote repair
> rides the tunnel a dead token prevents.

### D5 — The error names lanes, not the situation
*"all transports failed. relay · public-free/direct: device not connected to
relay"* is a transport dump. The product knew far more than it said: which
device, that it was a loopback-bound cell on port 18090, that its host was
reachable, and that the remedy was `yaver auth` on the box or forgetting the
row. The relay even returns a machine-readable
`reasonCode: connectivity.relay.device_not_connected` that the web classifier
already understands.

> **Lesson: the user cannot act on a lane label.** Say what happened, to which
> thing, and what to do next.

---

## 4. The meta-pattern

Every one of D1–D5 is the same shape the codebase already has a rule for:
**something reported an inventory instead of an operation.**

| Layer | Inventory it reported | Operation that was true |
|---|---|---|
| Registration | "a device exists" | it can host nothing; it is loopback-bound |
| Pill | "a version string" | it belongs to a different device |
| Status | "a 401 happened" | *my* relay credential is stale |
| CTA | "a flag says needsAuth" | no transport can carry the fix |
| Error | "these lanes failed" | this row is a cell with no tunnel |

The debugging cost is multiplicative, not additive: five plausible half-truths
compose into a coherent-looking story ("the agent lost its auth") that is
entirely false, and each layer corroborates the others.

## 5. The sixth defect — we could not tell if the fix shipped

While diagnosing, a corrected classifier was deployed and **verified present in
the served JS**, yet the browser kept rendering the old copy from cache. The
sidebar read `v1.1.162` before and after, because that is a hand-maintained
semver in `web/package.json` that a deploy never touches. *"Never shipped"* and
*"shipped, your tab is stale"* were the same pixels.

Fixed: `scripts/deploy-web.sh` stamps `NEXT_PUBLIC_BUILD_ID` from the deployed
git SHA and the sidebar renders `v<semver> · <sha>` (`web/lib/buildStamp.ts`).

> **Lesson: every surface must be able to say which build it is.** A version
> a human types cannot answer that question.
>
> Note the guard for this was itself a false green on the first attempt —
> commenting out the `export` still passed, because the assertion matched those
> words inside a *comment*. Strip comments before asserting on a script. A guard
> you have not watched fail is a guess.

## 6. What must be true from now on

1. A registering process declares **what it is**; only things that can host a
   session are offered as machines.
2. A status line is built from **one** identity.
3. A failure is attributed to the **layer that produced it**; relay-credential
   refusals never mutate a device's auth state.
4. A remedy is offered only when a transport exists to carry it, and when one
   does not, the UI says which capability is missing.
5. Errors name **the thing and the next step**, never the lanes.
6. Every surface prints a build id its deploy set.

Cross-surface, all six — mobile, web, tvOS, watchOS, Wear OS, car, glass, CLI.
A rule enforced on one surface is not enforced.
