export interface SDKDogfoodConfig {
  /** Explicit opt-in. Omitted/false keeps the normal Feedback SDK. */
  enabled?: boolean;
  /** App-account IDs allowed to enter Dogfood. Public identifiers, not secrets. */
  accountIds: string[];
  /** The third-party app's currently authenticated account ID. */
  currentAccountId?: string;
  /** Called after the user confirms Exit Dogfood mode. */
  onExit?: () => void | Promise<void>;
  /** Optional app label shown beside Dogfood mode. */
  label?: string;
}

export interface SDKDogfoodStatus {
  active: boolean;
  code: 'SDK_DOGFOOD_ACTIVE' | 'SDK_DOGFOOD_DISABLED' | 'SDK_DOGFOOD_ACCOUNT_REQUIRED' | 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED';
  accountId?: string;
  label: string;
}

/** Pure, fail-closed account gate shared by init, the Y badge and tests.
 * This controls SDK UX only; every task/reload still requires Yaver auth. */
export function resolveSDKDogfood(config?: SDKDogfoodConfig | null): SDKDogfoodStatus {
  const label = String(config?.label || 'Dogfood').trim() || 'Dogfood';
  if (config?.enabled !== true) return { active: false, code: 'SDK_DOGFOOD_DISABLED', label };
  const accountId = String(config.currentAccountId || '').trim();
  if (!accountId) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_REQUIRED', label };
  const allowed = new Set((config.accountIds || []).map((id) => String(id).trim()).filter(Boolean));
  if (!allowed.has(accountId)) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED', accountId, label };
  return { active: true, code: 'SDK_DOGFOOD_ACTIVE', accountId, label };
}
