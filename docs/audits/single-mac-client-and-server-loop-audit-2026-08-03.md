# One Mac as BOTH client and server for the closed loop, over the relay

**Date:** 2026-08-03
**Status:** ANALYSIS ONLY — nothing built, by request.
**Question:** can this Mac host the agent *and* every client surface, talking to
itself over the relay, so the loops run fast and cover all cases?

---

## 0. Verdict up front

**Yes for most surfaces, and it is a genuinely good idea for SPEED — but it is
not "all cases", and one specific case it removes is the one this week's bugs
kept hiding in.**

Use it as the **fast lane**. Keep a remote box as the **truth lane**. The moment
it becomes the only lane, a whole class of defect stops being reachable.

---

## 1. What it would buy (measured against tonight's actual costs)

| Cost today | With a self-hosted loop |
|---|---|
| Every vibe turn crosses the relay to Hetzner | loopback / LAN — turn latency drops to the runner's own time |
| `yaver ssh linux` flaked twice tonight; the box's auth expired twice | no remote auth to expire mid-run |
| Box was on 1.99.397 while the fix sat in 1.99.399 — a **release cycle** per agent fix | rebuild + restart locally in seconds |
| Chrome on the box was snap-confined; discovered only via a 400 | this Mac's Chrome is already known-good |
| Simulators (tvOS, visionOS, watch) live HERE, the box is Linux | client and render target finally co-located |

That last row is the strongest argument. **tvOS and visionOS simulators cannot
run on the Linux box at all**, so today the "client" half of a TV loop is on this
Mac while the "server" half is in Hetzner — a split that buys nothing and costs a
network round trip per frame.

---

## 2. What it would NOT cover — the honest list

### 2a. The relay is only *partly* exercised

Two devices owned by one account, both on this Mac, still register distinct
`deviceId`s, so the relay's **pass-through + access-graph scoping** is exercised.
What is NOT exercised:

- **NAT traversal / CGNAT** — the real reason the relay exists. Loopback never
  fails to find a path.
- **The transport LADDER** — LAN beacon → Convex-known IP → relay. On one host
  the first rung always wins, so a relay-only regression (the class that produced
  "Transport pending · Agent status unavailable") stays invisible.
- **Latency-shaped bugs** — the stale-iframe defect found tonight only appeared
  because a turn took minutes. A fast loop can hide races that a slow one exposes.

### 2b. `deviceId already registered` is a real constraint

`relay/server.go:1226,1457` rejects a second registration for the same
`deviceId`, and same-owner eviction is deliberate. Running two agent instances on
one Mac therefore needs **two distinct device identities** (separate
`YAVER_CONFIG_DIR`/HOME), not one binary twice. Doable, but it is setup, and a
half-done version fails as a confusing eviction rather than a clear error.

### 2c. Yaver-on-Yaver is REFUSED for the Hermes lane, by design

`devserver_http.go:3268` returns **409 `YAVER_SELF_DEVELOPMENT_RECURSION`**:
loading a Hermes bundle of Yaver into the Yaver container puts two identical
shake/exit owners in one RN process and the preview cannot be exited. So a
single-Mac loop that vibes *Yaver itself* must use the **browser / WebRTC**
lane — which is exactly what the refusal's own remedy says. Not a blocker; a
constraint to design around, and the product already states it.

### 2d. Resource contention is not theoretical here

This Mac hit **load 270** tonight with five booted simulators plus one Xcode
archive, and a Playwright run starved to the point of producing false timeouts.
Co-locating agent + runner + simulators + browser multiplies that. A "fast" loop
that reports a timeout because the machine was saturated is a **false red**, and
this session already paid for four of those.

### 2e. One machine cannot prove the runner/render SPLIT

The product's interesting shape is "runner box ≠ render box" (`task_ensure_clone.go`,
the seeded-role resolution, `resolveSeededRole`). Collapsing both onto one host
means the split path is never taken, and its bugs — a checkout missing on the
render box, a stale clone, autoPush not converging — cannot appear.

---

## 3. What it WOULD cover, that the remote box cannot

- **tvOS / visionOS / watch simulators** — impossible on the Linux box; native to
  this Mac. This is the decisive win.
- **The Apple Vision text oracle** — macOS-only by construction. Client and
  oracle on one host means every frame gets a NAMED verdict with no transfer.
- **Agent-fix turnaround** — tonight a one-line Chrome preference needed a signed
  npm release before a loop could test it. Locally that is a rebuild.
- **Codesigning / Keychain paths** — cannot be exercised on Linux at all.

---

## 4. Recommended structure (if it is built later)

**Three lanes, not one.** The names matter because "it passed" must say *where*.

| Lane | Host(s) | Purpose | Runs |
|---|---|---|---|
| `local-fast` | this Mac, agent + clients, LAN/loopback | iterate on harness + product in seconds | every change |
| `relay-real` | Mac client → **remote box** over relay | prove the transport ladder + NAT path | before merge |
| `split-roles` | runner box ≠ render box | prove clone/converge and seeded roles | nightly |

Rules that keep it honest:

1. **A pass in `local-fast` is never a release signal.** State the lane in the
   verdict line, always.
2. **Two identities, explicitly** — separate `YAVER_CONFIG_DIR` per agent, or the
   relay's `deviceId already registered` will evict one and look like a network
   fault.
3. **Cap concurrency.** One heavy job at a time; the load-270 incident is the
   evidence. A starved run must be reported as starved, not as failed.
4. **Vibe a FIXTURE, not Yaver**, in the fast lane — `yaver-todo-rn` and friends
   exist precisely so the app under test is not the app running the test. This
   also sidesteps 2c entirely.
5. **Keep the remote box on the release path.** Its value is being *different*:
   different OS, different Chrome packaging, real network. Every one of tonight's
   four product bugs — snap Chromium, the Convex model normalizer, quota
   classification, z.ai 1113 — came from that difference.

---

## 5. The one-line answer to "does it cover all cases?"

**No — it covers all SURFACES, which is not the same thing.** It is the only way
to reach tvOS/visionOS/watch at all, and the fastest way to iterate. It cannot
cover NAT, the transport ladder, the runner/render split, or OS-packaging
differences, and those are where this week's real defects actually lived.
Build it as the fast lane; do not retire the remote box.

---

## 6. Related finding: why the box did not self-update tonight

Asked during this audit: *why doesn't the box periodically check npm/GitHub for
the latest agent and update itself?*

**It does.** `main.go` runs a periodic loop gated on `shouldAutoUpdate(cfg)`, and
`checkAutoUpdate` resolves **GitHub releases** — not Convex — which is the right
source (it is where the signed binaries actually are). It also fires on startup,
on self-heal, and on an explicit surface request (`agent_update_request.go`).

So the mechanism is correct. The reason it was useless tonight is the INTERVAL:

```go
// auto_update_policy.go
func autoUpdateCheckInterval() time.Duration {
    const min = 6 * time.Hour
    const spread = 6 * time.Hour
    return min + time.Duration(rand.Int63n(int64(spread)))
}
```

**6–12 hours, jittered.** Correct for a fleet — it spreads load and avoids a
thundering herd on the release host. Useless for the loop we were actually
running, where the sequence was: find a bug → fix it → cut 1.99.399 → *need that
agent on the box within a minute*. I hand-ran `npm i -g` on that box twice
tonight for exactly this reason, and even then the box sat on 1.99.397 while the
fix was in 1.99.399.

### The gap, stated as a product requirement

Two different needs are being served by one timer:

| Need | Right cadence | Today |
|---|---|---|
| Fleet keeps current | 6–12 h, jittered | ✅ correct |
| **A box under active development takes a fix NOW** | seconds, on demand | ❌ manual ssh |

`agent_update_request.go` already implements the second one — *a surface can
request a version and the box applies it*. So the primitive exists and the gap is
that nothing in the DEV loop calls it: the closed-loop harness, `deploy.sh`, and
the release path all finish without telling the boxes a new version exists.

### Snowball fix (not built here — analysis only, as asked)

1. **After a release, ANNOUNCE it.** `build-cli-native.sh` / `deploy.sh npm`
   should, on success, poke every owned+reachable box through the existing
   update-request path. The release already knows the version; the boxes should
   not have to wait 6 hours to hear about it.
2. **The loop harness should assert the agent version it is testing against.**
   Tonight's tvOS arc ran against 1.99.397, failed on a bug fixed in 1.99.399,
   and nothing in the output said the box was stale. A one-line
   `GET /info` → compare-to-expected turns that into a NAMED skip instead of a
   confusing red.
3. **systemd is not the right home for it.** The agent already owns the timer,
   knows whether tasks are running (it defers an update that would kill them),
   and can self-heal. A systemd timer would duplicate that and lose the
   running-task check — a restart mid-vibe is exactly what the current code
   avoids. Keep the policy in the agent; systemd only supervises the process.

### 6b. Check npm, fetch from GitHub

Follow-up question, and it improves the design: *GitHub is free for a public
repo — is the rate limit even relevant?*

Two different things, worth separating:

- **Cost is zero.** Public repo, unmetered release downloads. Nothing here is a
  billing concern.
- **Throttling is still real.** GitHub's REST API allows **60 requests/hour per
  source IP unauthenticated**, regardless of the repo being public. It only bites
  when many agents share one egress — a datacenter — which is precisely the case
  the original 6-hour interval was defending against.

But the version question does not have to go to GitHub at all:

| | GitHub API | **npm registry** |
|---|---|---|
| Rate limit | 60/h per IP unauthenticated | none comparable — CDN-fronted, built for mass reads |
| Endpoint | `releases/latest` | `registry.npmjs.org/yaver-cli/latest` |
| Conditional requests | ETag → 304 | ETag → 304 |
| Canonical for…| the signed BINARIES | the VERSION — npm is the only supported install path (CLAUDE.md) |

**So: check npm, fetch from GitHub.** The "is there something new" poll goes to a
CDN with no per-IP ceiling; the signed, notarised asset still comes from the
GitHub release. That removes the shared-egress worry entirely — which was the
only justification for a 6-hour cadence — and it is how npm's own
`update-notifier` works: it polls the registry, not a git host.

Precedent already in-tree: `mcp_registries.go` fetches
`https://registry.npmjs.org/<pkg>`, and `deploy_tokens.go` calls
`registry.npmjs.org/-/whoami`. The client code to reuse exists.

**Not landed here.** The interval is tightened to 1–2h (`a1f94a25e`), which is
safe under the current GitHub check. Repointing the version probe at npm touches
the update path itself, and that path restarts the agent — it deserves its own
change with a guard that proves a stale box updates and a current one does not
restart. Doing it half-verified at the end of a long session is how the "silent
serve" class of bug gets introduced.
