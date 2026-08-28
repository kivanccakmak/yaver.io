import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { YaverFeedback, type DogfoodControlTriggerState } from './YaverFeedback';

const FALLBACK_SIZE = 34;
const EMPTY_STATE: DogfoodControlTriggerState = {
  configured: false,
  authorized: false,
  gestureSupported: false,
  gestureEnabled: false,
  fallbackVisible: false,
  reason: 'not-configured',
};

/**
 * Zero-chrome Dogfood entry surface.
 *
 * Supported native targets render nothing until the passive three-finger hold
 * fires. Unsupported/accessibility-conflicted targets render only a minimized,
 * draggable Y. Both open this same two-action card; neither opens the legacy
 * full feedback action grid.
 */
export const DogfoodQuickControls: React.FC = () => {
  const { width, height } = Dimensions.get('window');
  const start = { x: Math.max(width - FALLBACK_SIZE - 8, 0), y: Math.max(Math.floor(height * 0.42), 70) };
  const pan = useRef(new Animated.ValueXY(start)).current;
  const lastPosition = useRef(start);
  const dragStart = useRef(start);
  const dragged = useRef(false);
  const [state, setState] = useState<DogfoodControlTriggerState>(EMPTY_STATE);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'reload' | 'chat' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await YaverFeedback.syncDogfoodControlGesture());
    } catch {
      setState(EMPTY_STATE);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const trigger = DeviceEventEmitter.addListener('yaverDogfoodControlGesture', () => {
      setMessage(null);
      setOpen(true);
    });
    const capability = DeviceEventEmitter.addListener('yaverDogfoodControlCapability', () => {
      void refresh();
    });
    return () => {
      trigger.remove();
      capability.remove();
    };
  }, [refresh]);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => {
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
      const next = {
        x: Math.max(0, Math.min(width - FALLBACK_SIZE, dragStart.current.x + gesture.dx)),
        y: Math.max(0, Math.min(height - FALLBACK_SIZE, dragStart.current.y + gesture.dy)),
      };
      lastPosition.current = next;
      Animated.spring(pan, { toValue: next, useNativeDriver: false, friction: 7 }).start();
    },
  })).current;

  const fastReload = useCallback(async () => {
    if (busy) return;
    setBusy('reload');
    setMessage(null);
    try {
      const ack = await YaverFeedback.requestDogfoodFastReload();
      setMessage(ack || 'Fast Reload requested.');
      setTimeout(() => setOpen(false), 650);
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

  if (!state.configured || !state.authorized) return null;

  return (
    <>
      {state.fallbackVisible ? (
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.layer]}>
          <Animated.View
            {...panResponder.panHandlers}
            style={[styles.fallbackPosition, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
          >
            <Pressable
              testID="yaver-dogfood-minimized-control"
              accessibilityRole="button"
              accessibilityLabel="Open Dogfood controls"
              hitSlop={8}
              onPress={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setMessage(null);
                setOpen(true);
              }}
              style={({ pressed }) => [styles.fallback, pressed && styles.pressed]}
            >
              <Text style={styles.fallbackText}>y</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.title}>Dogfood</Text>
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
              <Pressable
                testID="yaver-dogfood-chat"
                accessibilityRole="button"
                disabled={busy !== null}
                onPress={() => void openChat()}
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
              >
                <Text style={styles.actionTitle}>{busy === 'chat' ? 'Opening…' : 'Chat'}</Text>
                <Text style={styles.actionHint}>Open the current Yaver vibing session</Text>
              </Pressable>
            </View>
            {message ? <Text style={styles.message}>{message}</Text> : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  layer: { zIndex: 9997 },
  fallbackPosition: { position: 'absolute', left: 0, top: 0 },
  fallback: {
    width: FALLBACK_SIZE,
    height: FALLBACK_SIZE,
    borderRadius: FALLBACK_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f97316',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  fallbackText: { color: '#111827', fontSize: 17, lineHeight: 20, fontWeight: '800' },
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
  title: { color: '#f9fafb', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  actions: { flexDirection: 'row', gap: 10 },
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
  actionPressed: { backgroundColor: '#374151' },
  actionTitle: { color: '#f9fafb', fontSize: 15, fontWeight: '700' },
  actionHint: { color: '#9ca3af', fontSize: 11, lineHeight: 15 },
  message: { color: '#fdba74', fontSize: 12, lineHeight: 17, marginTop: 12 },
});
