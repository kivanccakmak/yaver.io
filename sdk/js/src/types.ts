export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  runnerId?: string;
  sessionId?: string;
  output?: string;
  resultText?: string;
  costUsd?: number;
  turns?: Turn[];
  source?: string;
  tmuxSession?: string;
  isAdopted?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ImageAttachment {
  base64: string;
  mimeType: string;
  filename: string;
}

export interface CreateTaskOptions {
  model?: string;
  runner?: string;
  customCommand?: string;
  speechContext?: SpeechContext;
  images?: ImageAttachment[];
}

export interface SpeechContext {
  inputFromSpeech?: boolean;
  sttProvider?: string;
  ttsEnabled?: boolean;
  ttsProvider?: string;
  verbosity?: number;
}

export interface AgentInfo {
  hostname: string;
  platform: string;
  agentVersion: string;
  runningTasks: number;
  totalTasks: number;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  provider: string;
  surveyCompleted?: boolean;
}

export interface Device {
  deviceId: string;
  name: string;
  platform: string;
  quicHost: string;
  quicPort: number;
  isOnline: boolean;
  lastHeartbeat: string;
}

export interface UserSettings {
  forceRelay?: boolean;
  runnerId?: string;
  customRunnerCommand?: string;
  speechProvider?: SpeechProvider;
  speechApiKey?: string;
  ttsEnabled?: boolean;
  verbosity?: number;
}

export type SpeechProvider = 'on-device' | 'openai' | 'deepgram' | 'assemblyai';

export interface SpeechProviderInfo {
  id: SpeechProvider;
  name: string;
  description: string;
  requiresKey: boolean;
  keyPlaceholder?: string;
  keyHint?: string;
  pricePerMin?: string;
}

export interface TranscriptionResult {
  text: string;
  durationMs: number;
  provider: string;
}
