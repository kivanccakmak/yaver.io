export interface DogfoodAccessSnapshot {
  appId: string;
  /** A Yaver session exists locally; not itself an authorization decision. */
  yaverAuthenticated: boolean;
  /** Backend-confirmed owner/maintainer of this exact appId. */
  ownerAuthorized: boolean;
  /** Backend-confirmed app assignment for this Yaver account. App owners are
   * assigned implicitly; other accounts require an active owner grant. */
  accountAuthorized: boolean;
  installationId?: string;
  deviceState: 'unknown' | 'unregistered' | 'pending' | 'active' | 'cancelled' | 'revoked' | 'superseded';
  /** True only for an assigned account and this backend-approved device key. */
  authorized: boolean;
  /** OAuth-backed preference scoped to this user + app + installation. */
  controlPresentation?: 'auto' | 'minimized-y';
  gestureSupported?: boolean;
  gestureCapabilityReason?: string;
  controlOnboardingSeen?: boolean;
}

export interface DogfoodFlowSnapshot {
  phase: 'idle' | 'denied' | 'auth-required' | 'machine-required' | 'opening' | 'error';
  appId?: string;
  error?: string;
}

/** What the approved developer sees after entering Dogfood. Authentication and
 * installation approval are identical in both modes; this changes UI only. */
export type DogfoodUsageMode = 'reload-only' | 'reload-and-chat';

export function resolveDogfoodUsageMode(value?: string | null): DogfoodUsageMode {
  return value === 'reload-only' ? 'reload-only' : 'reload-and-chat';
}

export interface SDKDogfoodConfig {
  /** Explicit opt-in. Omitted/false keeps the normal Feedback SDK. */
  enabled?: boolean;
  /** App-account IDs allowed to enter Dogfood. Public identifiers, not secrets. */
  accountIds?: string[];
  /** The third-party app's currently authenticated account ID. */
  currentAccountId?: string;
  /** Account-bound installation identity resolved by YaverDeviceDogfood. */
  appId?: string;
  installationId?: string;
  installationStatus?: 'pending' | 'active' | 'cancelled' | 'revoked' | 'superseded';
  /** Called after the user confirms Exit Dogfood mode. */
  onExit?: () => void | Promise<void>;
  /** Optional app label shown beside Dogfood mode. */
  label?: string;
  /** Project/framework hints used by the zero-orchestration onboarding UI. */
  projectName?: string;
  /** Exact checkout selected in Dogfood Settings. Reload renders this current
   * working tree and never changes its branch or Git state. */
  projectPath?: string;
  framework?: string;
  /** Optional exact in-app SDK session and native runtime selected by Settings. */
  targetDeviceId?: string;
  runtimeSessionId?: string;
  /** Compact in-app control surface. `reload-only` keeps coding in Yaver Tasks,
   * Claude Code, Codex, or another control plane and exposes no SDK chat.
   * Default `reload-and-chat` preserves the pre-0.9 behavior. */
  usageMode?: DogfoodUsageMode;
  /** Advanced override for staging/self-hosted enrollment. */
  backendUrl?: string;
  /** Presentation-only ACL hook, e.g. `() => user.isAdmin`. Server-side OAuth
   * or device-signature verification remains the authority boundary. */
  canShow?: (access: DogfoodAccessSnapshot) => boolean | Promise<boolean>;
  /** Optional callback alternative to onDogfoodFlowState(). */
  onStateChange?: (state: DogfoodFlowSnapshot) => void;
  /** ACL-backed Home Screen/App Shortcut. Dynamic and absent until Yaver
   * owner auth or this installation's approved key authorizes it. */
  appShortcut?: boolean | { label?: string };
  /** Smart in-app quick controls. On supported standalone iOS/Android builds,
   * a three-finger hold opens a two-action card with no persistent overlay.
   * Unsupported/accessibility-conflicted devices may show a minimized,
   * draggable Y fallback. Yaver host/container mode suppresses both. */
  controlGesture?: boolean | {
    /** Hold duration, clamped to 650–2000 ms. Default 900 ms. */
    durationMs?: number;
    /** Default `minimized-y`; use `none` when Settings is the only fallback. */
    fallback?: 'minimized-y' | 'none';
    /** Initial user-facing presentation before their persisted SDK preference
     * exists. `auto` keeps pixels clear when the gesture works. */
    defaultPresentation?: 'auto' | 'minimized-y';
  };
}

export interface SDKDogfoodStatus {
  active: boolean;
  code: 'SDK_DOGFOOD_ACTIVE' | 'SDK_DOGFOOD_DISABLED' | 'SDK_DOGFOOD_ACCOUNT_REQUIRED' | 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED' | 'SDK_DOGFOOD_INSTALLATION_REQUIRED' | 'SDK_DOGFOOD_INSTALLATION_NOT_ACTIVE';
  accountId?: string;
  label: string;
}

/** Pure, fail-closed account gate shared by init, the Y badge and tests.
 * This controls SDK UX only; every task/reload still requires Yaver auth. */
export function resolveSDKDogfood(config?: SDKDogfoodConfig | null): SDKDogfoodStatus {
  const label = String(config?.label || 'Dogfood').trim() || 'Dogfood';
  if (config?.enabled !== true) return { active: false, code: 'SDK_DOGFOOD_DISABLED', label };
  if (config.appId) {
    if (!config.installationId) return { active: false, code: 'SDK_DOGFOOD_INSTALLATION_REQUIRED', label };
    if (config.installationStatus !== 'active') return { active: false, code: 'SDK_DOGFOOD_INSTALLATION_NOT_ACTIVE', label };
    return { active: true, code: 'SDK_DOGFOOD_ACTIVE', accountId: config.installationId, label };
  }
  const accountId = String(config.currentAccountId || '').trim();
  if (!accountId) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_REQUIRED', label };
  const allowed = new Set((config.accountIds || []).map((id) => String(id).trim()).filter(Boolean));
  if (!allowed.has(accountId)) return { active: false, code: 'SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED', accountId, label };
  return { active: true, code: 'SDK_DOGFOOD_ACTIVE', accountId, label };
}
