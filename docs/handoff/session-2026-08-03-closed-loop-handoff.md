# Handoff — 2026-08-02/03 · closed loops, deploys, failure plumbing

**Next session's focus (user's words):** closed-loop tests for **tvOS + AR/VR**
using the **Vision text oracle**, against **ubuntu-4gb**, and **npm-based
auto-update**.

Read `CLAUDE.md` first — the rule that governs all of this is now written there:
**headless first, then closed loop, and snowball both.**

---

## 1. START HERE — the exact next four steps

Everything below is blocked on one thing: the box cannot launch a browser, so it
cannot capture frames, so the TV/headset loops have nothing to sample.

1. **Cut the 1.99.399 release.** Artifacts are already built, signed and
   notarised in `dist/cli-1.99.399/` (7 assets). It carries the Chrome fix.
   ```bash
   gh release create v1.99.399 --title "Yaver CLI v1.99.399" --generate-notes dist/cli-1.99.399/*
   cd cli && npm publish          # release FIRST, npm LAST — postinstall has no retry
   ```
2. **Update the box:** `yaver ssh linux 'npm i -g yaver-cli@latest && sudo systemctl restart yaver'`
3. **Verify headlessly (seconds, not a 25-min run):**
   ```bash
   set -a && . ./.env.test && set +a
   curl -s -m 30 -X POST -H "Authorization: Bearer $YAVER_TEST_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"project":"mobile","targetUrl":"http://127.0.0.1:8086","mode":"live","width":1280,"height":800}' \
     http://100.75.123.78:18080/vibing/preview/start
   ```
   Expect `ok:true`. If it still 400s with *"cannot create temporary directory"*,
   the box did not actually take the new agent — check `/info` version.
4. **Then run the arcs, sequentially:**
   ```bash
   set -a && . ./.env.test && set +a
   VIBE_BOX_HOST=http://100.75.123.78:18080 npx tsx e2e/native-headless-vibe.mjs tv
   VIBE_BOX_HOST=http://100.75.123.78:18080 npx tsx e2e/native-headless-vibe.mjs vision
   ```

---

## 2. Closed-loop state — what is actually true

| Loop | Verdict | Evidence |
|---|---|---|
| **Web** (dashboard → ubuntu-4gb) | ✅ **PASSED** | `1 passed (4.7m)`, black→RED→black in pixels, OpenCode/GLM-5.2. Video was lost to the old shared output dir (fixed since — `aa93ff76b`). |
| **Mobile** (RN-web, iPhone 15 Pro ctx) | ❌ not green | Reaches the vibe; the runner **does** edit `login.tsx` on the box (`5 +++--`), but the preview never shows red. |
| **tvOS** | ⏸ never ran | `/vibing/preview/start` → 400, snap Chromium |
| **visionOS** | ⏸ never ran | same |

### The mobile blocker, precisely
The task lands in `review`, `git diff` on the box shows the correct edit, and the
sampled frame stays black. Either the box's expo web preview does not rebundle,
or the arc's refresh is not reaching it. **Diagnose from the box, not the test** —
that is how the last four false reds were caught.

---

## 3. The Vision text oracle — READY, and the highest-ROI lever

`desktop/agent/screenread/main.swift` + `e2e/screenread-oracle.test.mjs`.

Measured on the tvOS sign-in fixture: **483 ms, 6 blocks, confidence 1.00**, and
it read the device code `EXUY-2270` off the screen. That is a new **capability**:
tvOS headless auth needs no human.

```bash
xcrun swiftc -O desktop/agent/screenread/main.swift -o desktop/agent/screenread/screenread \
  && codesign --force -s - desktop/agent/screenread/screenread     # SAME command, always
node e2e/screenread-oracle.test.mjs                                 # 2 assertions, both pass
```

🔴 **Never split compile and sign.** macOS kills an unsigned helper under launchd
with `OS_REASON_CODESIGNING` *while launchd reports "spawn scheduled"* — it looks
like a hang. That took this repo's agent down on 2026-07-25.

The binary is gitignored (built locally). It is **opportunistic, never
load-bearing**: macOS-only, skips elsewhere, and only ever ADDS a reason to a
failure the colour verdict already reached. Design: `docs/architecture/APPLE_VISION_TEXT_ORACLE.md`.

---

## 4. npm auto-update — decided, half-landed

- ✅ **Hourly cadence landed** (`a1f94a25e`): 6–12 h → 1–2 h jittered. 6 h is a
  desktop-app number (Chrome ~5 h, Sparkle 24 h); daemons that must carry fixes
  sit at 1–4 h.
- ⬜ **Repoint the version check at npm** — designed, not built. Rationale in
  `docs/audits/single-mac-client-and-server-loop-audit-2026-08-03.md` §6b.

**Check npm, fetch from GitHub.** GitHub is free for a public repo but the REST
API is throttled at **60 req/h per source IP** unauthenticated, which bites a
datacenter behind one egress. `registry.npmjs.org/yaver-cli/latest` has no
comparable ceiling, supports ETag/304, and npm is the canonical install path.
Precedent in-tree: `mcp_registries.go`, `deploy_tokens.go` already call it.

**Why it was not landed:** it touches the path that **restarts the agent**. It
needs a guard proving a stale box updates *and* a current one does not restart.

**Also missing:** nothing announces a release to owned boxes.
`agent_update_request.go` already implements on-demand update; no caller in the
release path uses it. Tonight the box sat on 1.99.397 while the fix was in
1.99.399, and two manual `npm i -g` over ssh were the real update mechanism.

---

## 5. Shipped this session

**Deploys:** iOS TestFlight **500** (VALID, carries watchOS + CarPlay) · **tvOS** ·
**visionOS** · **Play/Android 290** (carries Wear OS) · Convex prod ×2 ·
Cloudflare web ×2 · npm **1.99.397** then **1.99.398** · ubuntu-4gb agent 1.99.398.

**Product bugs fixed** (each with a guard):
1. Browser feedback recordings never linked to their report — `.webm` unhandled
2. Five landed features un-landed by an abandoned merge — restored
3. Dead click on device-code approval when the session expired
4. tvOS/web named one failure differently (`relay-auth` vs `auth`); the parity
   guard substring-matched past it
5. **The whole stack pointed at a Codex model the subscription refuses** — Convex
   normalizer, both defaults, the dispatch funnel. Probed on two machines:
   `gpt-5.6-terra/sol/luna`, `gpt-5.5`, `gpt-5.4` **work**; `gpt-5.3-codex` is
   **rejected**
6. `runner.quota.exhausted` — quota walls were reported as generic subprocess
   crashes, advising a model change that cannot help
7. z.ai **1113** classifier, with the Coding-Plan caveat
8. `testflight_builds` MCP verb — dead since inception (`altool --list-builds`
   does not exist)
9. iOS DerivedData in `/tmp` → every archive a cold 2,270-file build (~45 min)
10. Play deploy killed by a `cp` of a file onto itself, right after
    "BUILD SUCCESSFUL"
11. visionOS archive broken by a duplicate `FailureSignals.swift`
12. **Snap-confined Chromium** chosen over `/usr/bin/google-chrome`
13. `createTask` on the shared native client — **the single reason tvOS,
    visionOS, watch and Wear could never start a vibe**
14. Client↔agent **render-lane negotiation**, incl. joint sessions (TV + watch)

**Harness bugs fixed** — all four were the *test* lying while the product worked:
dashboard selectors in the mobile path; a sign-in check that read the runner's own
`grep "Continue with Apple"` output as proof of logout; a preview polled without
ever being re-rendered; exact-text matching against paths the UI truncates.
Plus: loop artifacts were deleted by the next run, and the mobile arc's
hand-created context never recorded video despite `video: "on"` (config applies
only to Playwright-managed contexts).

---

## 6. Traps that will cost you time

1. **`.env.test` has working credentials** — `YAVER_TEST_TOKEN` (valid for the
   box) and `YAVER_TEST_EMAIL`/`PASSWORD`. The mobile arc needs the password
   path; a token alone leaves every device call 401.
2. **This Mac's `yaver` CLI session expires often.** `yaver auth` → approve on
   the phone. `.env.test`'s token is independent and kept working all night.
3. **`yaver ssh linux` flakes.** Retry once before diagnosing.
4. **Load.** This Mac hit **270** with five simulators + an Xcode archive; a
   starved Playwright run produces false timeouts. `xcrun simctl shutdown all`.
5. **`tvos/` and `watch/` xcodeproj are gitignored + XcodeGen-generated** — run
   `xcodegen generate` before any native build.
6. **Never pipe a deploy script to `tail`** — the pipeline's exit code is
   `tail`'s, and it masked two real failures this session.
