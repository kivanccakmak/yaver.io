let current = false;
const listeners = new Set<(enabled: boolean) => void>();

export function publishAutoRenderVibing(enabled: boolean): void {
  current = enabled === true;
  for (const listener of listeners) listener(current);
}

export function subscribeAutoRenderVibing(listener: (enabled: boolean) => void): () => void {
  listener(current);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
