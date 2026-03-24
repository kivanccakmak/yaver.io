export interface FeedbackConfig {
  /** Yaver agent URL (e.g., http://192.168.1.100:18080 or relay URL) */
  agentUrl?: string;
  /** Bearer auth token */
  authToken?: string;
  /** How to trigger feedback: floating button, keyboard shortcut, or manual only */
  trigger?: 'floating-button' | 'keyboard' | 'manual';
  /** Keyboard shortcut to trigger (default: Ctrl+Shift+F) */
  shortcut?: string;
  /** Whether SDK is enabled (default: true in development) */
  enabled?: boolean;
  /** Max screen recording duration in seconds (default: 120) */
  maxRecordingDuration?: number;
  /** Position of floating button */
  buttonPosition?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}

export interface TimelineEvent {
  time: number; // seconds from start
  type: 'voice' | 'screenshot' | 'annotation' | 'console-error';
  text?: string;
  file?: string;
}

export interface DeviceInfo {
  platform: 'web';
  browser: string;
  browserVersion: string;
  os: string;
  screenSize: string;
  userAgent: string;
}

export interface FeedbackBundle {
  metadata: {
    source: 'in-app-sdk';
    deviceInfo: DeviceInfo;
    appVersion?: string;
    url: string; // current page URL
    timeline: TimelineEvent[];
    transcript?: string;
    consoleErrors?: string[];
  };
  video?: Blob;
  audio?: Blob;
  screenshots: Blob[];
}

export interface DiscoveryResult {
  url: string;
  hostname: string;
  version: string;
  latency: number; // ms
}
