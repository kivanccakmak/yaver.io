import { FeedbackConfig } from './types';
import { YaverDiscovery } from './Discovery';
import { P2PClient } from './P2PClient';

let config: FeedbackConfig | null = null;
let enabled = false;
let p2pClient: P2PClient | null = null;

/**
 * Main entry point for the Yaver Feedback SDK.
 * Call `YaverFeedback.init()` once at app startup.
 */
export class YaverFeedback {
  /**
   * Initialize the feedback SDK with the given configuration.
   * Typically called in your app's root component or entry file.
   *
   * If no `agentUrl` is provided, the SDK will attempt auto-discovery
   * via `YaverDiscovery` on the first `startReport()` call.
   */
  static init(cfg: FeedbackConfig): void {
    config = {
      trigger: 'shake',
      maxRecordingDuration: 120,
      feedbackMode: 'batch',
      agentCommentaryLevel: 0,
      ...cfg,
    };

    // Default: enabled only in dev mode
    if (cfg.enabled !== undefined) {
      enabled = cfg.enabled;
    } else {
      enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    }

    // Create P2P client if we have a URL
    if (config.agentUrl) {
      p2pClient = new P2PClient(config.agentUrl, config.authToken);
    } else {
      p2pClient = null;
    }
  }

  /**
   * Manually trigger the feedback collection flow.
   * Opens the feedback modal if the SDK is initialized and enabled.
   *
   * If no agentUrl was configured, runs auto-discovery first.
   */
  static async startReport(): Promise<void> {
    if (!config) {
      console.warn('[YaverFeedback] SDK not initialized. Call YaverFeedback.init() first.');
      return;
    }
    if (!enabled) {
      return;
    }

    // Auto-discover if no agent URL was provided
    if (!config.agentUrl) {
      try {
        const result = await YaverDiscovery.discover();
        if (result) {
          config.agentUrl = result.url;
          p2pClient = new P2PClient(result.url, config.authToken);
        } else {
          console.warn('[YaverFeedback] No agent found. Set agentUrl or ensure agent is running on the network.');
        }
      } catch (err) {
        console.warn('[YaverFeedback] Auto-discovery failed:', err);
      }
    }

    // Emit event that the FeedbackModal listens for
    const { DeviceEventEmitter } = require('react-native');
    DeviceEventEmitter.emit('yaverFeedback:startReport');
  }

  /** Returns true if the SDK has been initialized. */
  static isInitialized(): boolean {
    return config !== null;
  }

  /** Enable or disable the feedback SDK at runtime. */
  static setEnabled(value: boolean): void {
    enabled = value;
  }

  /** Returns whether the SDK is currently enabled. */
  static isEnabled(): boolean {
    return enabled;
  }

  /** Returns the current config, or null if not initialized. */
  static getConfig(): FeedbackConfig | null {
    return config;
  }

  /**
   * Returns the P2P client instance.
   * Available after init if agentUrl is set, or after first successful discovery.
   */
  static getP2PClient(): P2PClient | null {
    return p2pClient;
  }

  /** Returns the current feedback mode. */
  static getFeedbackMode(): 'live' | 'narrated' | 'batch' {
    return config?.feedbackMode ?? 'batch';
  }

  /** Returns the agent commentary level (0-10). */
  static getCommentaryLevel(): number {
    return config?.agentCommentaryLevel ?? 0;
  }
}
