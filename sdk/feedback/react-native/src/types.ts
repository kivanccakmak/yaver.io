export interface FeedbackConfig {
  /** URL of the Yaver agent (e.g. "http://192.168.1.10:18080"). If omitted, auto-discovery is used. */
  agentUrl?: string;
  /** Auth token for the Yaver agent */
  authToken: string;
  /** How feedback collection is triggered */
  trigger?: 'shake' | 'floating-button' | 'manual';
  /** Enable/disable the SDK. Defaults to __DEV__ */
  enabled?: boolean;
  /** Max screen recording duration in seconds. Default: 120 */
  maxRecordingDuration?: number;
  /**
   * Feedback mode:
   * - 'live': stream events to the agent as they happen
   * - 'narrated': record everything, send on stop
   * - 'batch': dump everything at end (default)
   */
  feedbackMode?: 'live' | 'narrated' | 'batch';
  /**
   * Agent commentary level (0-10).
   * 0 = silent, 10 = agent comments on everything it sees.
   * Only relevant in live mode. Default: 0.
   */
  agentCommentaryLevel?: number;
}

export interface FeedbackBundle {
  metadata: FeedbackMetadata;
  video?: string;
  audio?: string;
  screenshots: string[];
}

export interface FeedbackMetadata {
  timestamp: string;
  device: DeviceInfo;
  app: AppInfo;
  userNote?: string;
}

export interface DeviceInfo {
  platform: string;
  osVersion: string;
  model: string;
  screenWidth: number;
  screenHeight: number;
}

export interface AppInfo {
  bundleId?: string;
  version?: string;
  buildNumber?: string;
}

export interface TimelineEvent {
  type: 'screenshot' | 'audio' | 'video';
  path: string;
  timestamp: string;
  duration?: number;
}

export interface FeedbackReport {
  id: string;
  bundle: FeedbackBundle;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  error?: string;
}

export interface AgentCommentary {
  id: string;
  timestamp: string;
  message: string;
  type: 'observation' | 'suggestion' | 'question' | 'action';
}

export interface FeedbackStreamEvent {
  type: string;
  timestamp: string;
  data: any;
}
