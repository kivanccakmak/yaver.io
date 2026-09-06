import { connectionManager } from './connectionManager';
import type { BrowserShortcutDriver } from '../../../sdk/feedback/react-native/src/BrowserShortcut';

function clientFor(deviceId: string) {
  const client = connectionManager.clientFor(deviceId);
  return client?.isConnected ? client : null;
}

export function browserShortcutDriverFor(deviceId: string): BrowserShortcutDriver | null {
  return clientFor(deviceId)?.browserShortcutDriver() ?? null;
}

export interface BrowserShortcutEnrollment {
  id: string;
  code: string;
  createdAt: string;
}

export async function listBrowserShortcutEnrollments(
  deviceId: string,
  appId: string,
): Promise<BrowserShortcutEnrollment[]> {
  const client = clientFor(deviceId);
  if (!client) return [];
  return client.listBrowserShortcutEnrollments(appId);
}

export async function approveBrowserShortcutEnrollment(
  deviceId: string,
  appId: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = clientFor(deviceId);
  if (!client) return { ok: false, error: 'The selected machine is not connected.' };
  return client.approveBrowserShortcutEnrollment(appId, code);
}

/** Invoke and stream a deterministic missing-toolchain repair. */
export async function installBrowserShortcutTool(
  deviceId: string,
  tool: string,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const client = clientFor(deviceId);
  if (!client) return { ok: false, error: 'The selected machine is not connected.' };
  const started = await client.installTool(tool);
  if (!started.ok) return { ok: false, error: started.error || `Could not start ${tool} installation.` };
  return await new Promise((resolve) => {
    let settled = false;
    let stop = () => {};
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      stop();
      resolve(result);
    };
    stop = client.subscribeStream(
      started.stream,
      onLine,
      (status, error) => finish({ ok: status === 'ok', error: status === 'ok' ? undefined : error || `${tool} installation failed.` }),
    );
  });
}
