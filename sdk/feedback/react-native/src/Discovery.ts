import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'yaver_feedback_agent';
const DEFAULT_PORT = 18080;
const TIMEOUT_MS = 2000;

export interface DiscoveryResult {
  url: string;
  hostname: string;
  version: string;
  latency: number;
}

// Common LAN subnets and host suffixes to scan
const SUBNETS = ['192.168.1', '192.168.0', '10.0.0', '10.0.1'];
const HOST_SUFFIXES = [1, 2, 50, 100, 101, 200];

/**
 * Device discovery for finding Yaver agents on the local network.
 *
 * Tries a stored connection first, then scans common LAN IPs by probing
 * the agent's `/health` endpoint with a 2s timeout.
 */
export class YaverDiscovery {
  /**
   * Try stored connection first, then scan common LAN IPs.
   * Returns the first agent found, or null if none reachable.
   */
  static async discover(): Promise<DiscoveryResult | null> {
    // Try stored connection first
    const stored = await YaverDiscovery.getStored();
    if (stored) {
      const result = await YaverDiscovery.probe(stored.url);
      if (result) {
        return result;
      }
      // Stored connection is stale — clear it
      await YaverDiscovery.clear();
    }

    // Scan common LAN IPs in parallel
    const candidates: string[] = [];
    for (const subnet of SUBNETS) {
      for (const suffix of HOST_SUFFIXES) {
        candidates.push(`http://${subnet}.${suffix}:${DEFAULT_PORT}`);
      }
    }

    // Probe all candidates concurrently — first one wins
    const results = await Promise.allSettled(
      candidates.map((url) => YaverDiscovery.probe(url)),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        await YaverDiscovery.store(r.value);
        return r.value;
      }
    }

    return null;
  }

  /**
   * Probe a specific URL for a running Yaver agent.
   * Hits the `/health` endpoint with a 2s timeout.
   */
  static async probe(url: string): Promise<DiscoveryResult | null> {
    const base = url.replace(/\/$/, '');
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(`${base}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const latency = Date.now() - start;

      let hostname = 'Unknown';
      let version = 'unknown';

      try {
        const data = await response.json();
        hostname = data.hostname ?? data.name ?? 'Unknown';
        version = data.version ?? 'unknown';
      } catch {
        // Health endpoint might return plain text — that's fine
      }

      return { url: base, hostname, version, latency };
    } catch {
      return null;
    }
  }

  /**
   * Manually connect to a specific agent URL.
   * Probes the URL and stores the connection if successful.
   */
  static async connect(url: string): Promise<DiscoveryResult | null> {
    const result = await YaverDiscovery.probe(url);
    if (result) {
      await YaverDiscovery.store(result);
    }
    return result;
  }

  /** Get the cached agent connection from AsyncStorage. */
  static async getStored(): Promise<{ url: string; hostname: string } | null> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === 'string') {
        return { url: parsed.url, hostname: parsed.hostname ?? 'Unknown' };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Store a successful discovery result in AsyncStorage. */
  static async store(result: DiscoveryResult): Promise<void> {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ url: result.url, hostname: result.hostname }),
      );
    } catch {
      // Storage failure is non-fatal
    }
  }

  /** Clear the stored agent connection. */
  static async clear(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage failure is non-fatal
    }
  }
}
