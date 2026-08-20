/**
 * whisperCapture.ts — AudioCaptureAdapter backed by on-device whisper.rn
 * realtime STT (free, offline, local-first — the default per the product owner).
 *
 * Two things this adapter gets right that the old clip-record path did not:
 *  1. STREAMING partials — whisper.rn's realtime mic emits its best transcript
 *     ~1×/slice, which is exactly what the endpointer needs to detect an
 *     end-of-utterance without a submit button.
 *  2. A CarPlay-correct AVAudioSession — .playAndRecord + .voiceChat mode +
 *     Bluetooth input. The barge-in audit found the original recorder set none
 *     of these, so the car mic (BT-HFP route) captured silence → "I didn't
 *     catch that". .voiceChat also enables the OS voice-processing path
 *     (hardware echo cancellation), which is the groundwork for real barge-in.
 *
 * A smaller slice (1s) is used so silence is detected within a beat instead of
 * whisper.rn's 5s default.
 */
import type { AudioCaptureAdapter, CaptureSession, VoiceSurface } from "../types";
import { startRealtimeTranscribe } from "../../speech";

/** Native surfaces that need an active recording route before Whisper starts. */
const AUDIO_CAPTURE_ROUTES: VoiceSurface[] = ["phone", "car", "glass"];

/**
 * Build the iOS AVAudioSession config whisper.rn should acquire, using its own
 * exported enums when available. Returns undefined on Android or when whisper.rn
 * isn't linked — both safe (whisper.rn then leaves the session alone).
 */
function carVoiceSession(surface: VoiceSurface): unknown {
  if (!AUDIO_CAPTURE_ROUTES.includes(surface)) return undefined;
  try {
    const w = require("whisper.rn");
    const Cat = w.AudioSessionCategoryIos;
    const Opt = w.AudioSessionCategoryOptionIos;
    const Mode = w.AudioSessionModeIos;
    if (!Cat || !Opt || !Mode) return undefined;
    return {
      category: Cat.PlayAndRecord,
      options: [
        Opt.AllowBluetooth,
        Opt.AllowBluetoothA2DP,
        Opt.DefaultToSpeaker,
        Opt.DuckOthers,
      ].filter((x) => x !== undefined),
      // VoiceChat routes through the voice-processing I/O unit → hardware AEC.
      mode: Mode.VoiceChat,
    };
  } catch {
    return undefined;
  }
}

export function createWhisperCapture(): AudioCaptureAdapter {
  return {
    async start(onPartial, opts): Promise<CaptureSession> {
      const surface = opts?.surface ?? "phone";
      const startedAt = Date.now();
      const session = carVoiceSession(surface);
      await ensureMicrophonePermission();
      const ctrl = await startRealtimeTranscribe(
        (text) => onPartial(text, Date.now() - startedAt),
        {
          language: whisperLang(opts?.locale),
          sliceSec: 1,
          audioSessionOnStartIos: session,
          // Restore the prior session on stop so we only hold the voice-chat
          // session while actively listening — CarPlay review criterion 2.
          audioSessionOnStopIos: session ? "restore" : undefined,
        },
      );
      let stopped = false;
      return {
        async stop(): Promise<string> {
          if (stopped) return "";
          stopped = true;
          try {
            return await ctrl.stop();
          } catch {
            return "";
          }
        },
        active: () => !stopped,
      };
    },
  };
}

/**
 * The Tasks screen used to do this setup itself, but Vibe starts the shared
 * voice core directly. Asking for permission without activating
 * PlayAndRecord leaves Whisper running against a silent audio route on iOS:
 * the user sees the permission prompt, the mic button turns on, and no text
 * ever arrives. Keep the operation at the adapter boundary so every surface
 * that owns the mic gets the same real capability check.
 */
async function ensureMicrophonePermission(): Promise<void> {
  try {
    const { Audio } = require("expo-av");
    let permission = await Audio.getPermissionsAsync();
    if (permission.status !== "granted" && permission.canAskAgain) {
      permission = await Audio.requestPermissionsAsync();
    }
    if (permission.status !== "granted") {
      throw new Error("Microphone permission is denied. Enable Microphone for Yaver in Settings.");
    }

    // whisper.rn applies the platform audio-session options passed below, but
    // activating the session here makes the Vibe path deterministic on iOS
    // before the realtime recorder is created.
    if (require("react-native").Platform?.OS === "ios") {
      const { AudioSessionIos } = require("whisper.rn");
      await AudioSessionIos.setCategory("PlayAndRecord", ["DefaultToSpeaker", "AllowBluetooth"]);
      await AudioSessionIos.setActive(true);
    }
  } catch (error) {
    if (error instanceof Error && /Microphone permission is denied/.test(error.message)) throw error;
    throw new Error(`Microphone setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** whisper wants a bare language code ("en", "tr"), not a BCP-47 tag. */
function whisperLang(locale?: string): string {
  if (!locale) return "en";
  return locale.split(/[-_]/)[0].toLowerCase() || "en";
}
