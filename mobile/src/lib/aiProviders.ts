import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Medici-style AI provider config for the Yaver app.
 * Mirrors medici.ai's config.json shape:
 *   { llm_providers: { <id>: { api_key, base_url, enabled, models } },
 *     default_provider, default_model, transcription, tts }
 *
 * Stored locally (AsyncStorage) since Convex userSettings has no provider fields.
 */

export interface AiProviderConfig {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
}

export interface AiProvidersConfig {
  providers: Record<string, AiProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  transcription: { provider: string; model: string }; // e.g. provider "openai" (whisper-1) / "deepgram"
  tts: { provider: string; voice: string }; // "on-device" | "openai" | "elevenlabs"
}

const STORAGE_KEY = "@yaver/ai_providers";

const DEFAULT_CONFIG: AiProvidersConfig = {
  providers: {
    // Whisper is the default transcription path (free/self-hostable or OpenAI).
    openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", enabled: true, models: ["whisper-1"] },
  },
  defaultProvider: "openai",
  defaultModel: "whisper-1",
  transcription: { provider: "openai", model: "whisper-1" },
  tts: { provider: "on-device", voice: "" },
};

export async function loadAiProviders(): Promise<AiProvidersConfig> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveAiProviders(config: AiProvidersConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // best effort
  }
}

export async function upsertProvider(
  id: string,
  patch: Partial<AiProviderConfig>
): Promise<AiProvidersConfig> {
  const cfg = await loadAiProviders();
  cfg.providers[id] = { ...cfg.providers[id], ...patch };
  await saveAiProviders(cfg);
  return cfg;
}

export async function removeProvider(id: string): Promise<AiProvidersConfig> {
  const cfg = await loadAiProviders();
  delete cfg.providers[id];
  if (cfg.defaultProvider === id) {
    cfg.defaultProvider = "";
    cfg.defaultModel = "";
  }
  await saveAiProviders(cfg);
  return cfg;
}

/** Endpoint that accepts multipart `file` + `model` and returns { text }. */
export async function transcriptionEndpoint(config: AiProvidersConfig): Promise<string> {
  const t = config.transcription.provider;
  const p = config.providers[t];
  if (!p || !p.enabled || !p.apiKey) return "";
  switch (t) {
    case "openai":
      return `${p.baseUrl || "https://api.openai.com/v1"}/audio/transcriptions`;
    case "deepgram":
      return "https://api.deepgram.com/v1/listen";
    default:
      return p.baseUrl; // custom endpoint returning { text }
  }
}

/** Transcribe recorded audio with the configured provider. */
export async function transcribeWithProviders(audioPath: string): Promise<string> {
  const cfg = await loadAiProviders();
  const t = cfg.transcription.provider;
  const p = cfg.providers[t];
  if (!audioPath || !p || !p.enabled || !p.apiKey) return "";

  const endpoint = await transcriptionEndpoint(cfg);
  if (!endpoint) return "";

  const form = new FormData();
  form.append("file", { uri: audioPath, name: "voice.wav", type: "audio/wav" } as any);
  if (t === "openai") form.append("model", cfg.transcription.model || "whisper-1");

  const headers: Record<string, string> = {};
  if (t === "deepgram") {
    headers["Authorization"] = `Token ${p.apiKey}`;
  } else {
    headers["Authorization"] = `Bearer ${p.apiKey}`;
  }

  try {
    const res = await fetch(endpoint, { method: "POST", headers, body: form });
    if (!res.ok) return "";
    const data = await res.json();
    return (data.text as string) || (data.results?.channels?.[0]?.alternatives?.[0]?.transcript as string) || "";
  } catch {
    return "";
  }
}
