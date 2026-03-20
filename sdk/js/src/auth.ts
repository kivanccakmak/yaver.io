import type { User, Device, UserSettings } from './types';

const DEFAULT_CONVEX_URL = 'https://perceptive-minnow-557.eu-west-1.convex.site';

/**
 * Auth client for the Yaver Convex backend.
 * Handles token validation, device listing, and settings management.
 */
export class YaverAuthClient {
  convexURL: string;
  authToken: string;

  constructor(authToken: string, convexURL?: string) {
    this.convexURL = (convexURL || DEFAULT_CONVEX_URL).replace(/\/$/, '');
    this.authToken = authToken;
  }

  /** Validate the auth token and return user info. */
  async validateToken(): Promise<User> {
    const result = await this.get<{ user: User }>('/auth/validate');
    return result.user;
  }

  /** List registered devices. */
  async listDevices(): Promise<Device[]> {
    const result = await this.get<{ devices: Device[] }>('/devices');
    return result.devices;
  }

  /** Get user settings. */
  async getSettings(): Promise<UserSettings> {
    const result = await this.get<{ settings: UserSettings }>('/settings');
    return result.settings || {};
  }

  /** Save user settings. */
  async saveSettings(settings: Partial<UserSettings>): Promise<void> {
    await this.post('/settings', settings);
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.convexURL}${path}`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    await fetch(`${this.convexURL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
}
