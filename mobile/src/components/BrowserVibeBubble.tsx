import React from "react";

import {
  DogfoodEntryIcon,
  type DogfoodRenderBehavior,
  type DogfoodSessionBehavior,
  type DogfoodUsageMode,
  type DogfoodFailure,
  type DogfoodLane,
  type DogfoodLogLine,
  type DogfoodPhase,
} from "../../../sdk/feedback/react-native/src";

type ReloadKind = "fast" | "full";

/**
 * Compatibility boundary for preview call sites.
 *
 * Dogfood used to mount an independent chat/settings/reload sheet here. That
 * duplicated the native Dogfood menu, obscured the app being tested, and kept
 * a second task subscription alive. The running surface now gets exactly one
 * shared-library affordance: Y. Tapping it returns to the native Dogfood menu;
 * the preview and its state stay mounted behind navigation.
 */
export function BrowserVibeBubble({
  onExitPreview,
  onGoHome,
  exitLabel = "Open Dogfood",
}: {
  projectPath?: string;
  projectName?: string;
  onExitPreview: () => void;
  onGoHome?: () => void;
  exitLabel?: string;
  endLabel?: string;
  onReload: (kind: ReloadKind) => boolean | void | Promise<boolean | void>;
  reloadBusy?: boolean;
  onFixException?: () => void | Promise<void>;
  exceptionFixBusy?: boolean;
  usageMode?: DogfoodUsageMode;
  renderBehavior?: DogfoodRenderBehavior;
  sessionBehavior?: DogfoodSessionBehavior;
  reloadProgress?: {
    lane: DogfoodLane;
    phase: DogfoodPhase;
    message: string;
    logs: readonly DogfoodLogLine[];
    failure?: DogfoodFailure;
  };
}) {
  return (
    <DogfoodEntryIcon
      accessibilityLabel={exitLabel}
      preferenceScope="io.yaver.mobile:native"
      onPress={onGoHome || onExitPreview}
    />
  );
}
