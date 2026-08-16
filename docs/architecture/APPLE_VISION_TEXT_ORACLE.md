# Apple Vision as Yaver's Text Oracle — architecture, MCP surface, closed-loop integration

**Status: DESIGN + measured feasibility. No code landed yet.**
Written 2026-08-03. Author session measured everything in §1 on this Mac; everything
else is design. A later session MUST re-verify §1 on the machine it runs on rather
than trusting this file — see the repo's first rule: *markdown drifts, code is the
source of truth.*

**Read `docs/architecture/FAILURE_PLUMBING_ARCHITECTURE.md` first.** This document is
an instance of that law, not an exception to it. Every capability here ships with
detection → signal → UI → route-to-fix, or it does not ship.

---

## 0. The one-paragraph thesis

Yaver's closed loop can currently only reach a **`NAMED`** verdict through a DOM
(`e2e/tests/mobile-app-lane-matrix.spec.ts:304`, `page.getByText(NAMED_FAILURE)`).
Every surface without a DOM — tvOS, visionOS, watch, wear, car, glass, the Android
emulator, a WebRTC video frame, a capture-card frame — can therefore only score
`PIXELS` or `SILENT`, and `SILENT` is the only failing verdict. Apple's Vision
framework turns any *frame* into *text with bounding boxes*, on-device, free, offline,
in ~500 ms. That makes the three-verdict ladder **surface-agnostic instead of
DOM-agnostic**, which is the single largest structural gain available to the test
harness right now. It is macOS-only, therefore it is **opportunistic and never
load-bearing** — that constraint is the spine of this whole design.

---

## 1. What was actually measured (2026-08-03, this MacBook)

Environment: `macOS 26.2` (build 25C56), `Swift 6.2.3`, `arm64-apple-macosx26.0`.

A 71-line Swift CLI using `VNRecognizeTextRequest` + `VNGenerateImageFeaturePrintRequest`:

| Property | Measured |
|---|---|
| Compile (`xcrun swiftc -O`) | **6.7 s**, one file, zero third-party deps |
| Binary size | **67 KB** |
| Runtime deps | Vision.framework + CoreImage — present on every macOS |
| Network | **none** — fully on-device |
| Cost | **$0** — no key, no quota, no rate limit |

OCR, `.accurate` + `usesLanguageCorrection`, on real Yaver screenshots from
`scripts/screenshots/`:

| Input | Time | Blocks | Confidence | Sample read |
|---|---:|---:|---:|---|
| `output-tvos/01_yaver_tv_signin.png` | 480 ms | 6 | **1.00** | `"3. Tap Approve - this Apple TV signs in instantly"` |
| `output-ipad/04_devices.png` | 617 ms | 21 | **1.00** | — |
| `output/04_devices.png` | 492 ms | 24 | **1.00** | — |

Feature-print perceptual distance (`computeDistance`):

| Pair | Distance | Time |
|---|---:|---:|
| identical image | **0.000** | 358 ms |
| devices vs tasks (same app, different tab) | **0.290** | 255 ms |
| devices vs privacy | **0.775** | 226 ms |

**Reading:** rendered UI text is Vision's best case — confidence 1.00 across the
board. Bounding boxes come back normalised, origin **bottom-left** (must be flipped;
see `../medici.ai/slide_ocr.py:74` which already does this and sorts to reading
order). Feature-print distance discriminates cleanly and does not flicker on
antialiasing the way a frame hash does.

### 1a. What is NOT yet verified — do not assume

1. 🔴 **Does Vision work under `launchd` / over SSH with no GUI login?** The probe
   above ran from an interactive shell. This is the single question that decides
   whether any of this works in autorun on the Mac mini. **Probe it, do not infer
   it.** Ten minutes: `launchctl kickstart` a helper that OCRs a fixture and writes
   the result to a file.
2. 🟠 **watchOS availability is contradictory in public sources.** One says Vision
   reached watchOS in 2026; Apple's historical platform line excludes it. Treat as
   unknown; the design below never depends on it.
3. 🟠 **Cross-version determinism.** Apple's own forums carry reports of
   `VNRecognizeTextRequest` returning different results on different Mac
   configurations. This is why §6 forbids golden-file assertions.

---

## 2. Naming — resolve the collision BEFORE writing code

`vision` is already taken **three times** in `desktop/agent/`, and "visionOS" makes a
fourth. A file called `vision.go` will be misread by every future session.

| Existing | Means | Anchor |
|---|---|---|
| `ops_vision.go` | camera **motion/brightness** gate, pure Go, no model | `frameIsBlack`, `frameDiffScore` |
| `ghost_vision.go` | **VLM** UI grounding over OpenAI-compatible chat | `visionLocator.Locate` |
| `machine_driver_vision.go` | **VLM** reading an HMI through a camera | `visionDriver` |
| `visionos/` | Apple Vision Pro **surface** | dir |

**Decision:** the capability is `text_oracle`. The engine string is `apple-vision`
— which matches `../medici.ai`'s provenance value exactly, so the two projects stay
comparable for free. Files: `text_oracle.go`, `text_oracle_apple.go`,
`ops_text_oracle.go`. Never `vision.go`.

---

## 3. Architecture — five layers

```
L4  CONSUMERS   e2e arcs · vibe summariser · ghost grounding · capability report · feedback
                        ▲
L3  MCP/HTTP    ops verbs screen_read / screen_find / screen_diff / screen_assert
                first-class image tool (host model SEES the frame)
                        ▲
L2  SIGNAL      TextOracleResult{engine, confidence, provenance} · reason codes
                        ▲
L1  GO CORE     TextOracle interface · engine registry · probe · capability row
                        ▲
L0  ENGINE      apple-vision helper (Swift, signed)  |  null engine (everywhere else)
```

### L0 — the helper binary, and the codesigning trap

The helper is a small Swift CLI reading a frame path on argv and writing JSON to
stdout. Keep it dumb: no policy, no thresholds, no caching. Policy lives in Go.

🔴 **THE TRAP, from this repo's own history (2026-07-25):** macOS kills an unsigned
binary under `launchd` with `OS_REASON_CODESIGNING`, while launchd still reports
`state = spawn scheduled`. A helper compiled locally at install time is exactly that
binary. It will look like a hang, not a rejection, and it will take the box's whole
agent down the same way it did in July.

Two acceptable paths:
- **Preferred:** ship the helper prebuilt + Developer-ID-signed + notarised in the
  npm payload beside the agent, under `~/.yaver/bin/<version>/darwin-<arch>/`.
- **Fallback (dev only):** compile on the box AND `codesign --force -s -` in the
  **same** command. Never one without the other.

The probe in L1 must therefore attempt an actual **run**, not `os.Stat` the path.
A present-but-killable binary is the canonical "inventory says yes, operation says
no" — the exact class `preview_capability_probe.go` was written to kill.

### L1 — Go core

```go
// text_oracle.go
type TextBlock struct {
    Text       string  `json:"text"`
    Confidence float64 `json:"confidence"`
    // Normalised 0..1, origin TOP-LEFT. The engine adapter flips Vision's
    // bottom-left origin; no consumer should ever have to know that.
    X, Y, W, H float64 `json:"x","y","w","h"`
}

type TextOracleResult struct {
    Blocks []TextBlock `json:"blocks"`
    // Provenance is MANDATORY. medici.ai's own audit flags 94.5% of its corpus
    // as missing provenance and calls it "the quiet one" — it makes the
    // engine-quality question unanswerable after the fact. Do not repeat it.
    Engine     string  `json:"engine"`      // "apple-vision"
    EngineVer  int     `json:"engineVersion"`
    Mode       string  `json:"mode"`        // "accurate" | "fast"
    MeanConf   float64 `json:"meanConfidence"`
    TookMs     int64   `json:"tookMs"`
}

type TextOracle interface {
    Read(ctx context.Context, frame []byte) (TextOracleResult, error)
    Distance(ctx context.Context, a, b []byte) (float64, error)
    Available(ctx context.Context) (bool, string) // false + WHY, never a bare false
}
```

Rules:
- `Available` returns **`(false, reason)`**. A bare false is a disabled button with
  no reason, which `capability_platform.go:31` already forbids for install recipes.
- Result is cached with a TTL and invalidated on agent version change. A probe that
  runs per call turns a 500 ms operation into a 700 ms one.
- **Every `Read` is wall-clock bounded** (`context.WithTimeout`). Per the
  connectivity law: no unbounded await in any path a UI waits on. A wedged helper
  must abandon, not hang.
- The null engine is the default on every non-darwin platform and returns
  `(false, "<honest sentence>")`. It is a real implementation, not a nil check
  scattered at call sites.

### L1b — capability declaration

One row in `capability_platform.go`'s `capabilityToolSpec` table (`:71`), following
the existing shape exactly:

```go
{
    Name:      "text-oracle",
    Supported: func(goos, _ string) bool { return goos == "darwin" },
    Constraint: func(goos, goarch string) string {
        // MUST be non-empty wherever Supported is false — the table enforces this.
        return "Apple Vision is macOS-only; on " + goos + "/" + goarch +
               " Yaver reads previews by colour and structure, not by text. " +
               "Run this arc on a Mac to get text-level assertions."
    },
    InstallBytes: 0, // the helper ships with the agent
}
```

`appleToolchainConstraint` (`capability_platform.go:118`) already exists for exactly
this family of sentences — reuse it rather than inventing a second phrasing.

### L2 — signal

New codes in `reason_codes.go`, following the existing convention (namespaced,
client-read by lookup and **never** by regex — the file's own comment on
`ReasonCapabilityToolchainMissing` explains why: mobile already carries three
divergent relay-auth matchers):

```go
ReasonTextOracleUnavailable = "text_oracle.unavailable"    // wrong platform — no route
ReasonTextOracleHelperMissing = "text_oracle.helper_missing" // has a route: reinstall/repair
ReasonTextOracleHelperBlocked = "text_oracle.helper_blocked" // codesign kill — names the real cause
ReasonTextOracleLowConfidence = "text_oracle.low_confidence" // read succeeded, do not trust verbatim
```

`helper_missing` and `helper_blocked` are deliberately **distinct**. They have
different remedies, and rendering one for the other sends the user to press a button
that cannot help — the same defect as `refresh_lineage_lost` vs `not_authenticated`.

### L3 — MCP surface

Register through `registerOpsVerb` (`ops.go:158`, double-registration panics at
startup by design). Four verbs, deliberately small and composable:

| Verb | Payload | Returns | Why it exists |
|---|---|---|---|
| `screen_read` | `{frame\|url\|project\|source}` | `TextOracleResult` | the raw oracle |
| `screen_find` | `{…, text, fuzzy?}` | `{found, box, confidence}` | tap/click targeting by label |
| `screen_diff` | `{a, b}` | `{distance}` | "did the preview actually change?" |
| `screen_assert` | `{…, expect[], forbid[]}` | `{pass, evidence[]}` | the closed-loop oracle, evidence included |

Plus **one first-class image tool** so a host model can *see* the frame and the read
text together — follow the `circuit_plot` / `appletv_now_playing` pattern exactly
(`mcp_tools.go:3349`, `:3368`; adapters at `httpserver.go:14209`, `:14245`). Those
are thin adapters over the ops verb, reusing the full ops mesh path — do not fork a
second code path.

**Snowball obligation.** These verbs are the "grow a VERB" half of HEADLESS FIRST.
A question a session can only answer by hand-rolling a Python one-liner over SSH is
a product gap. `screen_read` is that gap closed for every surface at once.

**Frame sources the verbs must accept** — all already served by the agent:

| Source | Endpoint | Lane it proves |
|---|---|---|
| vibe preview | `/vibing/preview/snapshot`, `/vibing/preview/frames` | frames |
| Android/redroid | `/droid/frame` | frames (redroid-webrtc) |
| remote desktop | `/rd/frame.jpg` | frames |
| capture card / Apple TV | `/capture/frame.jpg` | frames |
| screenlog | `/screenlog/*` | host activity |
| WebRTC | decoded keyframe (see §5) | webrtc |

### L4 — consumers

1. **e2e arcs** (§6) — the main event.
2. **`vibe_preview_summary.go`** — the `VibeSummarizer` interface already has
   `Source: "noop" | "claude-cli"`. Add `apple-vision` as a **free, offline third
   source** between them: OCR both frames, diff the text sets, emit
   `"nav label changed from Devices to Projects"`. Distance from §1 gives the
   "did anything change at all" gate for free, replacing a brittle hash.
3. **`ghost_vision.go`** — today **every** screenshot goes to a VLM to find a
   button. Make OCR the first tier: a labelled control is found deterministically
   for free; the VLM becomes the escalation for unlabelled/iconographic targets.
   This is a direct, large, recurring cost cut. Measure the hit rate before
   claiming a number (see §7).
4. **`client_render_capabilities.go` / `/project/preview-capabilities`** — report
   the oracle as a property of the box so every surface can render "Text assertions:
   available / unavailable because X".
5. **Feedback + black box** — OCR the attached screenshot so a bug report carries
   the on-screen text as searchable context, without the frame leaving the device.

---

## 4. 🔴 THE LINUX NON-REGRESSION CONTRACT

This is the part most likely to be violated by a session moving fast. Yaver's
production boxes are **Linux** (`yaver-test-ephemeral` is cax21 arm64; managed cloud
workspaces are Hetzner Linux). If the closed loop quietly becomes Mac-only, the
harness reports green on the machines that matter least.

**Five rules. Each has a guard test in §8.**

1. **The oracle is OPPORTUNISTIC, never LOAD-BEARING.** No arc, verb, endpoint, or
   UI path may *require* it. Every consumer degrades to the assertion it makes today
   (colour classification, DOM query, frame hash) and says so.
2. **A missing oracle produces `NAMED`, never `SILENT`, and never a skip.** A test
   that silently skips on Linux is a false green — the exact class this repo has been
   burned by (`simctl 17s`, port-probe orphans). The arc must annotate
   `"text assertions unavailable on linux/arm64 — colour verdict only"` and still
   assert everything it can.
3. **No behaviour change on Linux, provable by construction.** All Apple code sits
   behind the `TextOracle` interface with the null engine as default. No
   `//go:build darwin` file may be imported by a non-darwin path; no call site may
   branch on `runtime.GOOS` — it asks the interface. Today the agent has **zero**
   `//go:build darwin` files and 88 `runtime.GOOS == "darwin"` branches; adding
   build-tagged files is fine, adding a 89th scattered branch is not.
4. **No cgo.** The agent is cgo-light on purpose and cross-compiles for
   linux/amd64, linux/arm64, darwin/*, windows. The helper is a **separate signed
   executable**, shelled out to — exactly like the existing 73 `xcrun` call sites.
   Linking Vision into the Go binary would break every Linux build.
5. **The Linux answer must be a real answer, not an apology.** Where a text-level
   assertion is impossible, say what IS possible in the same breath: colour
   classification via `classifyVibeColor` (`e2e/native-headless-vibe.mjs`),
   structural diff via feature-print's pure-Go stand-in (`frameDiffScore` in
   `ops_vision.go` already exists and runs everywhere), DOM assertions on web/RN-web
   lanes. A Linux box loses *one* oracle, not the loop.

**Explicitly out of scope, and say so rather than half-shipping it:** a Tesseract or
ONNX fallback engine on Linux. It is a different quality profile, a new dependency,
and a new install recipe. If someone wants it later, it is a new engine behind the
same interface — which is why the interface exists. Do not sneak it in with this
change.

---

## 5. Render lanes × what the oracle can read

Lanes are `RenderMode` in `client_render_capabilities.go:36` — `frames`, `iframe`,
`webrtc`, `hermes`. Strategies are `PreviewStrategy` in
`workspace_preview_strategy.go:60-83`.

⚠️ **`client_render_capabilities.go` is currently UNTRACKED** (`git status: ??`).
The handoff session must confirm it landed before building on it, and must not
assume its API is stable.

| Lane | Frame available to the box? | Oracle applies | Notes |
|---|---|---|---|
| **frames** | ✅ natively — JPEG on disk/HTTP | ✅ **direct, zero work** | the lowest common denominator; tvOS's only lane. Best ROI. |
| **iframe** | ⚠️ only client-side | ✅ **via Playwright** `locator.screenshot()` | already done at `e2e/tests/vibe-color-loop.spec.ts:140`. Note the box itself cannot see an iframe a *client* renders — the oracle runs in the harness there, not the agent. |
| **webrtc** | ⚠️ needs a decoded keyframe | ✅ **but requires a tap point** | see below |
| **hermes** | ❌ no frame at all | ❌ **not applicable** | Hermes is a *bundle load*, not a render surface. Its verdict comes from the container's own reporting. Do not fake a frame for it. |

### 5a. The WebRTC case — the one that needs design work

WebRTC is the lane with a real gap. The agent produces the media; nothing in the
pipeline currently persists a decodable still on the **box** side. Options, in order
of preference:

1. **Reuse the existing JPEG-over-DataChannel path.** `remote-runtime-browser-jpeg`
   already exists as an e2e arc and there is a `capture_error` producer at
   `remote_runtime_video_track.go:139` **that nothing reads** (a known
   signal-with-no-consumer). Tapping JPEG frames there is the cheapest correct
   answer and fixes an orphaned signal in the same change.
2. **Client-side read.** The receiving surface decodes the video anyway. On iOS/macOS
   surfaces it can OCR its own decoded frame locally (§9) and report *text*, not
   pixels. This is strictly better for privacy — the frame never moves.
3. ❌ **Do not** add an ffmpeg decode leg on the box purely to feed the oracle. That
   is a new heavyweight dependency in the critical path of an *advisory* feature,
   which violates "advisory work must never sit in the critical path".

⚠️ Per `client_render_capabilities.go:115`, **tvOS and visionOS ship zero WebRTC
client code today**. So for those surfaces the WebRTC row is theoretical; `frames`
is the real lane and where the oracle actually pays.

### 5b. Browser lane

The browser lane (RN-web driven by Playwright) already has a DOM, so OCR is *not*
the primary oracle there. It is still worth one narrow use: **asserting what the
user can actually SEE**, as opposed to what exists in the DOM. Build 482's advisory
wall (`40eec39ef`) squeezed the action lane to zero height — the button was in the
DOM and invisible. A DOM query passes that; an OCR-plus-geometry check does not.
That is the strongest argument for running the oracle even where a DOM exists, and
it maps directly onto the "advisory never outranks the route" law.

---

## 6. Closed-loop test integration

### 6a. The verdict ladder, generalised

Today (`e2e/tests/mobile-app-lane-matrix.spec.ts:56`):

```
PIXELS  a real surface with real content       ← colour/frame heuristics, DOM
NAMED   the product refused and SAID WHY       ← DOM ONLY  ← the gap
SILENT  neither. the only failing verdict
```

With the oracle, `NAMED` becomes reachable from a frame:

```ts
// e2e/lib/textOracle.ts  (NEW — one helper, imported, never reimplemented)
export async function readFrame(png: Buffer): Promise<TextOracleResult | null>
// returns null when the oracle is unavailable. EVERY caller must handle null by
// downgrading its assertion and ANNOTATING — never by skipping.
```

Non-negotiable, mirroring the surfaceViewports rule ("one table, not a literal per
spec"): **one helper, imported by every arc.** The moment two arcs classify text
independently, a TV verdict and a dashboard verdict can drift — which is exactly why
`b5bc94554` imports `classifyVibeColor` rather than reimplementing it.

### 6b. Assertion discipline

Because Vision output can vary across OS versions and hardware (§1a.3):

- ✅ **`contains` / `findsAnyOf`** — "the frame contains 'flutter is not installed'"
- ✅ **absence** — "the frame does NOT contain 'Waiting for the dev server'"
- ✅ **geometry** — "the action button's box is ≥ N px tall and above the fold"
- ❌ **NEVER golden-file / exact-equality on OCR output.** That is a flake generator
  and it will be deleted by a frustrated session six weeks from now.
- ❌ **NEVER assert on a block whose confidence is below the gate.** Follow
  `../medici.ai/ocr_policy.py`: low confidence means *do not speak verbatim*.

### 6c. Per-arc integration plan

| Arc | Today | With the oracle |
|---|---|---|
| `e2e/native-headless-vibe.mjs` (tvOS + visionOS) | colour only via `classifyVibeColor` | **+ text**: reads the TV's own refusal text → `SILENT` becomes `NAMED`. Highest ROI in the repo. |
| `mobile-app-lane-matrix.spec.ts` | DOM `NAMED` | **+ visual `NAMED`** — catches the build-482 case where the text is in the DOM but not on screen |
| `vibe-color-loop.spec.ts` | pixel sampling on iframe screenshot | **+ text delta** as corroboration; distance replaces hash for "did it change" |
| `remote-runtime-browser-jpeg.spec.ts` | frame arrives | **+ read the frame** — proves content, not just delivery |
| **NEW: tvOS device-code auth** | ❌ impossible today | `VNDetectBarcodesRequest` decodes the QR on the sign-in screen → the whole headless-auth arc runs with **no human**. A genuine new capability, not an improvement. |

### 6d. HEADLESS FIRST still applies

The oracle is a *headless* verb (`screen_read` over HTTP/MCP) before it is a browser
assertion. Land the verb, prove it against a stored fixture in seconds, then wire the
arcs. Do not discover a helper-signing bug inside a 25-minute Playwright run — that
is precisely the mistake the 2026-08-02 colour-loop incident paid for twice.

---

## 7. Quality discipline, inherited from `../medici.ai`

`../medici.ai` runs `apple-vision` in production over 1,889 pages
(`slide_ocr.py:57`) and — importantly — **measured** the quality question with a
$0.99 stratified sample against a paid engine as ground truth (`ocr_policy.py`):

| rule | buys | useful | wasted | precision |
|---|---:|---:|---:|---:|
| `render_failed` only | 31 | 29 | 2 | **0.94** |
| *any* `apple-vision` (the intuitive rule) | 186 | 31 | 155 | **0.17** |

> "The intuitive rule buys 6× more pages for 1.2% more text."

**Carry over:**
- **Provenance on every record** — engine, version, mode, confidence. medici's own
  audit flags 94.5% missing provenance as the defect that makes the engine question
  unanswerable in retrospect.
- **Confidence gating** — below the gate, the read is context, never an oracle.
- **Measure before escalating.** If OCR-first ghost grounding (§3 L4.3) is added,
  measure the hit rate on a stratified sample of real screenshots before quoting a
  saving. Do not assert a number this document does not contain.

**Do NOT carry over the pessimism.** medici's weak cases are *scanned, watermarked*
book pages — fragmented, low confidence. Yaver's input is **rendered UI text**, which
measured at confidence 1.00 in §1. Same engine, different problem. A session that
reads medici's caution table and concludes "Vision OCR is unreliable" has drawn the
wrong lesson.

---

## 8. Guard tests — and prove each by breaking it

Per the house rule: *a guard you have not seen fail is a guess.* For each: disable
the fix, watch it fail, restore.

| Test | Asserts | Break it by |
|---|---|---|
| `TestTextOracleNullEngineOnNonDarwin` | non-darwin resolves the null engine with a **non-empty** reason | returning `(false, "")` |
| `TestNoConsumerRequiresTextOracle` | every consumer has a degraded path when `Available` is false | making one arc `require` it |
| `TestTextOracleUnavailableProducesNamedNotSkip` | Linux arc annotates + still asserts; never skips | replacing the annotation with `test.skip` |
| `TestTextOracleProbeRunsHelperNotStat` | probe **executes**; a present-but-unrunnable helper reports unavailable | swapping the run for `os.Stat` |
| `TestTextOracleHelperBlockedIsDistinctFromMissing` | codesign-kill maps to its own code | collapsing the two codes |
| `TestTextOracleResultCarriesProvenance` | engine + version + mode + confidence always populated | dropping a field |
| `TestTextOracleReadIsDeadlineBounded` | a wedged helper abandons | removing the timeout |
| `TestNoCgoAndNoDarwinImportOnLinuxPath` | linux/arm64 + linux/amd64 still cross-compile | importing the darwin file unconditionally |
| `textOracleParity.test.ts` | mobile `.ts` / `.web.ts` twins cover the same methods | adding a method to one twin only |

The last one is not optional. This repo shipped
`ExpoSecureStore.setValueWithKeyAsync is not a function` and
`beaconListener.getBootstrapDevices is not a function` on the same day, both because
a `.web.ts` twin drifted invisibly to `tsc`. `beaconParity.test.ts` is the model.

---

## 9. Every client surface — parity plan

Two families with different propagation (per CLAUDE.md "Cross-surface parity"):

### RN-shared (free propagation, but VERIFY it isn't screen-gated)

| Surface | Entry point | What the oracle does there |
|---|---|---|
| **mobile** (iOS) | `mobile/ios/Yaver/` native overlay | OCR a decoded preview frame **locally** → the phone names the box's failure without the frame leaving the device |
| **mobile** (Android) | ML Kit (see below) | same, different engine |
| **tablet** | shared RN | same as mobile |
| **car** | `mobile/app/car-voice-coding.tsx` | read state aloud; the driver cannot look. OCR → TTS is the *only* honest oracle here |
| **glass / AR-VR** | `mobile/app/glass-*.tsx` | read the HUD frame; visionOS supports Vision natively |

### Native surfaces (explicit ports, no inheritance)

| Surface | Dir | Vision available? | Plan |
|---|---|---|---|
| **tvOS** | `tvos/` | ✅ (tvOS 11+) | **highest value.** Only lane is `frames`; only oracle today is colour. Also unlocks the QR sign-in arc (§6c). |
| **visionOS** | `visionos/` | ✅ | same as tvOS |
| **watchOS** | `watch/` | ⚠️ **unverified** (§1a.2) | assume **no**. Watch reads a result computed elsewhere. Do not block on this. |
| **Wear OS** | `wear/` | ❌ Android | ML Kit is heavy for a watch; **do not** ship it there. Consume a result. |
| **web** | `web/` | ❌ browser | the DOM is the oracle. The one exception is the *visibility* check (§5b), which runs in the harness, not the browser. |

### Android — ML Kit, and the drift risk

There is currently **zero** ML Kit in the repo (verified by grep). Android's
counterpart is ML Kit on-device text recognition — free, offline, but a real
dependency (bundled ~4 MB, or Play-services-delivered, which means it can be
*absent* at runtime → that is itself a capability gap needing the same four layers).

🔴 **Two native implementations behind one JS interface is the exact shape that has
already bitten this repo twice.** Non-negotiable if this is built:
- ONE `TextOracle` JS interface, three impls (Apple Vision, ML Kit, agent-HTTP fallback).
- A `.web.ts` twin from day one — RN-web has neither.
- `textOracleParity.test.ts` (§8) landed in the **same commit**, not later.

### Recommendation on sequencing

**Agent-side macOS first.** That is where the closed loop runs, where the tvOS and
visionOS frames already land, and it costs one Swift file plus one Go interface. The
phone-side module is a real but second-order win and carries the parity risk above.
Do not do them together.

---

## 10. Failure plumbing — the four layers, filled in

| Failure | L1 Detection | L2 Signal | L3 UI | L4 Route-to-fix |
|---|---|---|---|---|
| non-darwin box | `Available()` → false | `text_oracle.unavailable` | "Text assertions unavailable on linux/arm64 — colour verdict only" | **none, and say so.** Offer: run this arc on a Mac. Never a dead button. |
| helper missing | run fails, ENOENT | `text_oracle.helper_missing` | named cause + button | `POST /install/text-oracle`, streamed with bytes + elapsed |
| helper killed by codesign | run fails, signal/exit reason | `text_oracle.helper_blocked` | "macOS refused to run the helper because it is unsigned" | re-install from the signed release; **never** "try again" |
| macOS without CLT (dev builds only) | probe | `text_oracle.helper_missing` | named | `xcode-select --install` |
| low confidence read | `MeanConf < gate` | `text_oracle.low_confidence` | show text as *context*, not as a verdict | none needed — degrade, don't fail |

Every one of these ends in a **named cause**. None ends in a spinner. That is the
entire acceptance criterion.

---

## 11. Known drift this work will touch — fix in the same change

Found while auditing. Each is a real inconsistency a handoff session will trip over:

1. 🔴 **`web/lib/surfaceViewports.ts:27` knows 5 surfaces** — `web | mobile | tablet
   | tv | watch`. `client_render_capabilities.go:54` names **8** — `web, mobile,
   tvos, visionos, watchos, wear, car, glass`. The e2e surface table cannot express
   visionOS, car, or glass at all. Reconcile before adding arcs for them, or the new
   arcs will hardcode literals — the exact thing the surfaceViewports rule forbids.
2. 🟠 **`client_render_capabilities.go` is untracked.** Confirm it landed.
3. 🟠 **`capture_error` at `remote_runtime_video_track.go:139` has no consumer** — a
   known signal-with-no-consumer. §5a option 1 fixes it as a side effect. Land the
   consumer with a test that fails when it is removed.
4. 🟠 **`ops_vision.go`'s `frameDiffScore` is a pure-Go perceptual diff that already
   runs everywhere.** It is the natural Linux stand-in for feature-print distance and
   is currently used only for camera motion. Promote it rather than writing a second
   one.

---

## 12. Phased delivery

**P1 — agent, macOS, headless (no UI, no e2e).** Helper + signing + `TextOracle` +
null engine + capability row + reason codes + the 🔴 launchd/SSH probe from §1a.1.
Exit: `screen_read` returns text from a stored fixture on a Mac, and returns a
*named* unavailability on Linux. Linux builds unchanged, proven by §8.

**P2 — MCP surface.** Four verbs + the first-class image tool. Exit: a session can
ask any box "what does this frame say?" in one call.

**P3 — closed loop.** `e2e/lib/textOracle.ts` + wire `native-headless-vibe.mjs`
first (best ROI). Exit: a tvOS arc that previously scored `SILENT` now scores
`NAMED` with the product's own sentence as evidence.

**P4 — consumers.** vibe summariser `apple-vision` source; OCR-first ghost grounding
**with the measurement from §7**; capability report field.

**P5 — on-device (separate change).** iOS module + Android ML Kit + `.web.ts` twin +
parity test, together, never partially.

**P6 — new capabilities.** QR sign-in arc for tvOS; the build-482 visibility check.

---

## 13. Anti-goals

- ❌ Do not link Vision into the Go binary (cgo → breaks Linux cross-compile).
- ❌ Do not make any arc, verb, or UI path *require* the oracle.
- ❌ Do not skip a test when the oracle is missing — annotate and degrade.
- ❌ Do not add a Linux OCR engine in this change (§4).
- ❌ Do not assert exact OCR strings.
- ❌ Do not name any file `vision.go` (§2).
- ❌ Do not build the mobile module before the agent side works.
- ❌ Do not compile the helper without signing it in the same command (§3 L0).
- ❌ Do not quote a cost saving for OCR-first ghost grounding without measuring it.

---

## 14. Open questions for the implementing session

1. 🔴 **Vision under `launchd` with no GUI login** — blocking for autorun. Probe on
   the Mac mini before writing L1.
2. Does the signed+notarised release pipeline (`release-cli.yml`) have room for a
   second darwin binary, or does the helper need to be a subcommand of the agent
   itself invoked via `exec` re-entry? The latter avoids a second signing artifact
   entirely and may be strictly better — **evaluate this first, it could delete all
   of §3 L0's complexity.**
3. Confidence gate value — pick it from a measured sample of real Yaver frames, not
   from medici's book-page threshold. Different corpus.
4. Should `screen_assert` live in the agent or the harness? Agent-side makes it
   available to every surface and to the MCP host; harness-side keeps test policy out
   of the product. Leaning agent-side for the verb, harness-side for the arc policy.

---

## 15. Appendix — the exact probe that produced §1

Reproduce with `xcrun swiftc -O vprobe.swift -o vprobe` (6.7 s, 67 KB, no deps).
This is a **probe, not the helper** — the shipped helper needs the signing story in
§3 L0, JSON-on-stdin batching, and a `--version` that reports the Vision engine
revision for provenance. Kept verbatim so the next session can re-measure in one
minute instead of re-deriving it.

```swift
// vprobe.swift — headless probe of Apple Vision: OCR + feature-print distance.
// Usage: vprobe ocr <img>  |  vprobe distance <a> <b>
import Foundation
import Vision
import CoreImage

func die(_ m: String) -> Never { FileHandle.standardError.write((m+"\n").data(using:.utf8)!); exit(2) }

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: vprobe ocr <img> | vprobe distance <a> <b>") }

func cg(_ path: String) -> CGImage {
    guard let d = NSData(contentsOfFile: path) as Data?,
          let src = CGImageSourceCreateWithData(d as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("cannot read image: \(path)") }
    return img
}

switch args[1] {
case "ocr":
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let t0 = Date()
    try VNImageRequestHandler(cgImage: cg(args[2]), options: [:]).perform([req])
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    var out: [[String: Any]] = []
    for o in (req.results ?? []) {
        guard let c = o.topCandidates(1).first else { continue }
        let b = o.boundingBox // normalized, origin BOTTOM-LEFT
        out.append(["s": c.string, "conf": c.confidence,
                    "x": b.origin.x, "y": 1 - b.origin.y - b.size.height,  // flipped to top-left
                    "w": b.size.width, "h": b.size.height])
    }
    FileHandle.standardOutput.write(
        try JSONSerialization.data(withJSONObject: ["ms": ms, "count": out.count, "text": out]))

case "distance":
    guard args.count >= 4 else { die("distance needs two images") }
    func fp(_ p: String) throws -> VNFeaturePrintObservation {
        let r = VNGenerateImageFeaturePrintRequest()
        try VNImageRequestHandler(cgImage: cg(p), options: [:]).perform([r])
        guard let o = r.results?.first else { die("no feature print for \(p)") }
        return o
    }
    let t0 = Date()
    let a = try fp(args[2]), b = try fp(args[3])
    var d = Float(0)
    try a.computeDistance(&d, to: b)
    FileHandle.standardOutput.write(try JSONSerialization.data(
        withJSONObject: ["ms": Int(Date().timeIntervalSince(t0) * 1000), "distance": d]))

default: die("unknown op \(args[1])")
}
```

Verify against real fixtures already in the repo:

```bash
./vprobe ocr scripts/screenshots/output-tvos/01_yaver_tv_signin.png
./vprobe distance scripts/screenshots/output-ipad/04_devices.png \
                  scripts/screenshots/output-ipad/02_tasks.png
```

**The launchd question from §1a.1, as a runnable check** — this is the first thing
to do, before any Go is written:

```bash
# on the Mac mini, from an SSH session with no GUI login:
launchctl asuser $(id -u) ./vprobe ocr /path/to/fixture.png > /tmp/vprobe.out 2>&1; echo "exit=$?"
cat /tmp/vprobe.out
```

A non-zero exit or empty output there means the whole macOS story is autorun-dead and
§12 P1 stops until it is understood — do **not** proceed on the assumption that an
interactive-shell success generalises.

---

## 16. Sources

Measured locally 2026-08-03 (§1); prior art in `../medici.ai` (`slide_ocr.py`,
`ocr_policy.py`, `REMAINED.md`). External:
[Vision framework](https://developer.apple.com/documentation/vision) ·
[VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest) ·
[Read documents using the Vision framework — WWDC25](https://developer.apple.com/videos/play/wwdc2025/272/) ·
[Feature prints & image similarity](https://medium.com/@MWM.io/apples-vision-framework-exploring-advanced-image-similarity-techniques-f7bb7d008763) ·
[mac-ocr — Vision OCR CLI](https://github.com/privatenumber/mac-ocr) ·
[Vision via PyObjC](https://yasoob.me/posts/how-to-use-vision-framework-via-pyobjc/)
