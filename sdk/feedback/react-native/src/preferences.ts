/**
 * SDK user preferences persisted across launches.
 *
 * Currently only the quick-action icon's user-level dismiss flag
 * lives here: the dev enables the icon via `FeedbackConfig.quickIcon`,
 * but the *user* can long-press → Hide to opt out, and we remember
 * that choice across launches so their next app session still
 * respects it.
 *
 * AsyncStorage is an optional peer dep — if it's not installed the
 * getters return `false` and the setters silently no-op, so the icon
 * still works (it just can't remember the disable beyond the
 * in-memory session).
 */

let AsyncStorage: {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
} | null = null;
try {
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch {
  // not installed — degrade gracefully
}

const QUICK_ICON_DISABLED_KEY = 'yaver_feedback_quickicon_disabled';
const QUICK_ICON_COLOR_KEY = 'yaver_feedback_quickicon_color';
const DOGFOOD_CONTROL_PRESENTATION_KEY = 'yaver_dogfood_control_presentation';
const DOGFOOD_CONTROL_POSITION_PREFIX = 'yaver_dogfood_control_position_';
const DOGFOOD_CONTROL_ONBOARDING_PREFIX = 'yaver_dogfood_control_onboarding_';
const DOGFOOD_ENTRY_ICON_HIDDEN_PREFIX = 'yaver_dogfood_entry_icon_hidden_';
const DOGFOOD_USAGE_MODE_PREFIX = 'yaver_dogfood_usage_mode_';
const DOGFOOD_START_BEHAVIOR_PREFIX = 'yaver_dogfood_start_behavior_';
const DOGFOOD_RENDER_BEHAVIOR_PREFIX = 'yaver_dogfood_render_behavior_';
const DOGFOOD_SESSION_BEHAVIOR_PREFIX = 'yaver_dogfood_session_behavior_';
const DOGFOOD_MODE_ACTIVE_PREFIX = 'yaver_dogfood_mode_active_';
// Settings and Launch are commonly separate component instances. Publish a
// setting synchronously before awaiting AsyncStorage so a quick Back → Launch
// cannot observe the previous value. AsyncStorage remains the durable source
// across process launches; this map only closes the in-process handoff race.
const dogfoodPreferenceCache = new Map<string, string>();

export type DogfoodControlPresentation = 'auto' | 'minimized-y';
export type DogfoodUsageMode = 'chat-only' | 'reload-only' | 'reload-and-chat';
export type DogfoodStartBehavior = 'vibe-first' | 'render-on-open';
export type DogfoodRenderBehavior = 'manual' | 'auto-on-request';
export type DogfoodSessionBehavior = 'resume-last' | 'new-session';
export type DogfoodControlEdge = 'left' | 'right';
export interface DogfoodControlPosition {
  edge: DogfoodControlEdge;
  /** 0–1 within the safe vertical travel area. */
  yRatio: number;
}

function dogfoodPreferenceKey(base: string, scope?: string): string {
  const normalized = String(scope || 'legacy').trim() || 'legacy';
  return `${base}_${encodeURIComponent(normalized)}`;
}

/** The Dogfood entry icon is visible by default. Hiding is an explicit,
 * scoped user preference so one app cannot make the entry disappear in
 * another app. */
export async function getDogfoodEntryIconHidden(scope?: string): Promise<boolean> {
  if (!AsyncStorage) return false;
  try {
    return await AsyncStorage.getItem(dogfoodPreferenceKey(DOGFOOD_ENTRY_ICON_HIDDEN_PREFIX, scope)) === '1';
  } catch {
    return false;
  }
}

export async function setDogfoodEntryIconHidden(hidden: boolean, scope?: string): Promise<void> {
  if (!AsyncStorage) return;
  try {
    const key = dogfoodPreferenceKey(DOGFOOD_ENTRY_ICON_HIDDEN_PREFIX, scope);
    if (hidden) await AsyncStorage.setItem(key, '1');
    else await AsyncStorage.removeItem(key);
  } catch {
    // Presentation only; Dogfood authorization and runtime are unaffected.
  }
}

/** Dogfood survives the React bridge recreation caused by a Hermes bundle
 * swap. Approval alone never turns this on; only a successful enrollment or
 * explicit launch does. Exit Dogfood clears it before disabling controls. */
export async function getDogfoodModeActive(appId?: string): Promise<boolean> {
  if (!AsyncStorage || !appId) return false;
  try {
    return await AsyncStorage.getItem(dogfoodPreferenceKey(DOGFOOD_MODE_ACTIVE_PREFIX, appId)) === '1';
  } catch {
    return false;
  }
}

export async function setDogfoodModeActive(active: boolean, appId?: string): Promise<void> {
  if (!AsyncStorage || !appId) return;
  try {
    const key = dogfoodPreferenceKey(DOGFOOD_MODE_ACTIVE_PREFIX, appId);
    if (active) await AsyncStorage.setItem(key, '1');
    else await AsyncStorage.removeItem(key);
  } catch {
    // Best-effort lifecycle cache. OAuth + installation proof stay authoritative.
  }
}

export async function getDogfoodControlPresentation(scope?: string): Promise<DogfoodControlPresentation | null> {
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(dogfoodPreferenceKey(DOGFOOD_CONTROL_PRESENTATION_KEY, scope));
    return value === 'auto' || value === 'minimized-y' ? value : null;
  } catch {
    return null;
  }
}

export async function setDogfoodControlPresentation(value: DogfoodControlPresentation, scope?: string): Promise<void> {
  if (!AsyncStorage) return;
  try {
    await AsyncStorage.setItem(dogfoodPreferenceKey(DOGFOOD_CONTROL_PRESENTATION_KEY, scope), value);
  } catch {
    // best-effort
  }
}

export async function getDogfoodControlPosition(
  orientation: 'portrait' | 'landscape',
  scope?: string,
): Promise<DogfoodControlPosition | null> {
  if (!AsyncStorage) return null;
  try {
    const raw = await AsyncStorage.getItem(
      dogfoodPreferenceKey(`${DOGFOOD_CONTROL_POSITION_PREFIX}${orientation}`, scope),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DogfoodControlPosition>;
    if ((parsed.edge !== 'left' && parsed.edge !== 'right') || typeof parsed.yRatio !== 'number') return null;
    return { edge: parsed.edge, yRatio: Math.max(0, Math.min(1, parsed.yRatio)) };
  } catch {
    return null;
  }
}

export async function setDogfoodControlPosition(
  orientation: 'portrait' | 'landscape',
  position: DogfoodControlPosition,
  scope?: string,
): Promise<void> {
  if (!AsyncStorage) return;
  try {
    await AsyncStorage.setItem(
      dogfoodPreferenceKey(`${DOGFOOD_CONTROL_POSITION_PREFIX}${orientation}`, scope),
      JSON.stringify(position),
    );
  } catch {
    // best-effort
  }
}

export async function getDogfoodControlOnboardingSeen(scope?: string): Promise<boolean> {
  if (!AsyncStorage) return false;
  try {
    return await AsyncStorage.getItem(dogfoodPreferenceKey(DOGFOOD_CONTROL_ONBOARDING_PREFIX, scope)) === '1';
  } catch {
    return false;
  }
}

export async function setDogfoodControlOnboardingSeen(seen: boolean, scope?: string): Promise<void> {
  if (!AsyncStorage) return;
  try {
    const key = dogfoodPreferenceKey(DOGFOOD_CONTROL_ONBOARDING_PREFIX, scope);
    if (seen) await AsyncStorage.setItem(key, '1');
    else await AsyncStorage.removeItem(key);
  } catch {
    // best-effort startup cache; Convex remains authoritative.
  }
}

export async function getDogfoodUsageMode(scope?: string): Promise<DogfoodUsageMode | null> {
  const key = dogfoodPreferenceKey(DOGFOOD_USAGE_MODE_PREFIX, scope);
  const cached = dogfoodPreferenceCache.get(key);
  if (cached === 'chat-only' || cached === 'reload-only' || cached === 'reload-and-chat') return cached;
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(key);
    if (value === 'chat-only' || value === 'reload-only' || value === 'reload-and-chat') {
      dogfoodPreferenceCache.set(key, value);
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setDogfoodUsageMode(value: DogfoodUsageMode, scope?: string): Promise<void> {
  const key = dogfoodPreferenceKey(DOGFOOD_USAGE_MODE_PREFIX, scope);
  dogfoodPreferenceCache.set(key, value);
  if (!AsyncStorage) return;
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // Best-effort local presentation preference. Agent authorization remains
    // OAuth-backed and never depends on this value.
  }
}

export async function getDogfoodStartBehavior(scope?: string): Promise<DogfoodStartBehavior | null> {
  const key = dogfoodPreferenceKey(DOGFOOD_START_BEHAVIOR_PREFIX, scope);
  const cached = dogfoodPreferenceCache.get(key);
  if (cached === 'vibe-first' || cached === 'render-on-open') return cached;
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(key);
    if (value === 'vibe-first' || value === 'render-on-open') {
      dogfoodPreferenceCache.set(key, value);
      return value;
    }
    return null;
  } catch { return null; }
}

export async function setDogfoodStartBehavior(value: DogfoodStartBehavior, scope?: string): Promise<void> {
  const key = dogfoodPreferenceKey(DOGFOOD_START_BEHAVIOR_PREFIX, scope);
  dogfoodPreferenceCache.set(key, value);
  if (!AsyncStorage) return;
  try { await AsyncStorage.setItem(key, value); } catch { /* best-effort */ }
}

export async function getDogfoodRenderBehavior(scope?: string): Promise<DogfoodRenderBehavior | null> {
  const key = dogfoodPreferenceKey(DOGFOOD_RENDER_BEHAVIOR_PREFIX, scope);
  const cached = dogfoodPreferenceCache.get(key);
  if (cached === 'manual' || cached === 'auto-on-request') return cached;
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(key);
    if (value === 'manual' || value === 'auto-on-request') {
      dogfoodPreferenceCache.set(key, value);
      return value;
    }
    return null;
  } catch { return null; }
}

export async function setDogfoodRenderBehavior(value: DogfoodRenderBehavior, scope?: string): Promise<void> {
  const key = dogfoodPreferenceKey(DOGFOOD_RENDER_BEHAVIOR_PREFIX, scope);
  dogfoodPreferenceCache.set(key, value);
  if (!AsyncStorage) return;
  try { await AsyncStorage.setItem(key, value); } catch { /* best-effort */ }
}

export async function getDogfoodSessionBehavior(scope?: string): Promise<DogfoodSessionBehavior | null> {
  const key = dogfoodPreferenceKey(DOGFOOD_SESSION_BEHAVIOR_PREFIX, scope);
  const cached = dogfoodPreferenceCache.get(key);
  if (cached === 'resume-last' || cached === 'new-session') return cached;
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(key);
    if (value === 'resume-last' || value === 'new-session') {
      dogfoodPreferenceCache.set(key, value);
      return value;
    }
    return null;
  } catch { return null; }
}

export async function setDogfoodSessionBehavior(value: DogfoodSessionBehavior, scope?: string): Promise<void> {
  const key = dogfoodPreferenceKey(DOGFOOD_SESSION_BEHAVIOR_PREFIX, scope);
  dogfoodPreferenceCache.set(key, value);
  if (!AsyncStorage) return;
  try { await AsyncStorage.setItem(key, value); } catch { /* best-effort */ }
}

export type QuickIconColorPreset =
  | 'orange'
  | 'lime'
  | 'cyan'
  | 'pink'
  | 'yellow'
  | 'slate';

export const QUICK_ICON_COLOR_PRESETS: Record<
  QuickIconColorPreset,
  {
    label: string;
    backgroundColor: string;
    foregroundColor: string;
    borderColor: string;
    shadowColor: string;
  }
> = {
  orange: {
    label: 'Orange',
    backgroundColor: '#ff6b2c',
    foregroundColor: '#111111',
    borderColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#000000',
  },
  lime: {
    label: 'Lime',
    backgroundColor: '#a3e635',
    foregroundColor: '#111111',
    borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: '#365314',
  },
  cyan: {
    label: 'Cyan',
    backgroundColor: '#22d3ee',
    foregroundColor: '#082f49',
    borderColor: 'rgba(255,255,255,0.82)',
    shadowColor: '#083344',
  },
  pink: {
    label: 'Pink',
    backgroundColor: '#fb7185',
    foregroundColor: '#fff1f2',
    borderColor: 'rgba(255,255,255,0.78)',
    shadowColor: '#4c0519',
  },
  yellow: {
    label: 'Yellow',
    backgroundColor: '#facc15',
    foregroundColor: '#1c1917',
    borderColor: 'rgba(255,255,255,0.88)',
    shadowColor: '#713f12',
  },
  slate: {
    label: 'Slate',
    backgroundColor: '#475569',
    foregroundColor: '#f8fafc',
    borderColor: 'rgba(255,255,255,0.68)',
    shadowColor: '#020617',
  },
};

/** True if the user has long-pressed the icon and chosen "Hide". */
export async function getQuickIconDisabled(): Promise<boolean> {
  if (!AsyncStorage) return false;
  try {
    const v = await AsyncStorage.getItem(QUICK_ICON_DISABLED_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

export async function setQuickIconDisabled(disabled: boolean): Promise<void> {
  if (!AsyncStorage) return;
  try {
    if (disabled) {
      await AsyncStorage.setItem(QUICK_ICON_DISABLED_KEY, '1');
    } else {
      await AsyncStorage.removeItem(QUICK_ICON_DISABLED_KEY);
    }
  } catch {
    // best-effort
  }
}

export async function clearQuickIconDisabled(): Promise<void> {
  await setQuickIconDisabled(false);
}

export async function getQuickIconColorPreset(): Promise<QuickIconColorPreset | null> {
  if (!AsyncStorage) return null;
  try {
    const v = await AsyncStorage.getItem(QUICK_ICON_COLOR_KEY);
    if (!v) return null;
    if (Object.prototype.hasOwnProperty.call(QUICK_ICON_COLOR_PRESETS, v)) {
      return v as QuickIconColorPreset;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setQuickIconColorPreset(
  preset: QuickIconColorPreset | null,
): Promise<void> {
  if (!AsyncStorage) return;
  try {
    if (!preset) {
      await AsyncStorage.removeItem(QUICK_ICON_COLOR_KEY);
      return;
    }
    await AsyncStorage.setItem(QUICK_ICON_COLOR_KEY, preset);
  } catch {
    // best-effort
  }
}

export async function clearQuickIconColorPreset(): Promise<void> {
  await setQuickIconColorPreset(null);
}

// ── Preferred coding agent + model (used by the standalone feedback
// SDK's vibe chat to mirror what Yaver mobile's Tasks tab would send.
// The agent on the remote DOES read userSettings.primaryRunnerByDevice
// from Convex, but the standalone SDK has no DeviceContext to push the
// per-device pick. We persist the user's last choice locally; first
// run picks whatever's signed-in via getRunnerStatus().)

const PREFERRED_RUNNER_KEY = 'yaver_feedback_preferred_runner';
const PREFERRED_MODEL_KEY = 'yaver_feedback_preferred_model';
// v3 changes React Native's default back to the fast browser lane. The new key
// prevents a v2-era implicit Hermes choice from surviving an app upgrade. An
// explicit choice made after this migration remains durable.
const PREFERRED_DOGFOOD_LANE_PREFIX = 'yaver_feedback_dogfood_lane_browser_v3_';
const preferredDogfoodLaneCache = new Map<string, 'browser' | 'hermes' | 'webrtc'>();

export async function getPreferredRunner(): Promise<string | null> {
  if (!AsyncStorage) return null;
  try {
    const v = await AsyncStorage.getItem(PREFERRED_RUNNER_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export async function setPreferredRunner(runner: string | null): Promise<void> {
  if (!AsyncStorage) return;
  try {
    if (!runner || !runner.trim()) {
      await AsyncStorage.removeItem(PREFERRED_RUNNER_KEY);
      return;
    }
    await AsyncStorage.setItem(PREFERRED_RUNNER_KEY, runner.trim());
  } catch {
    /* best-effort */
  }
}

export async function getPreferredModel(): Promise<string | null> {
  if (!AsyncStorage) return null;
  try {
    const v = await AsyncStorage.getItem(PREFERRED_MODEL_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export async function setPreferredModel(model: string | null): Promise<void> {
  if (!AsyncStorage) return;
  try {
    if (!model || !model.trim()) {
      await AsyncStorage.removeItem(PREFERRED_MODEL_KEY);
      return;
    }
    await AsyncStorage.setItem(PREFERRED_MODEL_KEY, model.trim());
  } catch {
    /* best-effort */
  }
}

export async function getPreferredDogfoodLane(appId: string): Promise<'browser' | 'hermes' | 'webrtc' | null> {
  if (!appId) return null;
  const cached = preferredDogfoodLaneCache.get(appId);
  if (cached) return cached;
  if (!AsyncStorage) return null;
  try {
    const value = await AsyncStorage.getItem(`${PREFERRED_DOGFOOD_LANE_PREFIX}${appId}`);
    if (value === 'browser' || value === 'hermes' || value === 'webrtc') {
      preferredDogfoodLaneCache.set(appId, value);
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setPreferredDogfoodLane(appId: string, lane: 'browser' | 'hermes' | 'webrtc'): Promise<void> {
  if (!appId) return;
  // Update memory before the first await. Yaver's Settings and Launch surfaces
  // are separate component instances; without this handoff, a fast Back +
  // Launch can observe the old lane while AsyncStorage is still writing.
  preferredDogfoodLaneCache.set(appId, lane);
  if (!AsyncStorage) return;
  try {
    await AsyncStorage.setItem(`${PREFERRED_DOGFOOD_LANE_PREFIX}${appId}`, lane);
  } catch {
    /* best-effort */
  }
}

const DOGFOOD_RUNTIME_SELECTION_PREFIX = '@yaver/dogfood_runtime_selection:';

export interface DogfoodRuntimeSelection {
  projectName?: string;
  projectPath?: string;
  lane: 'browser' | 'hermes' | 'webrtc';
  targetDeviceId?: string;
  runtimeSessionId?: string;
}

export async function getDogfoodRuntimeSelection(appId: string): Promise<DogfoodRuntimeSelection | null> {
  if (!AsyncStorage || !appId) return null;
  try {
    const raw = await AsyncStorage.getItem(`${DOGFOOD_RUNTIME_SELECTION_PREFIX}${appId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DogfoodRuntimeSelection;
    if (!['browser', 'hermes', 'webrtc'].includes(parsed?.lane)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setDogfoodRuntimeSelection(appId: string, selection: DogfoodRuntimeSelection): Promise<void> {
  if (!AsyncStorage || !appId) return;
  try {
    await AsyncStorage.setItem(`${DOGFOOD_RUNTIME_SELECTION_PREFIX}${appId}`, JSON.stringify(selection));
  } catch {
    /* best-effort */
  }
}
