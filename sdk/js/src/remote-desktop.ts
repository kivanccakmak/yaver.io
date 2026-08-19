/** Typed client contract for Yaver's consent-gated Remote Desktop surface. */

export interface RemoteDesktopDisplay {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface RemoteDesktopStatus {
  supported: boolean;
  viewEnabled: boolean;
  viewConsentSet: boolean;
  viewConsentRequired: boolean;
  controlEnabled: boolean;
  allowRemoteControl: boolean;
  notifyOnControl: boolean;
  streaming: boolean;
  fps: number;
  streamUrl: string;
  frameUrl: string;
  displays?: RemoteDesktopDisplay[];
  displaysError?: string;
  engineError?: string;
}

export interface RemoteDesktopPolicyPatch {
  viewEnabled?: boolean;
  controlEnabled?: boolean;
  allowRemoteControl?: boolean;
  notifyOnControl?: boolean;
}

export interface RemoteDesktopPolicyResult {
  ok: boolean;
  viewEnabled: boolean;
  viewConsentSet: boolean;
  controlEnabled: boolean;
  allowRemoteControl: boolean;
  notifyOnControl: boolean;
}

export type RemoteDesktopInputEvent =
  | { type: 'move' | 'click' | 'double'; nx: number; ny: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'drag'; nx: number; ny: number; tonx: number; tony: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'scroll'; dx?: number; dy?: number }
  | { type: 'text'; text: string }
  | { type: 'key'; keys: string[] };

export interface RemoteDesktopFrame {
  bytes: Uint8Array;
  contentType: string;
}

export interface RemoteDesktopAPI {
  status(): Promise<RemoteDesktopStatus>;
  setPolicy(patch: RemoteDesktopPolicyPatch): Promise<RemoteDesktopPolicyResult>;
  frame(): Promise<RemoteDesktopFrame>;
  sendInput(events: RemoteDesktopInputEvent[]): Promise<{ ok: boolean; applied: number; partialError?: string }>;
}

export type RemoteDesktopRequest = (path: string, init?: RequestInit, json?: boolean) => Promise<Response>;

export function createRemoteDesktopAPI(request: RemoteDesktopRequest): RemoteDesktopAPI {
  const checked = async (path: string, init?: RequestInit, json = false) => {
    const response = await request(path, init, json);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`Remote Desktop ${path} -> HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  };

  return {
    async status() {
      return (await (await checked('/rd/status')).json()) as RemoteDesktopStatus;
    },
    async setPolicy(patch) {
      const response = await checked('/rd/policy', { method: 'POST', body: JSON.stringify(patch) }, true);
      return (await response.json()) as RemoteDesktopPolicyResult;
    },
    async frame() {
      const response = await checked('/rd/frame.jpg', { headers: { Accept: 'image/jpeg' } });
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'image/jpeg',
      };
    },
    async sendInput(events) {
      const response = await checked('/rd/input', { method: 'POST', body: JSON.stringify({ events }) }, true);
      return (await response.json()) as { ok: boolean; applied: number; partialError?: string };
    },
  };
}
