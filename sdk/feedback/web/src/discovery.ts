import type { DiscoveryResult } from './types';

const STORAGE_KEY = 'yaver_feedback_agent';
const DEFAULT_PORT = 18080;
const TIMEOUT_MS = 2000;

// Common local network prefixes to scan
const LOCAL_PREFIXES = ['192.168.1', '192.168.0', '10.0.0', '10.0.1', '172.16.0'];

/**
 * YaverDiscovery finds Yaver agents on the local network.
 * Used by the feedback SDK to connect to the dev machine without manual config.
 */
export class YaverDiscovery {
  /**
   * Try to discover a Yaver agent on the local network.
   * Checks stored URL first, then scans common local IPs.
   */
  static async discover(): Promise<DiscoveryResult | null> {
    // 1. Check stored connection
    const stored = YaverDiscovery.getStored();
    if (stored) {
      const result = await YaverDiscovery.probe(stored.url);
      if (result) return result;
    }

    // 2. Try localhost (agent on same machine)
    const localhost = await YaverDiscovery.probe(`http://localhost:${DEFAULT_PORT}`);
    if (localhost) {
      YaverDiscovery.store(localhost);
      return localhost;
    }

    // 3. Scan common local IPs (gateway .1 and common dev machine IPs)
    const candidates: string[] = [];
    for (const prefix of LOCAL_PREFIXES) {
      for (const host of [1, 2, 100, 101, 50, 200]) {
        candidates.push(`http://${prefix}.${host}:${DEFAULT_PORT}`);
      }
    }

    // Probe in parallel with timeout
    const results = await Promise.allSettled(
      candidates.map((url) => YaverDiscovery.probe(url))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        YaverDiscovery.store(r.value);
        return r.value;
      }
    }

    return null;
  }

  /**
   * Probe a specific URL to check if a Yaver agent is running there.
   */
  static async probe(url: string): Promise<DiscoveryResult | null> {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) return null;

      const data = await resp.json();
      const latency = Date.now() - start;

      return {
        url,
        hostname: data.hostname || 'unknown',
        version: data.version || 'unknown',
        latency,
      };
    } catch {
      return null;
    }
  }

  /**
   * Manually connect to a known agent URL.
   */
  static async connect(url: string): Promise<DiscoveryResult | null> {
    const result = await YaverDiscovery.probe(url);
    if (result) {
      YaverDiscovery.store(result);
    }
    return result;
  }

  /** Store last known agent connection in localStorage. */
  static store(result: DiscoveryResult): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        url: result.url,
        hostname: result.hostname,
        timestamp: Date.now(),
      }));
    } catch {
      // localStorage not available
    }
  }

  /** Get stored agent connection. */
  static getStored(): { url: string; hostname: string } | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 24 hours
      if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Clear stored connection. */
  static clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
