# STT/TTS + Device-Synergy Deep Audit — 2026-07-25

**Scope:** the voice stack — `mobile/src/lib/voice/` (2094 LOC),
`mobile/src/lib/speech.ts` (603 LOC), the surface entry points (car, glass,
vibe, assistant, watch), and how transcribed speech reaches a runner on another
device.
**Method:** source read + grep on this machine. Not exercised on a device;
findings marked where confirmation needs hardware.

---

## 0. Verdict

The **architecture is genuinely strong** — one surface-agnostic core, a
correct "no second voice bill" device-synergy model, bounded on-device paths.
The **cloud STT path is the weak seam**, and it fails the exact rule the rest of
this session was spent enforcing: **every one of its network calls is
unbounded.** On a flaky mobile network — the *normal* condition for this
product — a transcription can hang with no timeout and no user-visible reason.
Same false-green class: the request is "in flight" so nothing looks broken,
while it will never return.

---

## 1. The stack, mapped

| Layer | File | Role |
|---|---|---|
| Conversation core | `voice/conversationCore.ts` | surface-agnostic: STT → endpoint → judge → dispatch → TTS → barge-in |
| Endpointer | `voice/endpointer.ts` | "when has the user stopped talking" (timing) |
| Completeness judge | `voice/completenessJudge.ts` | on-device llama.rn "is this a complete instruction" |
| STT capture | `voice/adapters/whisperCapture.ts` → `speech.ts::startRealtimeTranscribe` | whisper.rn realtime mic |
| TTS | `voice/adapters/deviceTts.ts` → `speech.ts::speakText` | expo-speech (device) / cloud |
| Runner channel | `voice/adapters/runnerChannel.ts` → `carSessionTurn` | commits the instruction to the user's OWN remote runner |
| Engine hub | `speech.ts` | whisper.rn (device) + OpenAI / Deepgram / AssemblyAI (cloud) |

**Cross-surface sharing is real** (the good kind): `car-voice-coding.tsx`,
`glass-terminal.tsx`, and `vibe.tsx` all consume the same core via
`useHandsFreeVoice` / `createVoiceCore`. A fix in the core reaches all three —
the opposite of the two-preview drift that plagued the browser lane. This is the
part to protect, not rework.

---

## 2. Findings — STT/TTS

### F1 — Cloud STT network calls are ALL unbounded *(P0, the headline)*

`grep -c 'AbortController|AbortSignal|signal:' mobile/src/lib/speech.ts` → **0**.

Every cloud transcription `fetch` runs with no timeout and no abort:

- OpenAI `POST /audio/transcriptions` (`speech.ts:227`)
- the audio-blob fetch that precedes it (`:249`, `:282`)
- Deepgram (`:252`)
- AssemblyAI upload (`:285`) + create (`:298`)

On a stalled cellular connection any of these hangs indefinitely. The
conversation core is `await`-ing the transcription, so a hung STT call hangs the
whole turn: the mic result never resolves, the endpointer's work is wasted, and
the user is left holding a phone that is "listening" but will never answer. No
timeout means no error, which means no fallback and no message — the customer
cannot tell "slow network" from "broken app". This is the same unbounded-op
class as the four agent-startup hangs fixed this session, on the client side.

**Fix:** an `AbortController` with a sane deadline (say 15s for a short
utterance; longer only for AssemblyAI's async job) on every cloud fetch, and on
timeout either retry once or fall back to the device engine, saying so.

### F2 — On-device init THROWS; the fallback to cloud is unproven *(P1)*

`ensureModelReady` (`speech.ts:~112`) does
`throw new Error("Failed to initialize on-device speech recognition: …")` when
whisper.rn is absent or the model won't load. `whisperCapture.ts` wraps calls in
bare `catch {}` (`:48`, `:77`) which *swallows* — but I could not find the path
that, on a device-STT failure, routes the SAME utterance to a cloud provider
instead. If that path does not exist, a user whose whisper init fails (older
device, missing native module after an OTA, corrupt model asset) loses voice
entirely rather than degrading to cloud.

**Needs confirmation on device.** If the fallback is missing it is a real gap;
if it exists it should be tested and named in a comment, because a swallowed
`catch {}` is indistinguishable from a silent failure.

### F3 — AssemblyAI poll IS correctly bounded *(no action — recorded so it isn't "fixed" into a regression)*

`speech.ts:323` polls `for (let i = 0; i < 60; i++)` with a 1s sleep — a 60s
ceiling, and it breaks on `status === "error"`. This is the one cloud path that
respects a bound; keep it. (It still lacks a per-`fetch` timeout inside the loop
— F1 applies to the poll fetch too.)

### F4 — TTS interruption/barge-in looks correct *(no action)*

`deviceTts.ts` documents that `stopSpeaking` cuts off expo-speech AND any cloud
playback, and the core supports barge-in. Worth a device check that a
mid-sentence user interruption actually silences cloud TTS (not just device),
but the seam is there.

---

## 3. Findings — Device synergy

### S1 — The synergy model is correct and is the product's spine *(strength)*

`runnerChannel.ts` commits each complete instruction to the user's LIVE remote
runner (claude-code / codex / opencode) via `POST /runner/session/turn`,
explicitly NOT a separate cloud voice pipeline: *"no Flux, no second bill … the
runner is the user's own Claude Max / ChatGPT Plus session on their own machine
— paid once, to them."* This is the right call and matches the standing
subscription-only law. Phone speaks → text lands in the runner on the Mac mini /
dev box → the runner works → result streams back. It reuses `dispatchSessionTurn`
so car and hands-free share one dispatch, not two.

### S2 — Native surfaces (watch / Wear) do NOT inherit the RN voice core *(P1, parity gap)*

`watch/YaverWatch/` is Swift; `wear/` is Kotlin. Neither can consume
`mobile/src/lib/voice/`. Per the cross-surface-parity rule, any voice behavior
there is a SEPARATE implementation that must be ported and kept in step by hand —
and drift there would be invisible from the RN side. This audit did not find a
watch/Wear STT path at all (only `SessionClient.swift` relay plumbing), so the
open question is: **is voice on the watch intended, and if so where does its STT
run** — on the watch, or dictated on the phone and relayed? That's a product
decision to make explicit, not leave implied.

### S3 — `assistant.tsx` may not use the shared core *(P2, verify)*

`grep -cE 'Speech|speak|transcri|voice|…' mobile/app/assistant.tsx` → 1, and it
does not import `useHandsFreeVoice`/`createVoiceCore`. Either it delegates voice
elsewhere or it has a thin path of its own. Worth confirming it isn't a fourth
voice entry point drifting from the core — the same shape as the two
browser-preview implementations.

---

## 4. Priorities

1. **F1 — bound every cloud STT fetch** (AbortController + deadline + fallback).
   This is the one that bites a real user on a real network, today, silently.
2. **F2 — confirm/implement device→cloud STT fallback**, and replace the bare
   `catch {}` with one that says which engine failed and what it fell back to.
3. **S2 — decide watch/Wear voice** explicitly (native port, or phone-relayed),
   and write it down.
4. **S3 — confirm `assistant.tsx`** routes through the shared core.

F1 and F2 are the same lesson as the whole session: **an unbounded external call
in a path the user is waiting on will hang silently, and silence is a defect.**
The voice stack enforces this on-device (60s whisper slices, bounded poll) and
forgets it the moment it reaches the cloud.

## 5. Not verified (needs a device)

Whisper init failure → cloud fallback (F2); barge-in silencing cloud TTS (F4);
whether `assistant.tsx` and watch have independent voice paths (S2/S3). All are
inferences from source; a signed-in device with a real mic settles them.
