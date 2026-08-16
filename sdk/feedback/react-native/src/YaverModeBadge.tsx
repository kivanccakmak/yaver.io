// YaverModeBadge.tsx — the polite "you're running inside Yaver" mark, for
// THIRD-PARTY apps.
//
// ── Why a third-party app needs this ────────────────────────────────────────
//
// When your app is pushed into Yaver's container as a Hermes bundle, it looks
// exactly like your installed build. Same icon, same launch, same everything —
// except it is a development bundle from someone's branch. Testers have chased
// "bugs" that were only unbuilt work, and have been unable to find their way
// back to the real app because nothing on screen said there was anywhere to go.
//
// So the SDK shows one small Y, low contrast, in a corner. Tapping it says what
// you're in and how to leave. Nothing else.
//
// ── Defaults, and why ───────────────────────────────────────────────────────
//
// DEFAULT ENABLED (`modeBadge: true`), because the failure it prevents is
// silent and lands on a tester rather than the developer — exactly the class
// that should not be opt-in. Turn it off with `modeBadge: false` when your app
// has its own in-container indicator, or when a screenshot-perfect surface
// genuinely cannot afford 22 points in a corner.
//
// ── What it is NOT ──────────────────────────────────────────────────────────
//
// It is NOT the escape. Yaver's container owns that: shake opens Yaver's own
// overlay with "Back to Yaver". This badge only tells you the gesture exists.
// Making it the exit would put the way out inside the previewed app, which is
// the trap the container's escape-ownership rules exist to prevent — the guest
// could style over it, or unmount it, and the tester would be stuck.

import React, { useEffect, useState } from 'react';
import { Modal, NativeModules, Pressable, Text, View } from 'react-native';

/** True only inside Yaver's container: the YaverInfo native module is
 *  registered by Yaver's app and by nothing else. Same probe ShakeDetector
 *  and P2PClient use — one answer, not three. */
function isInsideYaver(): boolean {
  try {
    return !!(NativeModules as any)?.YaverInfo;
  } catch {
    return false;
  }
}

/**
 * Per-RUN dismissal, shared by every mounted badge.
 *
 * Deliberately in memory, not storage. A permanently hidden badge recreates
 * exactly the problem the badge exists to prevent: a tester who cannot tell an
 * unbuilt branch from the installed app, and cannot find the way back. Polite
 * means not nagging within a session — it does not mean permanent amnesia
 * about which build you are looking at. A relaunch is a new context.
 *
 * An APP that wants it gone for good passes `modeBadge: false` at init. That is
 * a developer making an informed choice, which is a different thing from a
 * tester clearing their screen for a minute.
 */
let hiddenThisRun = false;
const hideListeners = new Set<() => void>();

/** Hide the mark for the rest of this run. Exposed on YaverFeedback so a host
 *  can wire its own "hide" control, and used by the sheet's own button. */
export function hideYaverModeBadge(): void {
  hiddenThisRun = true;
  hideListeners.forEach((l) => {
    try {
      l();
    } catch {
      /* one bad listener mustn't block the others */
    }
  });
}

/** Bring it back — e.g. when a NEW guest bundle loads and the context changed. */
export function showYaverModeBadge(): void {
  hiddenThisRun = false;
  hideListeners.forEach((l) => {
    try {
      l();
    } catch {
      /* noop */
    }
  });
}

export function isYaverModeBadgeHidden(): boolean {
  return hiddenThisRun;
}

export interface YaverModeBadgeProps {
  /** Corner to sit in. Default bottom-left: bottom-right is where most apps
   *  put a FAB, and the badge must never compete with the app's own action. */
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  /** Render even outside Yaver. Development aid only — the badge is meaningless
   *  in a standalone build and would be wallpaper. */
  force?: boolean;
}

export function YaverModeBadge({ position = 'bottom-left', force = false }: YaverModeBadgeProps) {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);

  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    hideListeners.add(listener);
    return () => {
      hideListeners.delete(listener);
    };
  }, []);

  // Standalone builds render nothing at all — zero cost, zero pixels.
  if (!force && !isInsideYaver()) return null;
  if (hiddenThisRun) return null;

  const vertical = position.startsWith('top') ? { top: 44 } : { bottom: 28 };
  const horizontal = position.endsWith('left') ? { left: 12 } : { right: 12 };

  return (
    <>
      <View
        // The wrapper never intercepts touches; only the 22pt mark does. A
        // full-screen overlay that swallowed taps would break the app it is
        // supposed to be politely annotating.
        pointerEvents="box-none"
        style={{ position: 'absolute', ...vertical, ...horizontal, zIndex: 9998 }}
      >
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Running inside Yaver"
          hitSlop={10}
          style={({ pressed }) => ({
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: 'rgba(124,92,255,0.45)',
            backgroundColor: 'rgba(124,92,255,0.14)',
            opacity: pressed ? 0.6 : 0.9,
          })}
        >
          <Text style={{ color: '#7C5CFF', fontSize: 12, fontWeight: '700', lineHeight: 14 }}>Y</Text>
        </Pressable>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: '#0008' }} onPress={() => setOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              margin: 24,
              marginTop: 'auto',
              marginBottom: 48,
              borderRadius: 16,
              padding: 18,
              backgroundColor: '#151519',
              borderWidth: 1,
              borderColor: '#2a2a32',
              gap: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: '#7C5CFF', fontSize: 15, fontWeight: '800' }}>Y</Text>
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Running inside Yaver</Text>
            </View>
            <Text style={{ color: '#b6b6c0', fontSize: 13, lineHeight: 19 }}>
              This is a development build loaded into Yaver — not the version installed on this
              device. Anything unfinished here is work in progress, not a released bug.
            </Text>
            <Text style={{ color: '#b6b6c0', fontSize: 13, lineHeight: 19 }}>
              Shake the device to open Yaver's overlay, where "Back to Yaver" returns you to the
              installed app.
            </Text>
            {/* Polite means closeable. "for now", never "don't show again":
                the badge returns next launch so nobody forgets which build
                they're testing. */}
            <Pressable
              onPress={() => {
                hideYaverModeBadge();
                setOpen(false);
              }}
              style={{ paddingVertical: 10, alignItems: 'center' }}
            >
              <Text style={{ color: '#8a8a96', fontSize: 13 }}>Hide for now</Text>
            </Pressable>
            <Text style={{ color: '#6b6b76', fontSize: 11, textAlign: 'center', lineHeight: 15 }}>
              Hidden until you next launch this build.
            </Text>

            <Pressable onPress={() => setOpen(false)} style={{ paddingVertical: 10, alignItems: 'center' }}>
              <Text style={{ color: '#8a8a96', fontSize: 13 }}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export default YaverModeBadge;
