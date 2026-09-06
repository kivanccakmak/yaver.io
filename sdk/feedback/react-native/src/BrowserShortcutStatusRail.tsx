import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { BrowserShortcutSnapshot, BrowserShortcutStep } from './BrowserShortcut';

export interface BrowserShortcutStatusColors {
  border: string;
  text: string;
  muted: string;
  accent: string;
  ready: string;
  blocked: string;
  background: string;
}

const DEFAULT_COLORS: BrowserShortcutStatusColors = {
  border: '#334155', text: '#f8fafc', muted: '#94a3b8', accent: '#818cf8',
  ready: '#22c55e', blocked: '#ef4444', background: '#111827',
};

const STEPS: Array<{ key: BrowserShortcutStep; label: string }> = [
  { key: 'connection', label: 'Connection' },
  { key: 'build', label: 'Build' },
  { key: 'publish', label: 'Publish' },
  { key: 'verify', label: 'Verify' },
];

function stepIndex(step?: BrowserShortcutStep): number {
  return Math.max(0, STEPS.findIndex((item) => item.key === step));
}

/**
 * Shared, operation-driven progress UI. The animation only acknowledges a
 * real controller transition; it never advances phases on a timer.
 */
export const BrowserShortcutStatusRail: React.FC<{
  snapshot: BrowserShortcutSnapshot;
  colors?: Partial<BrowserShortcutStatusColors>;
}> = ({ snapshot, colors: overrides }) => {
  const colors = useMemo(() => ({ ...DEFAULT_COLORS, ...overrides }), [overrides]);
  const pulse = useRef(new Animated.Value(0)).current;
  const current = stepIndex(snapshot.activeStep);

  useEffect(() => {
    pulse.setValue(0);
    Animated.spring(pulse, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }).start();
  }, [pulse, snapshot.phase, snapshot.activeStep]);

  return (
    <View accessibilityLabel="Browser shortcut export progress" style={[styles.card, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <View style={styles.steps}>
        {STEPS.map((step, index) => {
          const complete = snapshot.phase === 'ready' || index < current;
          const failed = index === current && (snapshot.phase === 'failed' || snapshot.phase === 'blocked');
          const active = index === current && !complete && !failed && snapshot.phase !== 'idle';
          const tone = failed ? colors.blocked : complete ? colors.ready : active ? colors.accent : colors.muted;
          return (
            <View key={step.key} style={styles.step}>
              <Animated.View style={[
                styles.dot,
                { backgroundColor: tone },
                active ? { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }], opacity: pulse } : null,
              ]} />
              <Text style={[styles.label, { color: tone }]}>{step.label}</Text>
              {index < STEPS.length - 1 ? <View style={[styles.line, { backgroundColor: complete ? colors.ready : colors.border }]} /> : null}
            </View>
          );
        })}
      </View>
      <Text style={[styles.message, { color: colors.text }]}>{snapshot.message}</Text>
      {snapshot.remedy ? <Text style={[styles.remedy, { color: colors.muted }]}>{snapshot.remedy}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 9 },
  steps: { flexDirection: 'row', alignItems: 'flex-start' },
  step: { flex: 1, alignItems: 'center', position: 'relative' },
  dot: { width: 10, height: 10, borderRadius: 5, zIndex: 1 },
  line: { position: 'absolute', height: 2, left: '55%', right: '-45%', top: 4 },
  label: { fontSize: 10, fontWeight: '700', marginTop: 5 },
  message: { fontSize: 12, lineHeight: 17, fontWeight: '600' },
  remedy: { fontSize: 11, lineHeight: 16 },
});
