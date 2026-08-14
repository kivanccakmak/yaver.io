import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { loadAiProviders, transcribeWithProviders } from "./aiProviders";

// YaverSpeech is a local native module: iOS/tvOS pod + Android Kotlin module.
// Guard everything so the app works where the module isn't linked.
const native: any = (NativeModules as any)?.YaverSpeech ?? null;

export type SpeechListeners = {
  onPartial?: (text: string) => void;
  onResult?: (text: string) => void;
  onError?: (code: string) => void;
};

export function isSpeechAvailable(): boolean {
  return !!native;
}

export function isAndroidSpeech(): boolean {
  return Platform.OS === "android" && !!native;
}

/** Subscribe to STT events (DeviceEventEmitter works on iOS/tvOS + Android). */
export function addSpeechListeners(listeners: SpeechListeners): () => void {
  const subs: Array<{ remove: () => void }> = [];
  if (listeners.onResult) subs.push(DeviceEventEmitter.addListener("onResult", listeners.onResult));
  if (listeners.onPartial) subs.push(DeviceEventEmitter.addListener("onPartial", listeners.onPartial));
  if (listeners.onError) subs.push(DeviceEventEmitter.addListener("onError", listeners.onError));
  return () => {
    subs.forEach((s) => {
      try {
        s.remove();
      } catch {
        // ignore
      }
    });
  };
}

export async function speak(text: string, rate = 0.5): Promise<boolean> {
  if (!native?.speak) return false;
  try {
    return (await native.speak(text, rate)) === true;
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

/** Start listening. On Android requests RECORD_AUDIO first. */
export async function startListening(locale = "en-US"): Promise<boolean> {
  if (!native?.startListening) return false;
  if (Platform.OS === "android") {
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
    } catch {
      return false;
    }
  }
  try {
    return (await native.startListening(locale)) === true;
  } catch {
    return false;
  }
}

/**
 * Stop listening. On iOS/tvOS resolves the recorded audio file path (fed to a
 * cloud transcription provider). On Android the result arrives via the
 * "onResult" event instead, so this resolves "".
 */
export async function stopListening(): Promise<string> {
  if (!native?.stopListening) return "";
  try {
    const r = await native.stopListening();
    return typeof r === "string" ? r : "";
  } catch {
    return "";
  }
}

/** True if a transcription provider is configured with a key (iOS/tvOS path). */
export async function isTranscriptionAvailable(): Promise<boolean> {
  const cfg = await loadAiProviders();
  const p = cfg.providers[cfg.transcription.provider];
  return !!(p?.enabled && p.apiKey);
}

/** Upload a recorded audio file and get back transcribed text (iOS/tvOS). */
export async function transcribeAudio(audioPath: string): Promise<string> {
  if (!audioPath) return "";
  return transcribeWithProviders(audioPath);
}
