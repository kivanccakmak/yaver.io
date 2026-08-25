// One start verb and one dev-event grammar for Projects, Dogfood and future
// embedded SDK hosts. Framework selection remains the agent's job: `web:true`
// means Expo/RN web, Flutter web, Vite, Next, etc.; it never means Hermes.

import { runtimeLogLinesFromDevEvent } from "../../../sdk/feedback/react-native/src/DogfoodRuntime";

export interface BrowserProjectLaneRequest {
  framework: string;
  workDir: string;
  targetDeviceId?: string;
  targetDeviceName?: string;
  targetDeviceClass?: string;
}

export interface ProjectPreviewClient {
  startDevServer(options: BrowserProjectLaneRequest & { web: true }): Promise<unknown>;
  subscribeDevEvents(
    onEvent: (event: any) => void,
    options?: { onStreamHealth?: (health: { kind: "reattaching" | "lost"; message: string } | null) => void },
  ): () => void;
}

/** The exact Browser Reload operation used by Projects and Dogfood. */
export function startBrowserProjectLane(client: ProjectPreviewClient, request: BrowserProjectLaneRequest): Promise<unknown> {
  return client.startDevServer({ ...request, web: true });
}

/**
 * Subscribe to the same raw npm/Metro/Expo/Flutter lane Projects renders.
 * Snapshot replay and live frames use one normalizer from the published SDK.
 */
export function subscribeProjectPreviewOutput(
  client: ProjectPreviewClient,
  onLines: (lines: string[], event: any) => void,
  onStreamHealth?: (health: { kind: "reattaching" | "lost"; message: string } | null) => void,
): () => void {
  return client.subscribeDevEvents((event) => {
    const lines = runtimeLogLinesFromDevEvent(event);
    onLines(lines, event);
  }, { onStreamHealth });
}
