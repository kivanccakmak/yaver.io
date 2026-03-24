/**
 * Yaver Dogfooding — Yaver's own feedback SDK embedded in the Yaver mobile app.
 *
 * This enables developing Yaver's mobile app using Yaver itself:
 * - Screen recording + voice while testing Yaver features
 * - Bug reports sent to the dev machine running the AI agent
 * - Hot reload via P2P tunnel
 * - Voice-driven live coding: "make this tab bar taller"
 *
 * Enabled only in __DEV__ mode.
 */

import { Platform, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  startFeedbackSession,
  stopFeedbackSession,
  uploadFeedback,
  type FeedbackSession,
  type FeedbackBundle,
} from './feedback';

const DOGFOOD_KEY = 'yaver_dogfood_agent';

interface DogfoodConfig {
  agentUrl: string;
  authToken: string;
  enabled: boolean;
  commentaryLevel: number; // 0-10
}

let config: DogfoodConfig | null = null;
let activeSession: FeedbackSession | null = null;

/**
 * Initialize Yaver dogfooding. Call in app startup.
 * Only active in __DEV__ mode.
 */
export async function initDogfood(): Promise<void> {
  if (!__DEV__) return;

  // Load saved config
  try {
    const raw = await AsyncStorage.getItem(DOGFOOD_KEY);
    if (raw) {
      config = JSON.parse(raw);
      console.log('[yaver-dogfood] Loaded config:', config?.agentUrl);
    }
  } catch {
    // ignore
  }
}

/** Configure the dogfood agent connection. */
export async function configureDogfood(agentUrl: string, authToken: string): Promise<boolean> {
  try {
    const resp = await fetch(`${agentUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;

    config = {
      agentUrl,
      authToken,
      enabled: true,
      commentaryLevel: 5,
    };
    await AsyncStorage.setItem(DOGFOOD_KEY, JSON.stringify(config));
    console.log('[yaver-dogfood] Connected to', agentUrl);
    return true;
  } catch {
    return false;
  }
}

/** Start a feedback recording session. */
export async function startDogfoodSession(mode: 'live' | 'narrated' | 'batch' = 'narrated'): Promise<void> {
  if (!config?.enabled) return;
  activeSession = await startFeedbackSession(mode);
  console.log('[yaver-dogfood] Recording started');
}

/** Stop recording and send feedback to dev machine. */
export async function stopAndSendDogfood(): Promise<string | null> {
  if (!config?.enabled || !activeSession) return null;

  const bundle = await stopFeedbackSession(activeSession);
  activeSession = null;

  try {
    const reportId = await uploadFeedback(
      config.agentUrl,
      { Authorization: `Bearer ${config.authToken}` },
      bundle,
    );
    console.log('[yaver-dogfood] Report sent:', reportId);
    return reportId;
  } catch (err) {
    console.error('[yaver-dogfood] Upload failed:', err);
    return null;
  }
}

/** Send a voice command to the agent (voice-driven live coding). */
export async function sendVoiceCommand(text: string): Promise<void> {
  if (!config?.enabled) return;

  try {
    await fetch(`${config.agentUrl}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        'Content-Type': 'application/json',
        'X-Client-Platform': Platform.OS,
      },
      body: JSON.stringify({ title: text }),
    });
  } catch {
    // silent fail
  }
}

/** Check if dogfooding is active. */
export function isDogfoodActive(): boolean {
  return __DEV__ && config?.enabled === true;
}

/** Get current config. */
export function getDogfoodConfig(): DogfoodConfig | null {
  return config;
}

/** Check if recording. */
export function isRecording(): boolean {
  return activeSession?.recording === true;
}
