import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { YaverFeedback, type DogfoodControlTriggerState } from './YaverFeedback';
import {
  getDogfoodControlPosition,
  setDogfoodControlPosition,
  type DogfoodControlEdge,
  type DogfoodControlPresentation,
} from './preferences';
import type { DogfoodUsageMode } from './dogfoodPolicy';

const FALLBACK_SIZE = 36;
const DOCK_VISIBLE = 21;
const SAFE_TOP = 64;
const SAFE_BOTTOM = 92;
const EMPTY_STATE: DogfoodControlTriggerState = {
  configured: false,
  authorized: false,
  gestureSupported: false,
  gestureEnabled: false,
  fallbackVisible: false,
  presentation: 'auto',
  onboardingSeen: false,
  reason: 'not-configured',
};

function preferenceScope(state: DogfoodControlTriggerState): string | undefined {
  return state.appId && state.installationId ? `${state.appId}:${state.installationId}` : undefined;
}

/**
 * The standalone SDK's only persistent chrome. A newly authorized tester sees
 * this edge-docked Y until first-run onboarding is completed in Convex. After
 * that, capable devices default to a passive three-finger hold; unsupported
 * devices keep the Y. Both entry points open exactly the same compact card.
 */
export const DogfoodQuickControls: React.FC = () => {
  const { width, height } = useWindowDimensions();
  const orientation = width > height ? 'landscape' : 'portrait';
  const defaultPosition = useMemo(() => ({
    x: Math.max(width - DOCK_VISIBLE, 0),
    y: Math.max(Math.round(height * 0.45), SAFE_TOP),
  }), [height, width]);
  const pan = useRef(new Animated.ValueXY(defaultPosition)).current;
  const opacity = useRef(new Animated.Value(0.72)).current;
  const lastPosition = useRef(defaultPosition);
  const dragStart = useRef(defaultPosition);
  const dragged = useRef(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dockEdge, setDockEdge] = useState<DogfoodControlEdge>('right');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [state, setState] = useState<DogfoodControlTriggerState>(EMPTY_STATE);
  const [open, setOpen] = useState(false);
  const [showControlSettings, setShowControlSettings] = useState(false);
  const [busy, setBusy] = useState<'reload' | 'chat' | 'preference' | 'update' | 'exit' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [agentUpdateRequired, setAgentUpdateRequired] = useState(false);
  const [usageMode, setUsageMode] = useState<DogfoodUsageMode>('reload-and-chat');

  const scheduleFade = useCallback(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0.42, duration: 260, useNativeDriver: true }).start();
    }, 1800);
  }, [opacity]);

  const wakeControl = useCallback(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    Animated.timing(opacity, { toValue: 1, duration: 100, useNativeDriver: true }).start();
  }, [opacity]);

  const refresh = useCallback(async () => {
    try {
      const next = await YaverFeedback.syncDogfoodControlGesture();
      setState(next);
      if (next.authorized) setUsageMode(await YaverFeedback.getDogfoodUsageMode());
    } catch {
      setState(EMPTY_STATE);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const trigger = DeviceEventEmitter.addListener('yaverDogfoodControlGesture', () => {
      setMessage(null);
      setShowControlSettings(false);
      setOpen(true);
    });
    const capability = DeviceEventEmitter.addListener('yaverDogfoodControlCapability', () => {
      void refresh();
    });
    // Enrollment approval and Exit Dogfood both change SDK mode while this
    // component remains mounted. Refresh React state immediately; native
    // setEnabled() alone cannot make the fallback Y appear or disappear.
    const mode = DeviceEventEmitter.addListener('yaverFeedback:dogfoodChanged', () => {
      void refresh();
    });
    const usage = DeviceEventEmitter.addListener('yaverFeedback:dogfoodUsageModeChanged', (payload) => {
      if (payload?.mode === 'reload-only' || payload?.mode === 'reload-and-chat') {
        setUsageMode(payload.mode);
      }
    });
    const openUsage = DeviceEventEmitter.addListener('yaverFeedback:dogfoodUsageRequested', () => {
      setMessage(null);
      setShowControlSettings(false);
      setOpen(true);
      void refresh();
    });
    return () => {
      trigger.remove();
      capability.remove();
      mode.remove();
      usage.remove();
      openUsage.remove();
    };
  }, [refresh]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await getDogfoodControlPosition(orientation, preferenceScope(state));
      if (cancelled) return;
      const edge = saved?.edge || 'right';
      const minY = SAFE_TOP;
      const maxY = Math.max(minY, height - FALLBACK_SIZE - SAFE_BOTTOM);
      const y = saved
        ? minY + (maxY - minY) * saved.yRatio
        : Math.max(minY, Math.min(maxY, Math.round(height * 0.45)));
      const next = { x: edge === 'left' ? -FALLBACK_SIZE + DOCK_VISIBLE : width - DOCK_VISIBLE, y };
      setDockEdge(edge);
      lastPosition.current = next;
      pan.setValue(next);
      scheduleFade();
    })();
    return () => { cancelled = true; };
  }, [height, orientation, pan, scheduleFade, state.appId, state.installationId, width]);

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => {
      wakeControl();
      dragged.current = false;
      dragStart.current = lastPosition.current;
      pan.setOffset(lastPosition.current);
      pan.setValue({ x: 0, y: 0 });
    },
    onPanResponderMove: (_, gesture) => {
      if (Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3) dragged.current = true;
      Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })(_, gesture);
    },
    onPanResponderRelease: (_, gesture) => {
      pan.flattenOffset();
      const minY = SAFE_TOP;
      const maxY = Math.max(minY, height - FALLBACK_SIZE - SAFE_BOTTOM);
      const rawX = dragStart.current.x + gesture.dx;
      const y = Math.max(minY, Math.min(maxY, dragStart.current.y + gesture.dy));
      const edge: DogfoodControlEdge = rawX + FALLBACK_SIZE / 2 < width / 2 ? 'left' : 'right';
      const x = edge === 'left' ? -FALLBACK_SIZE + DOCK_VISIBLE : width - DOCK_VISIBLE;
      const next = { x, y };
      const yRatio = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
      setDockEdge(edge);
      lastPosition.current = next;
      Animated.spring(pan, { toValue: next, useNativeDriver: false, friction: 7 }).start(scheduleFade);
      void setDogfoodControlPosition(orientation, { edge, yRatio }, preferenceScope(state));
    },
    onPanResponderTerminate: scheduleFade,
  }), [height, orientation, pan, scheduleFade, state.appId, state.installationId, wakeControl, width]);

  const choosePresentation = useCallback(async (presentation: DogfoodControlPresentation) => {
    if (busy) return;
    setBusy('preference');
    setMessage(null);
    try {
      const next = await YaverFeedback.setDogfoodControlPresentation(presentation);
      setState(next);
      setShowControlSettings(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const fastReload = useCallback(async () => {
    if (busy) return;
    setBusy('reload');
    setMessage(null);
    setAgentUpdateRequired(false);
    try {
      const ack = await YaverFeedback.requestDogfoodFastReload();
      setMessage(ack || 'Fast Reload requested.');
      setTimeout(() => setOpen(false), 650);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setAgentUpdateRequired(detail.includes('DOGFOOD_AGENT_UPGRADE_REQUIRED'));
      setMessage(detail.replace(/^DOGFOOD_AGENT_UPGRADE_REQUIRED:\s*/, ''));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const updateAgent = useCallback(async () => {
    if (busy) return;
    setBusy('update');
    setMessage(null);
    try {
      setMessage(await YaverFeedback.updateDogfoodRenderAgent());
      setAgentUpdateRequired(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const openChat = useCallback(async () => {
    if (busy) return;
    setBusy('chat');
    setMessage(null);
    setOpen(false);
    const result = await YaverFeedback.openDogfood();
    if (result.phase === 'denied' || result.phase === 'error') {
      setMessage(result.error || 'Dogfood access is not available on this installation.');
      setOpen(true);
    }
    setBusy(null);
  }, [busy]);

  const openSessionSetup = useCallback(async () => {
    if (busy) return;
    setOpen(false);
    setShowControlSettings(false);
    const result = await YaverFeedback.openDogfood();
    if (result.phase === 'denied' || result.phase === 'error') {
      setMessage(result.error || 'Dogfood session settings are not available on this installation.');
      setOpen(true);
      setShowControlSettings(true);
    }
  }, [busy]);

  const chooseUsageMode = useCallback(async (mode: DogfoodUsageMode) => {
    if (busy) return;
    setBusy('preference');
    setMessage(null);
    try {
      setUsageMode(await YaverFeedback.setDogfoodUsageMode(mode));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const backToNative = useCallback(async () => {
    if (busy) return;
    setBusy('exit');
    setMessage(null);
    try {
      await YaverFeedback.exitDogfoodMode();
      setOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  if (!state.configured || !state.authorized) return null;
  const onboarding = !state.onboardingSeen;

  return (
    <>
      {state.fallbackVisible && !keyboardVisible && !open ? (
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.layer]}>
          <Animated.View
            {...panResponder.panHandlers}
            style={[
              styles.fallbackPosition,
              { opacity, transform: [{ translateX: pan.x }, { translateY: pan.y }] },
            ]}
          >
            <Pressable
              testID="yaver-dogfood-minimized-control"
              accessibilityRole="button"
              accessibilityLabel="Open Dogfood controls"
              hitSlop={10}
              onPressIn={wakeControl}
              onPress={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setMessage(null);
                setShowControlSettings(false);
                setOpen(true);
              }}
              style={({ pressed }) => [styles.fallback, pressed && styles.pressed]}
            >
              <Text style={[
                styles.fallbackText,
                dockEdge === 'right' ? styles.rightDockText : styles.leftDockText,
              ]}>y</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
            {onboarding ? (
              <>
                <Text style={styles.title}>Dogfood ready</Text>
                <Text style={styles.explanation}>
                  {state.gestureSupported
                    ? `Dogfood starts with the edge Y so you always know how to return. ${usageMode === 'reload-only' ? 'This app is in Reload Only mode.' : 'Reload and Chat are enabled.'}`
                    : 'This device cannot reliably use the three-finger hold, so the edge Y stays available.'}
                </Text>
                <ModeButton
                  title={busy === 'preference' ? 'Saving…' : 'Continue with Y'}
                  hint={usageMode === 'reload-only' ? 'Open Fast Reload from the edge' : 'Open Fast Reload and Chat from the edge'}
                  disabled={busy !== null}
                  onPress={() => void choosePresentation('minimized-y')}
                />
              </>
            ) : showControlSettings ? (
              <>
                <Text style={styles.title}>Dogfood settings</Text>
                {state.gestureSupported ? (
                  <Text style={styles.supported}>Three-finger hold supported on this device</Text>
                ) : null}
                <View style={styles.stackedActions}>
                  {state.gestureSupported ? (
                    <>
                      <ModeButton
                        title="Three-finger hold"
                        hint="No persistent Y over the app"
                        selected={state.presentation === 'auto'}
                        disabled={busy !== null}
                        onPress={() => void choosePresentation('auto')}
                      />
                      <ModeButton
                        title="Always show Y"
                        hint="Keep the draggable edge control"
                        selected={state.presentation === 'minimized-y'}
                        disabled={busy !== null}
                        onPress={() => void choosePresentation('minimized-y')}
                      />
                    </>
                  ) : null}
                  <ModeButton
                    title="Reload Only"
                    hint="Use Yaver Tasks, Claude Code, Codex, or another control plane"
                    selected={usageMode === 'reload-only'}
                    disabled={busy !== null}
                    onPress={() => void chooseUsageMode('reload-only')}
                  />
                  <ModeButton
                    title="Reload + Chat"
                    hint="Also show Yaver's in-app Dogfood conversation"
                    selected={usageMode === 'reload-and-chat'}
                    disabled={busy !== null}
                    onPress={() => void chooseUsageMode('reload-and-chat')}
                  />
                  <ModeButton
                    title="Session setup"
                    hint="Change machine, coding agent, model, or runtime lane"
                    disabled={busy !== null}
                    onPress={() => void openSessionSetup()}
                  />
                  <ModeButton
                    title={busy === 'exit' ? 'Returning…' : 'Back to native app'}
                    hint="Leave Dogfood and restore the installed app"
                    disabled={busy !== null}
                    onPress={() => void backToNative()}
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.titleRow}>
                  <Text style={styles.title}>{usageMode === 'reload-only' ? 'Reload' : 'Dogfood'}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dogfood settings"
                    onPress={() => setShowControlSettings(true)}
                    style={styles.settingsButton}
                  >
                    <Text style={styles.settingsText}>Settings</Text>
                  </Pressable>
                </View>
                <View style={styles.actions}>
                  <Pressable
                    testID="yaver-dogfood-fast-reload"
                    accessibilityRole="button"
                    disabled={busy !== null}
                    onPress={() => void fastReload()}
                    style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                  >
                    <Text style={styles.actionTitle}>{busy === 'reload' ? 'Reloading…' : 'Fast Reload'}</Text>
                    <Text style={styles.actionHint}>Refresh the selected render target</Text>
                  </Pressable>
                  {usageMode === 'reload-and-chat' ? <Pressable
                    testID="yaver-dogfood-chat"
                    accessibilityRole="button"
                    disabled={busy !== null}
                    onPress={() => void openChat()}
                    style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                  >
                    <Text style={styles.actionTitle}>{busy === 'chat' ? 'Opening…' : 'Chat'}</Text>
                    <Text style={styles.actionHint}>Open the current Yaver vibing session</Text>
                  </Pressable> : null}
                </View>
              </>
            )}
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {agentUpdateRequired ? (
              <ModeButton
                title={busy === 'update' ? 'Updating…' : 'Update Yaver agent'}
                hint="Update the selected render box, reconnect, then retry Reload"
                disabled={busy !== null}
                onPress={() => void updateAgent()}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

const ModeButton: React.FC<{
  title: string;
  hint: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}> = ({ title, hint, selected, disabled, onPress }) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.modeAction, selected && styles.modeSelected, pressed && styles.actionPressed]}
  >
    {typeof selected === 'boolean' ? <View style={[styles.radio, selected && styles.radioSelected]} /> : null}
    <View style={styles.modeCopy}>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={styles.actionHint}>{hint}</Text>
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  layer: { zIndex: 9997 },
  fallbackPosition: { position: 'absolute', left: 0, top: 0 },
  fallback: {
    width: FALLBACK_SIZE,
    height: FALLBACK_SIZE,
    borderRadius: FALLBACK_SIZE / 2,
    backgroundColor: '#f97316',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    overflow: 'hidden',
  },
  fallbackText: { position: 'absolute', top: 7, color: '#111827', fontSize: 17, lineHeight: 20, fontWeight: '800' },
  rightDockText: { left: 6 },
  leftDockText: { right: 6 },
  pressed: { opacity: 0.78 },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: 'rgba(2,6,23,0.28)',
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    padding: 16,
    backgroundColor: '#111827',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#f9fafb', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  explanation: { color: '#cbd5e1', fontSize: 13, lineHeight: 19, marginBottom: 14 },
  supported: { color: '#9ca3af', fontSize: 12, lineHeight: 17, marginBottom: 14 },
  settingsButton: { paddingVertical: 5, paddingHorizontal: 8, marginTop: -6 },
  settingsText: { color: '#fdba74', fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10 },
  stackedActions: { gap: 9 },
  action: {
    flex: 1,
    minHeight: 92,
    borderRadius: 14,
    padding: 12,
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#4b5563',
  },
  modeAction: {
    minHeight: 62,
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#4b5563',
  },
  modeSelected: { borderColor: '#f97316', backgroundColor: '#292524' },
  radio: { width: 15, height: 15, borderRadius: 8, borderWidth: 1.5, borderColor: '#64748b', marginRight: 11 },
  radioSelected: { borderWidth: 4, borderColor: '#f97316', backgroundColor: '#111827' },
  modeCopy: { flex: 1, gap: 3 },
  actionPressed: { backgroundColor: '#374151' },
  actionTitle: { color: '#f9fafb', fontSize: 15, fontWeight: '700' },
  actionHint: { color: '#9ca3af', fontSize: 11, lineHeight: 15 },
  message: { color: '#fdba74', fontSize: 12, lineHeight: 17, marginTop: 12 },
});
