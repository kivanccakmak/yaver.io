# Can every surface actually vibe sfmg? — measured 2026-08-04

**The question:** render sfmg, change its background green → black, watch it
change, revert. On web, mobile, AR/VR, car, watch, TV, the WebRTC browser lane,
and the Android platforms. Is it fully done?

**The answer: no. Four of nine surfaces close the loop.** The rest each fail at a
*different* leg, which is why "it works on my screen" has kept being true and
misleading at the same time.

Method: keyed off code, not docs — greps over `web/`, `mobile/`, `tvos/`,
`visionos/`, `watch/`, `wear/` for the three legs separately, then read the call
sites that matched. A surface only counts as FULL if it can do all three.

## The matrix

| Surface | 1. render sfmg | 2. send the change | 3. see it change | verdict |
|---|---|---|---|---|
| **Web dashboard** | ✅ iframe over the signed `web-js-bundle` | ✅ chat → `POST /tasks` | ✅ auto-refresh at terminal status | **FULL** |
| **Mobile phone / tablet** | ✅ `WebViewCompat` (iframe on web, WebView native) + Hermes | ✅ `apps.tsx` + `tasks.tsx` | ✅ auto-refresh | **FULL** |
| **tvOS** | ✅ frame stream, polled every 300 ms | ✅ `VibeTurnPanel` | ✅ continuous capture — no refresh needed | **FULL** |
| **visionOS** | ✅ shares every tvOS file | ✅ same | ✅ same | **FULL** |
| **CarPlay** | ❌ none | ✅ voice → `dispatchAndSummarize` → task | ❌ spoken summary only | vibe-only |
| **watchOS** | ❌ none | ✅ `Dictation` + `desktop_voice` verb (`WatchProtocol` carries `taskId`/`status`) | ❌ | vibe-only |
| **Glass / AR** (`glass-workspace.tsx`) | ✅ webview + WebRTC | ⚠️ `runYaverAgent` — an agent-TOOL loop, not the project coding turn | ⚠️ | different loop |
| **Web VR** (`spatial/vr/RemoteWindow3D`) | ✅ real WebRTC video | ❌ view-only | ❌ | view-only |
| **Wear OS** | ❌ | ❌ | ❌ | neither |

**Android platforms** (`android-tv`, `android-auto`, `android-xr`,
`android-wear`) are **render targets**, not control surfaces: they are driven
through the remote-runtime WebRTC lane from mobile/web, and appear in
`publish.tsx` as build/publish destinations. Nothing runs *on* them that can
start a vibe turn.

## What each non-FULL surface is actually missing

* **CarPlay — missing by design, but the consequence is unstated.** Zero render
  references; Apple's voice template forbids a picker or preview while driving.
  So a spoken "make the background black" dispatches, and the driver hears a
  summary. **Reverting is therefore a blind action** — the user is asked to trust
  a change they cannot see. That is defensible in a car and should be *said*, not
  left implicit.
* **watchOS — the send leg exists and nothing renders.** `Dictation.swift` +
  `DesktopVoiceClient` (`verb: desktop_voice`) can start a turn, and
  `WatchProtocol` already carries `taskId`, `status`, `prompt`. There is no frame
  path at all, so the watch is a remote control with no screen for the thing it
  controls.
* **Glass / AR — renders, but its prompt goes somewhere else.** `submit()` calls
  `runYaverAgent`, the tool-calling agent, not the project coding turn. So
  "change sfmg's background" on glass does not travel the path the other surfaces
  use, and would not be observed by the same refresh logic even though the
  surface *can* draw.
* **Web VR — the best render of the lot, and no input.** `RemoteWindow3D` opens a
  genuine `RTCPeerConnection` against
  `/remote-runtime/sessions/<id>/webrtc/offer` and shows live video. There is no
  way to send a turn from inside it.
* **Wear OS** — neither leg found.

## The WebRTC browser lane is healthy

`mobile/app/remote-runtime.tsx` still calls
`addTransceiver("video", { direction: "recvonly" })`, so the 2026-07-17 fix held
— without it the agent's `offerWantsVideo(sdp)` falls back to JPEG-over-
DataChannel at ~1.1 fps while the UI still says "native WebRTC lane".

Surfaces on that lane: web (`RemoteRuntimeViewer`, `RemoteSessionView`,
`RemoteWindow3D`, `AppleTVCellView`) and mobile (`remote-runtime.tsx`).
**Not** tvOS or visionOS — those use the frame-stream instead, which is a
different mechanism with different failure modes, and is why they see changes
without needing any refresh trigger.

## Measured, live, on the box (agent 1.99.406-dev)

* sfmg's background is `background: '#0A1F14'` (`src/theme/colors.ts`).
* `POST /dev/start` with `surface=web-reload` **refuses** sfmg —
  *"Project is mobile-only (Metro/RN); use Hot Reload + Yaver app"*, `kind:
  "mobile"`. The web UI does not use that route: it calls
  `POST /dev/build-native` with `target=web-js-bundle`. The refusal is correctly
  named, but it points at a remedy that is not the one the web surface takes.
* That build produced 42 files / 10.9 MB and a signed bundle URL.
* A preview capture of it sampled **`#0a1f14` at 53.3 %** of pixels — the theme
  green, confirmed at the pixel level rather than by reading the source.

### One discrepancy found while measuring

The capture was requested at **390×844** and came back **500×701**. Both are
inside the accepted override range (200–3840 / 200–2160), so the request was not
clamped away — the captured frame simply is not the requested viewport. This is
the same family as the previously-recorded "preview reported the requested
viewport and captured at 1280×900 anyway". A verdict about a phone layout taken
from a 500×701 capture is a statement about a layout no phone user ever sees.
**Not yet root-caused; do not treat any per-surface layout verdict as sound
until it is.**

## What would make it "fully done"

In dependency order, cheapest first:

1. **Say what CarPlay and watchOS cannot show.** Both can dispatch and neither
   can render; today nothing tells the user that the confirmation they are
   getting is a sentence, not a picture.
2. **Point glass at the project coding turn**, or state that its prompt box is a
   different agent. Right now the two are indistinguishable on screen.
3. **Root-cause the viewport discrepancy** before trusting any layout verdict.
4. **Give Web VR an input path**, or label it view-only.
5. **Wear OS** — decide whether it is a control surface at all.
