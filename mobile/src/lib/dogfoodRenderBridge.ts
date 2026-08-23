/** Cross-JS-context render signal for Dogfood mode.
 *
 * The Tasks screen runs inside the attached RN-web WebView, while the surface
 * that owns reload lives in the native host. Module event emitters cannot cross
 * that boundary, so the inner app posts one small, non-authoritative message.
 */

export const DOGFOOD_RENDER_MESSAGE = "yaver:dogfood-render";

export type DogfoodRenderMessage = {
  type: typeof DOGFOOD_RENDER_MESSAGE;
  source: string;
};

export function makeDogfoodRenderMessage(source: string): string {
  return JSON.stringify({ type: DOGFOOD_RENDER_MESSAGE, source } satisfies DogfoodRenderMessage);
}

export function parseDogfoodRenderMessage(raw: string): DogfoodRenderMessage | null {
  try {
    const value = JSON.parse(raw) as Partial<DogfoodRenderMessage>;
    if (value.type !== DOGFOOD_RENDER_MESSAGE) return null;
    return { type: DOGFOOD_RENDER_MESSAGE, source: String(value.source || "dogfood-task") };
  } catch {
    return null;
  }
}

export function isAttachedDogfoodWebRuntime(scope: any = globalThis): boolean {
  try {
    return scope?.localStorage?.getItem?.("yaver.attach.mode") === "1" &&
      typeof scope?.ReactNativeWebView?.postMessage === "function";
  } catch {
    return false;
  }
}
