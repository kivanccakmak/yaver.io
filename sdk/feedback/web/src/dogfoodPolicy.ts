export interface SDKDogfoodConfig {
  enabled?: boolean;
  accountIds: string[];
  currentAccountId?: string;
  onExit?: () => void | Promise<void>;
  label?: string;
}

export interface SDKDogfoodStatus {
  active: boolean;
  code: 'SDK_DOGFOOD_ACTIVE' | 'SDK_DOGFOOD_DISABLED' | 'SDK_DOGFOOD_ACCOUNT_REQUIRED' | 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED';
  accountId?: string;
  label: string;
}

/** UX gate only. Server-side Yaver auth still protects every task/reload. */
export function resolveSDKDogfood(config?: SDKDogfoodConfig | null): SDKDogfoodStatus {
  const label = String(config?.label || 'Dogfood').trim() || 'Dogfood';
  if (config?.enabled !== true) return { active: false, code: 'SDK_DOGFOOD_DISABLED', label };
  const accountId = String(config.currentAccountId || '').trim();
  if (!accountId) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_REQUIRED', label };
  const allowed = new Set((config.accountIds || []).map((id) => String(id).trim()).filter(Boolean));
  if (!allowed.has(accountId)) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED', accountId, label };
  return { active: true, code: 'SDK_DOGFOOD_ACTIVE', accountId, label };
}
