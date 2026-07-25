export function previewProxyErrorMessage(status: number, bodyText: string): string {
  let msg = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.error) msg = String(parsed.error);
  } catch {
    if (bodyText) msg = bodyText.slice(0, 200);
  }
  if (/missing auth token/i.test(msg)) {
    return "Preview proxy cannot see your dashboard auth cookie. Yaver now restores it automatically from the active session; reload the dashboard or press Retry preview.";
  }
  return msg;
}

