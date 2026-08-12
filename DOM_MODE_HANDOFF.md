# DOM MODE — Element Inspect & Deep Audit — HANDOFF

Date: 2026-08-12 · Branch: `main` (no commits made — all work is uncommitted in the
working tree, alongside the pre-existing uncommitted `acp_client.go` / `acp_runner.go`
work that was there before this task; leave those untouched).

## Status summary (verified 2026-08-12)

| Slice | Status | Evidence |
|---|---|---|
| Go agent: element + items store, probe, inject, HTTP, per-turn hook | ✅ DONE | `go build .`, `go vet .`, `go test -run 'Dom…' .` pass |
| Go: `/dom-inspect/items` POST/GET + route | ✅ DONE (this session) | handlers in `dom_inspect_http.go`, route in `httpserver.go:1020`, tests pass |
| Web dashboard: lib + chip + agent-client + both mounts | ✅ DONE (this session) | `web/lib/domInspect.ts`, `domInspect.test.ts` 14/14, `tsc --noEmit` clean |
| Mobile app: lib + bridge + quic + chip + both preview lanes | ✅ DONE (this session) | `mobile/src/lib/domInspect.test.mts` 19/19, twins byte-identical |
| Desktop `desktop/app/`: webview preload + Browse\|Inspect | ✅ DONE (this session) | `webview-preload.js` + `index.html` control, syntax-checked |
| e2e assertion (vibe preview → chip → POST) | ❌ OPEN | nothing in `e2e/` yet — see §6 |

## The feature

Yaver DOM mode (Orca "Design Mode" style): in the web dashboard, desktop Electron app,
and mobile app, the user toggles an explicit **Browse | Inspect** mode (radio-style,
opt-in — never default, because while Inspect is on, clicks in the preview are captured
and the real app cannot be used). In Inspect mode, hovering highlights elements in the
live preview; clicking one captures its **outerHTML + computed CSS + rect + a cropped
canvas screenshot** and attaches it to the next prompt, so a "deep audit analysis" of
that element reaches the AI runner with the element attached — and because the Go agent
has the repo, the prompt block tells the runner to start from the source file that
renders the element. The agent also exposes an **interactive-items inventory** so any
client surface can fetch a pickable list of DOM items.

The design is a byte-for-byte mirror of the existing **screen-context** pipeline
("the agent knows which screen you're looking at") — see `screen_context.go`,
`screen_context_probe.js`, `screen_context_inject.go`, `screen_context_http.go`,
`screen_context_turn.go` and `web/lib/screenContext.ts` / `mobile/src/lib/screenContextBridge.ts`.
Same trust model, same prompt-injection protection, same privacy rules
(never `input.value`, never Convex — `convex_privacy_test.go` already forbids the
family).

### Pipeline (all three surfaces)

```
probe injected into preview page (both HTML lanes)
   │  (off until surface posts {source:"yaver-dom", t:"yaver-dom-mode", enabled:true})
   ▼
user hovers (highlight) → clicks → probe captures html/css/rect/shot
   │  posts to: window.parent (web iframe) · ReactNativeWebView (mobile WebView)
   │            · window itself (Electron <webview> preload relay)
   ▼
surface validates (domInspect.ts parser) → forwards over ITS OWN authed channel
   │  web: agentClient.reportDomInspect  (POST /dom-inspect)
   │  mobile: quicClient.reportDomInspect (same route)
   │  desktop: window.yaver.agentRequest('POST','/dom-inspect')
   ▼
agent: NormalizeDomElement → store keyed by workDir, TTL 10 min
   ▼
registerPerTurnContext hook → FormatDomElementBlock appended to EVERY turn
   (sentinel-delimited; names selector/tag/text/rect/html/css/screenshot;
    instructs runner to find the source file that renders it)
```

## COMPLETED — Go agent slice (builds, `go vet` clean, tests pass)

New files in `desktop/agent/`:

| File | Contents |
|---|---|
| `dom_inspect.go` | `DomElement` type, caps (`maxDomHTMLBytes` 24000, `maxDomCSSBytes` 16000, `maxDomShotBytes` 16000, `maxDomBlockBytes` 64000), `NormalizeDomElement`, `domInspectStore` (workDir key via reused `screenContextKey`, TTL `domInspectTTL` = 10 min, evict-oldest at `maxTrackedElements` 16), `FormatDomElementBlock` (sentinel `promptEchoSentinel`), `Summary`. PLUS `DomItem`/`DomItems` inventory types + `NormalizeDomItems` (dedupe by selector+tag, cap 40) + `domItemsStore` (TTL `domItemsTTL` = 60 s) + `globalDomItems`. |
| `dom_inspect_probe.js` | ES5, never-throw, no-network, never `.value`. Listens for `yaver-dom-mode` (enable/disable) and `yaver-dom-items` (inventory). Hover overlay `data-yaver-dom-overlay`, click capture, `captureShot()` (SVG foreignObject clone → JPEG dataURL, 240px max, best-effort, 600 ms safety timeout), auto-off after select + Escape. `sendUp()` posts to RNWebView / `window.parent` / **self** (self-post is what the Electron webview preload listens to, since webview guests run top-level). |
| `dom_inspect_inject.go` | `//go:embed dom_inspect_probe.js` + `domInspectProbeTag()` + `injectDomInspectProbe()` (idempotent, non-HTML passthrough), marker `data-yaver-dom-probe="1"`. |
| `dom_inspect_http.go` | `handleDomInspect`: POST (report, 128 KB bound, workDir required), GET (read-back with `block`), DELETE (clear on mode-off). **PLUS (this session) `handleDomInspectItems`**: POST (256 KB bound, workDir required, returns `{ok,stored,count,capturedAt}`), GET (`{ok,present,items,capturedAt}` or `{present:false, reason}`). |
| `dom_inspect_turn.go` | `registerPerTurnContext` hook — attaches block on EVERY turn while fresh. |
| `dom_inspect_test.go` | **10 tests**: caps, lane allowlist, empty/fresh/TTL, block sentinels+facts, screenshot carry, store put/get/clear, empty-workDir reject, eviction, summary, **+ (this session) `NormalizeDomItems` dedupe/cap + `domItemsStore` put/get/TTL/clear**. |
| `dom_inspect_inject_test.go` | 7 tests: injection placement/idempotence/non-HTML, **both-lanes guard** (`build_web.go` + `devserver_basehref.go` must call `injectDomInspectProbe(`), probe contracts (no `.value`, no `fetch(`/`XMLHttpRequest`, both host surfaces, speaks both protocol strings, off-until-enabled), tag well-formed, coexistence with screen probe. |

Modified files:

- `devserver_basehref.go` — `rewritten = injectDomInspectProbe(rewritten)` after the screen probe (line ~239).
- `build_web.go` — `patched = []byte(injectDomInspectProbe(string(patched)))` after screen probe (line ~809).
- `httpserver.go` — `mux.HandleFunc("/dom-inspect", s.auth(s.handleDomInspect))` (line ~1018) **+ (this session) `mux.HandleFunc("/dom-inspect/items", s.auth(s.handleDomInspectItems))` (line ~1020)**.

Verified: `go build .` OK, `go vet .` OK, `go test -run 'DomInspect|DomProbe|DomElement|FormatDomElement|DomItems' .` OK.

## COMPLETED — Web dashboard (`web/`) (this session)

- **`web/lib/domInspect.ts`** — twin of `web/lib/screenContext.ts`: `DomElement`/`DomItem`/`DomItems` interfaces mirroring the Go wire shape, constants matching Go caps (`MAX_DOM_SELECTOR` 200 … `MAX_DOM_ITEMS` 40), `parseDomInspectMessage` (validating, returns null for anything not `{source:"yaver-dom", t:"yaver-dom-element"}`), `parseDomItemsMessage`, `domInspectModeCommand(enabled)`, `domItemsCommand(max?)` (clamped to [1,40]; uses `??` not `||` so an explicit 0 survives), `domInspectSummary`/`domInspectDetail`, `isEmptyDomElement`, `isDomInspectEnabled`/`setDomInspectEnabled` (localStorage, **default OFF** — opt-in). Pure section above `── PLATFORM STORAGE ──` is byte-identical to the mobile twin (parity test pins it).
- **`web/lib/domInspect.test.ts`** — **14/14 pass** (`npx tsx lib/domInspect.test.ts`): parser validity, foreign-message rejection, hostile-input clamping, oversized shot DROPPED, lane allowlist, unknown-field drop, summary/detail, command builders (incl. zero/negative clamp), items dedupe/cap, probe wire-literal contract, **web/mobile parity scan**, chip consumer guard.
- **`web/lib/agent-client.ts`** — `DomElementReport` + `DomItemsReport` interfaces; `reportDomInspect` (POST, swallow failures), `clearDomInspect` (DELETE), `reportDomItems` (POST /items), `domItems(workDir)` (GET, returns items or null). Placed next to `reportScreenContext`/`clearScreenContext` (~line 2191).
- **`web/components/dashboard/DomInspectChip.tsx`** — radio **Browse | Inspect** segmented control; on Inspect → `iframeRef.contentWindow.postMessage(domInspectModeCommand(true), "*")`; on Browse → post false AND `clearDomInspect(workDir)` (off deletes). Listens `window "message"`: `parseDomInspectMessage` → set el + `reportDomInspect({...el, workDir})`; `parseDomItemsMessage` → store + `reportDomItems`. Attached element renders chip: summary, expandable detail (selector/rect/text + html/css sizes + screenshot thumbnail), off toggle. **Items ▾** picker posts `domItemsCommand`, renders agent-held inventory (`domItems(workDir)`) or the just-received list; clicking an item reports the item's fields as the selected element (items are lightweight — no shot/html/css — the hover capture is the rich path). States exactly what is sent.
- **Mounted in BOTH web preview surfaces**:
  - `WebPreviewFrame.tsx` — internal `iframeRef` on the `<iframe>` (line ~352), optional `agentClient`/`workDir` props, chip rendered in the URL bar.
  - `WebReloadView.tsx` — passes `agentClient={agentClient}` + `workDir={selectedProject?.path || activeProject?.path || devStatus?.workDir}` to `WebPreviewFrame` (line ~1633).
  - `RuntimeLabView.tsx` — shared `domInspectFrameRef` set via callback ref on BOTH exclusive preview iframes (phone mockup ~line 3753 and plain web pane ~3778; only one renders at a time), chip mounted beside `ScreenContextChip` (~line 4378).

Verified: `npx tsc --noEmit` clean, `npx tsx lib/domInspect.test.ts` 14/14, `npx tsx lib/screenContext.test.ts` 13/13 (no regression).

## COMPLETED — Mobile app (`mobile/`) (this session)

- **`mobile/src/lib/domInspect.ts`** — twin of `web/lib/domInspect.ts`. Pure part byte-identical to web (parity test verifies); storage section below the marker is in-memory + AsyncStorage-hydrated by the bridge (same split as `screenContext.ts`). Default OFF.
- **`mobile/src/lib/domInspect.test.mts`** — **19/19 pass** (`node --experimental-strip-types --test src/lib/domInspect.test.mts`): parser/clamps/shot-drop/lane/items (webview lane), pref default OFF, **byte-identity parity test + exported-API parity test**, probe wire-literal + RN-branch guard, **both preview lanes consume `handlePreviewDomMessage`** (apps.tsx + DevPreview.tsx), bridge forwards via `quicClient` (never bare fetch), quic has all four methods with `this.authHeaders`, chip names/deletes/radio.
- **`mobile/src/lib/domInspectBridge.ts`** — twin of `screenContextBridge.ts`: `ObservedDomElement`/`ObservedDomItems`, `handlePreviewDomMessage(raw, workDir)` (parses element OR items, forwards via `quicClient.reportDomInspect`/`reportDomItems`, auto-offs mode after a selection, returns true when OURS), `subscribeDomInspect`/`subscribeDomItems`/`subscribeDomInspectMode` buses (preview tab and Tasks tab are different tabs; the bus lives above both), `getObservedDomElement`/`getObservedDomItems`, `setDomModeEnabled(on, workDir?)` (persists to AsyncStorage, off → `quicClient.clearDomInspect`), `domInspectPrefReady`.
- **`mobile/src/lib/quic.ts`** — `DomElementReport` + `DomItemsReport` interfaces and `reportDomInspect`/`clearDomInspect`/`reportDomItems`/`domItems` next to `reportScreenContext` (line ~4093). Authed client only, never a bare fetch.
- **`mobile/src/components/DomInspectChip.tsx`** — radio **Browse | Inspect** + attached-element chip (compact, watch surface): summary, expandable detail (selector/rect/text + html/css sizes), screenshot note, off toggle. Renders nothing for the element when unattachable (no workDir) — states it instead.
- **Wire BOTH preview implementations** (two-lane rule — parity test scans both):
  - `DevPreview.tsx` — `handlePreviewDomMessage(m, status?.workDir)` right after `handlePreviewScreenMessage(...)` (line ~1180); mode-injection effect: on Inspect-flip, `webViewRef.current?.injectJavaScript('window.postMessage({source:"yaver-dom",t:"yaver-dom-mode",enabled:true},"*");true;')` (injecting into the page delivers to the same window's listeners — the mobile equivalent of the parent→iframe post; the probe is present because the WebView loads the agent-proxied bundle). Probe auto-off after selection = one selection per toggle.
  - `app/(tabs)/apps.tsx` — same `handlePreviewDomMessage(m, devStatus?.workDir)` call (line ~3629) + same mode-injection effect on its `webViewRef` (line ~756).
- **Mounted in `app/(tabs)/tasks.tsx`** — `<DomInspectChip workDir={projectDir} />` beside BOTH `ScreenContextChip` mounts (first composer ~line 6472, follow-up composer ~line 7708).

Verified: `node --experimental-strip-types --test src/lib/domInspect.test.mts` 19/19, `screenContext.test.mts` 22/22 (no regression), `npx tsc --noEmit` — the only errors are pre-existing (`TaskProofCard.tsx`, `connectionFanout.test.ts`, `DeviceContext.tsx`, a `Modal` prop in tasks.tsx at line 7056 — all unrelated to DOM mode).

## COMPLETED — Desktop Electron app (`desktop/app/`) (this session)

- **`desktop/app/src/renderer/webview-preload.js`** (NEW) — the bridge:
  ```js
  const { ipcRenderer } = require("electron");
  ipcRenderer.on("yaver-dom-mode", (_e, enabled) =>
    window.postMessage({ source: "yaver-dom", t: "yaver-dom-mode", enabled: !!enabled }, "*"));
  window.addEventListener("message", (e) => {
    if (e.data && e.data.source === "yaver-dom" &&
        (e.data.t === "yaver-dom-element" || e.data.t === "yaver-dom-items-list"))
      ipcRenderer.sendToHost("yaver-dom", e.data);
  });
  ```
  (The guest page is top-level so `window.parent === window`; the probe's self-post
  is what lands here.)
- **`desktop/app/src/renderer/index.html`**:
  - `<webview id="preview-webview" preload="./webview-preload.js" ...>` (line ~242)
  - Preview bar (line ~232): **Browse | Inspect** segmented radio next to Reload/Stop (hidden until a preview shows; `showDomToggle(true)` from `showPreview`).
  - Renderer JS: `toggleDomMode(on)` → `wv.send("yaver-dom-mode", on)`; off → `window.yaver.agentRequest("DELETE", "/dom-inspect?workDir=" + encodeURIComponent(s.workDir))` (workDir from `window.yaver.devServerStatus()` → `s.workDir`, confirmed present in `/dev/status`). `wireDomMode()` (idempotent) listens `wv.addEventListener("ipc-message", e => { if (e.channel === "yaver-dom") ... })` → `window.yaver.agentRequest("POST", "/dom-inspect", { ...el.data.el, workDir })`; auto-off mirrors the probe's after-select. Chip reuses `.badge`/`.item`-style markup: `element: selector — text` + OFF toggle + expandable `<details>` block; `requestDomItems()` sends `yaver-dom-items` for the lightweight inventory picker.
  - `main.js` needs NO change (preload is attribute-based; `webviewTag: true` already set).

Note: there is a NEW separate `electron/` GUI shell at repo root (untracked, from the
webui-chat-vibing-gui audit 2026-08-12) — it wraps the WEB DASHBOARD in a BrowserWindow,
so it inherits DOM mode automatically from the web implementation; it is NOT the
`desktop/app/` webview host this section targets. Do not conflate the two.

## REMAINING

### 1. e2e closed-loop assertion (the repo's Snowball rule)
No e2e guard yet. The closed-loop discipline would add an assertion to `e2e/` (e.g.
select an element in the vibe preview iframe and assert the chip + a `POST /dom-inspect`),
and prove the guard by breaking it (delete the probe injection → test fails). This is
the only section of the original handoff still open.

### 2. Optional: one-tap "Audit" CTA
No dedicated "Audit" button exists, and none is needed: the per-turn hook attaches the
element to any next prompt ("deep audit this element" just works, and the block tells
the runner to locate the source). If a one-tap audit is wanted later, it is a
`createTask` call with the block already in the store (`GET /dom-inspect?workDir=`
returns it as `block`).

## Key design decisions to preserve
1. **Off until explicitly enabled** — the probe gates on the `yaver-dom-mode` command; a DOM mode that inspects by default would be silently capturing a page the user never pointed at.
2. **Radio Browse|Inspect, not a button** — while Inspect is on, clicks are intercepted; the exclusivity must be visible.
3. **Auto-off after selection + Esc** — returns the user to real app usage immediately (mirrored in every surface's local state).
4. **Surface forwards, page never talks to the agent** — `/dev/` is unauthenticated; a direct write would be a prompt-injection channel. Every surface uses its own authed client.
5. **Never `input.value`, never Convex** — the clicked element may be a form field; user-entered text and work-derived content stay off the wire/DB.
6. **Two-lane parity everywhere** — probe injected in both HTML lanes; mobile message handled in both preview implementations; web/mobile lib twins pinned by parity tests. Deleting any one call-site must fail a test.
7. **TTL 10 min (element) / 60 s (items)** — deliberate selection stays believable longer than ambient screen context, but a stale element is worse than none.
8. **Oversized screenshot is DROPPED, never truncated** — a cut dataURL is a broken image (both Go and the JS twins enforce this).

## Final verification checklist (all pass unless marked)
- `cd desktop/agent && go build . && go vet . && go test -run 'Dom' .` ✅
- `cd web && npx tsc --noEmit` ✅ · `npx tsx lib/domInspect.test.ts` ✅ (14/14) · `npx tsx lib/screenContext.test.ts` ✅ (13/13)
- `cd mobile && node --experimental-strip-types --test src/lib/domInspect.test.mts` ✅ (19/19) · `src/lib/screenContext.test.mts` ✅ (22/22) · `npx tsc --noEmit` (only pre-existing errors outside DOM-mode files)
- `cd desktop/app && node --check src/renderer/webview-preload.js` ✅ · inline renderer script `node --check` ✅
- Manual (not yet run): `cd desktop/app && npm start` — connect → start dev server → Browse|Inspect toggle → hover → click → chip appears → prompt "audit this element" → block in task.
- e2e (open): add + prove the vibe-preview assertion (see REMAINING §1).
