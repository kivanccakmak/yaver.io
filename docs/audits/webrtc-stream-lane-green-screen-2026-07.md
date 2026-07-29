# WebRTC stream lane — "green screen" content bug (2026-07-29)

**Status: transport PROVEN, content DELIVERY broken. Root cause needs runtime
instrumentation of the live feeder (a shared-primary restart) — not yet landed.**

The browser-lane WebRTC closed-loop test `e2e/webrtc-e2e/` was built to prove the
real H.264 video-track path every non-device surface (tvOS/watch/car/AR-VR) rides.
It surfaced a real bug and precisely characterized it.

## Repro (deterministic, Linux-native)

```
YAVER_WEBRTC_BASE=http://<box>:18080 node e2e/webrtc-e2e/run.mjs webui
```

The harness pushes a solid-color MJPEG frame to a fresh pushed source
(`POST /stream/push?name=<src>`), offers a recvonly video peer
(`POST /stream/webrtc/offer {source,sdp}`), receives the answer, and samples the
`<video>` center pixel. Colors are **magenta + blue on purpose** — never green —
so the decoder's no-signal frame cannot masquerade as a content match.

## What works (proven over Tailscale, ubuntu-4gb arm64)

- Signaling `POST /stream/webrtc/offer` → `{ok,type:"answer",sdp}` (always RTP;
  this decoupled ffmpeg lane has no JPEG fallback).
- ICE connects (`iceConnectionState=connected`), STUN-only, over the tailnet.
- RTP flows continuously: `packetsReceived` climbs into the thousands,
  `packetsLost≈0`, `currentTime` advances, `framesDecoded`/`keyFramesDecoded` climb.
- The box's **exact ffmpeg pipeline encodes a pushed JPEG to real content** when
  driven standalone: `for i in $(seq 30); do cat red.jpg; done | ffmpeg -f mjpeg
  -framerate 12 -i pipe:0 -c:v libx264 -preset ultrafast -tune zerolatency
  -pix_fmt yuv420p -g 24 -bf 0 -f h264 out.h264` → decodes back to `ce321e` (red).

## The bug

The live agent path delivers **all-zero-YUV frames** — the browser decodes them to
`rgb(0,135,0)` (Y=U=V=0), the classic "no-signal green", regardless of the pushed
color. `getStats` on the receiver: `framesDecoded>0`, `keyFramesDecoded≈framesReceived`
(nearly every frame is an IDR), tiny `bytesReceived` (~850 B/s), ~0.7 fps. So ffmpeg
is emitting sparse empty keyframes — it is NOT being fed the pushed JPEG in the live
path, even though the same ffmpeg + same JPEG produce real content standalone.

## Ruled out (with evidence)

- **ffmpeg / x264 args / the JPEG** — standalone pipeline on the box produces red.
- **SPS/PPS / keyframe recovery** — `-x264-params repeat-headers=1` is a NO-OP here
  (SPS already emitted at every keyframe: SPS=3 for 3 keyframes, with and without).
  Do not "fix" this with repeat-headers; it changes nothing.
- **Network loss** — `packetsLost≈0`; frames arrive and decode.
- **Source-name mapping** — traced `getOrCreateEncode(source)` →
  `newVideoTrackPump("stream-"+source, source+":"+tier)` →
  `SpawnCapture(deviceID=key)` → feeder reads `sourceFrameJPEG(source)`; the bare
  source matches `POST /stream/push?name=<source>` exactly.
- **base64 decode** — `jpegFromB64 = base64.StdEncoding.DecodeString`; the push
  stores raw base64 (no `data:` prefix), which decodes correctly.

## Where to look next (needs live instrumentation)

The code path (`desktop/agent/stream_webrtc.go` `SpawnCapture` feeder →
`sourceFrameJPEG` → `getPushedFrame`, and `stream_webrtc_fanout.go`
`getOrCreateEncode`) reads correct on paper, so the divergence is a RUNTIME fact:
instrument the feeder (log `source`, `len(sourceFrameJPEG(source))`, resolved
`fps`/profile per tick) on a **scratch instance** — port 18080 is effectively
hardcoded, so this means either a brief restart of the shared primary agent or a
throwaway box, hence it is gated on an explicit go-ahead. Likely suspects to
confirm first: the resolved encode **profile fps** (a near-zero/huge fps starves
the feeder) and whether the feeder's `source` actually equals the pushed name at
runtime (a fan-out key edge case). The test flips to `VERDICT=PIXELS` the moment
real content decodes.
