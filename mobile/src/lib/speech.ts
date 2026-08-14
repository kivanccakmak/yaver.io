import { NativeEventEmitter, NativeModules } from "react-native";
import { loadAiProviders, transcribeWithProviders } from "./aiProviders";

// YaverSpeech is a local native pod (TTS + mic recording for tvOS). Guard
// everything so the app works on platforms where the module isn't linked.
const native: any = (NativeModules as any)?.YaverSpeech ?? null;
let emitter: NativeEventEmitter | null = null;
if (native) {
  try {
    emitter = new NativeEventEmitter(native);
  } catch {
    emitter = null;
  }
}

export type SpeechListeners = {
  onError?: (code: string) => void;
};

export function isSpeechAvailable(): boolean {
  return !!native;
}

/** Subscribe to STT events. Returns an unsubscribe function. */
export function addSpeechListeners(listeners: SpeechListeners): () => void {
  const unsubs: Array<{ remove: () => void }> = [];
  if (emitter) {
    if (listeners.onError) {
      unsubs.push(emitter.addListener("onError", listeners.onError));
    }
  }
  return () => {
    unsubs.forEach((u) => {
      try {
        u.remove();
      } catch {
        // ignore
      }
    });
  };
}

export async function speak(text: string, rate = 0.5): Promise<boolean> {
  if (!native?.speak) return false;
  try {
    return await native.speak(text, rate);
  } catch {
    return false;
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    if (native?.stopSpeaking) await native.stopSpeaking();
  } catch {
    // ignore
  }
}

export async function isSpeaking(): Promise<boolean> {
  try {
    return (await native?.isTtsSpeaking()) === true;
  } catch {
    return false;
  }
}

/** Start recording the system microphone. Resolves true when recording. */
export async function startListening(): Promise<boolean> {
  if (!native?.startListening) return false;
  try {
    return await native.startListening("en-US");
  } catch {
    return false;
  }
}

/** Stop recording. Resolves the absolute path of the recorded audio file. */
export async function stopListening(): Promise<string> {
  if (!native?.stopListening) return "";
  try {
    const path = await native.stopListening();
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
}

/** True if a transcription provider is configured with a key. */
export async function isTranscriptionAvailable(): Promise<boolean> {
  const cfg = await loadAiProviders();
  const p = cfg.providers[cfg.transcription.provider];
  return !!(p?.enabled && p.apiKey);
}

/** Upload a recorded audio file and get back transcribed text. */
export async function transcribeAudio(audioPath: string): Promise<string> {
  if (!audioPath) return "";
  return transcribeWithProviders(audioPath);
}
