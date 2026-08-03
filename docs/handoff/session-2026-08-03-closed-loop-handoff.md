# Handoff — 2026-08-03 · tvOS + visionOS closed loops PASS

**Previous focus (delivered):** closed-loop tests for tvOS + AR/VR using the
Vision text oracle, against ubuntu-4gb.

Read `CLAUDE.md` first. The rule that governed all of this is written there:
**headless first, then closed loop, and snowball both.**

---

## 1. State — what is actually true now

| Loop | Verdict | Evidence |
|---|---|---|
| **Web** (dashboard → ubuntu-4gb) | ✅ PASSED | unchanged this session |
| **tvOS** | ✅ **PIXELS** | black→RED→black, agent 1.99.400+, opencode/`glm-5.2` |
| **visionOS (AR/VR)** | ✅ **PIXELS** | same arc, `vision` profile (1280x720) |
| **Mobile** (RN-web, iPhone 15 Pro ctx) | ⏸ not re-run | box side cleared (below); oracle now wired |
| watch / Wear / car | ⬜ no arc | inherit `_framePixels` + `_visionOracle` when written |

```bash
set -a && . ./.env.test && set +a
VIBE_BOX_HOST=http://100.75.123.78:18080 npx tsx e2e/native-headless-vibe.mjs tv
VIBE_BOX_HOST=http://100.75.123.78:18080 npx tsx e2e/native-headless-vibe.mjs vision
```

**Prerequisite:** a dev server must be running on the box. The arc does not start
one (it only starts the *capture*), and it NAMED-skips if none is found:

```bash
curl -s -X POST -H "Authorization: Bearer $YAVER_TEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"framework":"expo","workDir":"/root/Workspace/yaver.io/mobile","devMode":"web"}' \
  http://100.75.123.78:18080/dev/start
```

---

## 2. Why the TV/vision arcs had never passed — three stacked defects

They were blocked on the box being unable to launch a browser. But **the arc
could not have passed even after that was fixed**:

1. It walked the **compressed PNG** three bytes at a time and called the result
   RGB. Every colour it produced was sampled from a zlib stream.
2. It handed an **array of triples** to `classifyVibeColor`, which takes a flat
   `[r,g,b]` — so the type guard returned `"unknown"` for every frame, forever.
3. It never asked whether the box **could** capture. The agent already knew and
   said so; the arc waited 12 minutes for a frame that could not exist.

Fixed by `e2e/_framePixels.mjs` (dependency-free PNG decoder, 13 round-trip
assertions incl. a negative control that the old byte-walking path *cannot*
reach a colour) and a capability preflight. The arc now gates in seconds:

```
agent < 1.99.400      → SKIP (NAMED) + the exact npm command
browser cannot launch → SKIP (NAMED) + the exact apt command
```

---

## 3. Product defects found by RUNNING it (all shipped, all with guards)

| Shipped | Defect |
|---|---|
| **1.99.400** | `/usr/bin/chromium-browser` is Ubuntu's **snap redirector** — innocent path, identical confinement failure — so 1.99.399's `/snap/` path test was incomplete. Chrome is now chosen by **running `--version`**. Same change fixed `probeBrowserLaunches`, which searched `chromium` first and **returned on the first failure**, reporting "Stream over WebRTC — not supported" on a box with a working Google Chrome. |
| **1.99.401** | The capture **viewport was reported but never applied**: arc asked 1920x1080, API answered 1920x1080, PNG was 1280x757 (`WindowSize(1280, 900)` hardcoded). Every TV/vision/watch verdict was reached at desktop size. Verified after: **1920x937** — width exact; 143 px is browser chrome. |
| **1.99.402** | The **orphan reaper spared every child it spawned**. See §4. |
| — | `./deploy/deploy.sh npm` — the canonical front door — died on macOS bash 3.2 with `pass_args[@]: unbound variable` whenever no extra flag was passed. |

---

## 4. The dev-server orphan leak — read this before touching the reaper

Eight orphan Expo trees on ubuntu-4gb, `ppid=1`, ages to **6.4 days**, **1,653 MB**
resident, one squatting port 8081 and serving a **different project** (sfmg).

`ReapOrphanedDevChildren` was running the whole time and **sparing** them:

```
pid 4170444 · :8088 — a stale record claims this PID is a expo, but the live
process is something else · argv does not match "npx,8088" — left alone
```

Two identities were tried and **both were derived from something the process
controls**:

1. **Needles** (`"npx,8088"`) — `npx` re-execs as `npm exec`, so `"npx"` is
   never in the live argv. Unreapable by construction since the registry shipped.
2. **Exact argv captured at spawn** (1.99.401) — defeated live on the very
   restart meant to prove it, because **npx rewrites its own command line**:
   `node …/npx expo start …` → `npm exec expo start …`. Orphan count went 7 → 8.

**The answer is the process START TIME** (1.99.402). `(PID, start time)` is
unique for all time on a machine — a recycled PID necessarily started later.
Linux reads field 22 of `/proc/<pid>/stat`, counted from the **last `)`**.

Three things worth not rediscovering:

- **Sparing is the safe-LOOKING outcome.** The log line reads exactly like the
  guard doing its job. That is why it survived.
- **A spared record is DROPPED from the registry**, so a sparing bug is
  self-erasing — it cannot be retried after a fix. That is why the pre-existing
  orphans had no records (`dev-children.json` read `null`).
- **`KillMode=process` is deliberate** (`main.go:2230`) — it protects the tmux
  server holding remote coding sessions. systemd will therefore *never* reap dev
  children. **The registry is the only cleanup path there is.**

**Verified live on 1.99.402** — spawn a dev child, restart the agent, and the
reaper claims it instead of sparing it:

```
[dev-children] stopped orphaned expo (pid 4193932, port 8082, mobile)
               left by a previous agent — its port is free again
pid 4193932: GONE
```

The record it acted on carried `"startToken": "55898586"`. Note that records
written by an OLDER agent still spare (they have no token and their argv was
rewritten) — the fix takes effect for children spawned by 1.99.402+.

Box resolved 2026-08-03: all orphan trees killed, expo RSS 1,653 → **0 MB**, and
`/dev/start` returns **8081, portSubstituted: none** for the first time in 6.4
days.

---

## 5. The Vision text oracle — now shared by every surface

`desktop/agent/screenread/main.swift` + **`e2e/_visionOracle.mjs`** (extracted so
mobile, web, TV and AR/VR share ONE implementation) + `_visionOracle.d.mts` for
the typechecked caller.

Verified against a live frame: **13 blocks**, read the whole sign-in screen, and
classified it `signed-out` with a named cause. It carries a table mapping what a
screen SAYS to what is wrong: still bundling, signed out, build error, runner
quota, transport pending, browser cannot launch. **Add a row every time a loop
fails for a new reason.**

```bash
xcrun swiftc -O desktop/agent/screenread/main.swift -o desktop/agent/screenread/screenread \
  && codesign --force -s - desktop/agent/screenread/screenread     # SAME command, always
node e2e/screenread-oracle.test.mjs
```

🔴 **Never split compile and sign.** macOS kills an unsigned helper under launchd
with `OS_REASON_CODESIGNING` *while launchd reports "spawn scheduled"* — it looks
like a hang.

Opportunistic, never load-bearing: macOS-only, skips elsewhere, and only ever
ADDS a reason to a failure the colour verdict already reached.

---

## 6. The mobile blocker — the handoff's old hypothesis was WRONG

The previous handoff said *"either the box's expo web preview does not rebundle,
or the arc's refresh is not reaching it"*. Measured: **the bundle is correct.**
The 20.5 MB bundle served on the dev-server port contains the red edit (3 hits of
`backgroundColor: "red"`, matching `login.tsx:484/486/490`).

So the box side is cleared and the fault is downstream. The mobile arc now wires
the oracle into both assertions, so the next failing run says *why* instead of
"preview never turned red (last black)". The iframe is cross-origin, so
`document.body.innerText` could never see the app — the oracle reads pixels and
does not care.

Next step: run it with `MOBILE_WEB_URL` set and read the named cause.

---

## 7. Endpoint facts that cost time

- `GET /vibing/preview/frames/{hash}` requires **`?project=`**. Without it the
  body is `{"error":"project query param required"}` — which the old sampler
  would have classified as a colour.
- `POST /dev/web-preview/start` returns `{"port":19006,"webUrl":"/dev-web/"}` —
  a **relative** URL chromedp cannot navigate, and Expo's *canonical* port, not
  the bound one. Use `/info` → `devServer.port`.
- `POST /vibing/preview/snapshot` is **POST**, not GET.
- Full flow: `/dev/start` → `/vibing/preview/start` → `/vibing/preview/snapshot`
  → `/vibing/preview/frames/{hash}?project=`.

---

## 8. Still open

1. **Idle-aware auto-update** — the user asked for it: an update must not restart
   the agent mid-task. `desktop/agent/agent_update_idle.go` is written
   (busy-probe registry + pure `decideUpdateWindow` + a 12 h starvation ceiling)
   but **not wired and not tested**. The design point: the old "only when idle"
   gate was deleted in 2026-07-17 because a permanently-busy box never updated;
   defer-with-ceiling serves both. Note the coupling to §4 — a restart used to
   orphan a Metro server every time, and the check interval is now 1-2 h.
2. **Repoint the version check at npm** (audit §6b) — designed, not built.
   `registry.npmjs.org/yaver-cli/latest` has no per-IP ceiling; the signed binary
   still comes from the GitHub release. Three call sites hand-roll the GitHub
   lookup today (`main.go` `checkAutoUpdate`, `update_http.go`, `self_heal.go`).
3. **Nothing announces a release to owned boxes.** `agent_update_request.go`
   implements on-demand update; no caller in the release path uses it. Three
   manual `npm i -g` over ssh were the real update mechanism again today.
4. **Mobile arc re-run** (§6).
5. **watch / Wear / car arcs** — the shared primitives now exist.

---

## 9. Traps

1. **`.env.test` has working credentials** — `YAVER_TEST_TOKEN` (valid for the
   box) and `YAVER_TEST_EMAIL`/`PASSWORD`. The mobile arc needs the password path.
2. **`yaver ssh linux` flakes.** Retry once before diagnosing.
3. **`go test` in `desktop/agent` can sign you out** — use a narrow `-run`. The
   new tests isolate both `PATH` **and `HOME`** (`playwrightChromePath` globs the
   real `~/.cache/ms-playwright`, so a test without HOME isolation passes on a
   laptop and fails in CI).
4. **Never pipe a deploy/build script to `tail`** in a background job — the
   output is buffered until exit, so you cannot watch progress.
5. **`tvos/` and `watch/` xcodeproj are gitignored + XcodeGen-generated** — run
   `xcodegen generate` before any native build.
6. Local release path: `./scripts/build-cli-native.sh` → `gh release create` →
   `cd cli && npm publish`. **Release FIRST, npm LAST** — postinstall has no retry.
