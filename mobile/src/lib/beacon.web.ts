/**
 * Web stub for the LAN beacon listener.
 *
 * The native implementation uses `react-native-udp` to listen for UDP
 * broadcasts on port 19837. Browsers cannot bind UDP sockets, so on web
 * we expose a no-op implementation with the same shape — discovery just
 * always reports "no local devices", and the QUIC client falls through to
 * its Convex-known-IP / relay paths.
 */

export interface DiscoveredDevice {
  deviceId: string;
  ip: string;
  port: number;
  name: string;
  lastSeen: number;
  hwid?: string;
}

type DiscoveryCallback = (device: DiscoveredDevice) => void;
type LostCallback = (deviceId: string) => void;

class BeaconListenerWeb {
  async setUserId(_userId: string): Promise<void> {}
  setKnownDevices(_deviceIds: string[]): void {}
  start(): void {}
  stop(): void {}
  onDiscovered(_cb: DiscoveryCallback): () => void {
    return () => {};
  }
  onLost(_cb: LostCallback): () => void {
    return () => {};
  }
  getDevices(): DiscoveredDevice[] {
    return [];
  }
  /**
   * Bootstrap (needs-auth) devices. Empty on web: LAN beacon discovery is UDP,
   * which a browser cannot do at all.
   *
   * This method was MISSING from the web stub while the native twin had it, and
   * DeviceContext calls it on an interval — so the browser build threw
   * "beaconListener.getBootstrapDevices is not a function" every tick and never
   * connected to a machine. TypeScript did not catch it because the two files
   * are separate classes resolved by Metro's platform extension, not two
   * implementations of one interface: drift here fails at RUNTIME, in a timer,
   * on the surface least likely to be tested. beacon.parity.test.ts now asserts
   * the surfaces match so the next divergence fails a test instead of a user.
   */
  getBootstrapDevices(): DiscoveredDevice[] {
    return [];
  }
  isLocal(_deviceId: string): boolean {
    return false;
  }
  getLocalIP(_deviceId: string): { ip: string; port: number } | null {
    return null;
  }
}

export const beaconListener = new BeaconListenerWeb();
