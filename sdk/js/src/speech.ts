import type { SpeechProvider, SpeechProviderInfo, TranscriptionResult } from './types';

/** Available speech-to-text providers. */
export const SPEECH_PROVIDERS: SpeechProviderInfo[] = [
  {
    id: 'on-device',
    name: 'On-Device (Free)',
    description: 'Runs locally using Whisper. No API key needed.',
    requiresKey: false,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o Mini Transcribe. Fast, accurate.',
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    keyHint: 'Get your key at platform.openai.com/api-keys',
    pricePerMin: '$0.003',
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    description: 'Nova-2. Real-time capable, top accuracy.',
    requiresKey: true,
    keyPlaceholder: 'Your Deepgram API key',
    keyHint: 'Get your key at console.deepgram.com',
    pricePerMin: '$0.004',
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    description: 'Universal-2. Cheapest async option.',
    requiresKey: true,
    keyPlaceholder: 'Your AssemblyAI API key',
    keyHint: 'Get your key at assemblyai.com/dashboard',
    pricePerMin: '$0.002',
  },
];

/**
 * Transcribe an audio file using the specified provider.
 * Works in Node.js (with file:// URIs or paths) and React Native (with content:// URIs).
 */
export async function transcribe(
  audioUri: string,
  provider: SpeechProvider,
  apiKey?: string,
): Promise<TranscriptionResult> {
  const start = Date.now();
  let text: string;

  switch (provider) {
    case 'openai':
      text = await transcribeOpenAI(audioUri, apiKey!);
      break;
    case 'deepgram':
      text = await transcribeDeepgram(audioUri, apiKey!);
      break;
    case 'assemblyai':
      text = await transcribeAssemblyAI(audioUri, apiKey!);
      break;
    case 'on-device':
      throw new Error(
        'On-device transcription requires whisper.rn (React Native) or whisper.cpp (CLI). ' +
        'Use the mobile app or CLI for on-device STT.'
      );
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }

  return { text, durationMs: Date.now() - start, provider };
}

async function transcribeOpenAI(audioUri: string, apiKey: string): Promise<string> {
  const formData = new FormData();
  const audioBlob = await fetchBlob(audioUri);
  formData.append('file', audioBlob, 'audio.m4a');
  formData.append('model', 'gpt-4o-mini-transcribe');
  formData.append('language', 'en');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) throw new Error(`OpenAI STT failed (${resp.status})`);
  const data = await resp.json();
  return data.text?.trim() ?? '';
}

async function transcribeDeepgram(audioUri: string, apiKey: string): Promise<string> {
  const audioBlob = await fetchBlob(audioUri);
  const resp = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
    {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/m4a' },
      body: audioBlob,
    }
  );

  if (!resp.ok) throw new Error(`Deepgram STT failed (${resp.status})`);
  const data = await resp.json();
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}

async function transcribeAssemblyAI(audioUri: string, apiKey: string): Promise<string> {
  const audioBlob = await fetchBlob(audioUri);

  // Upload
  const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { Authorization: apiKey },
    body: audioBlob,
  });
  if (!uploadResp.ok) throw new Error(`AssemblyAI upload failed (${uploadResp.status})`);
  const { upload_url } = await uploadResp.json();

  // Create transcription
  const txResp = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, language_code: 'en' }),
  });
  if (!txResp.ok) throw new Error(`AssemblyAI transcription failed`);
  const { id } = await txResp.json();

  // Poll for result
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: apiKey },
    });
    const pollData = await pollResp.json();
    if (pollData.status === 'completed') return pollData.text?.trim() ?? '';
    if (pollData.status === 'error') throw new Error(`AssemblyAI error: ${pollData.error}`);
  }
  throw new Error('AssemblyAI transcription timed out');
}

async function fetchBlob(uri: string): Promise<Blob> {
  const resp = await fetch(uri);
  return resp.blob();
}
