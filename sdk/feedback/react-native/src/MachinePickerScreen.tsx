import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  RefreshControl,
} from 'react-native';
import {
  DeviceList,
  DeviceReachability,
  RemoteDevice,
  listReachableDevices,
  probeDeviceReachability,
  saveSelectedDeviceId,
} from './auth';
import { PairDeviceModal } from './PairDeviceModal';

export interface YaverMachinePickerProps {
  token: string;
  /** Currently-selected deviceId (from config / cache) — highlighted. */
  currentDeviceId?: string;
  onPick: (device: RemoteDevice) => void | Promise<void>;
  onCancel?: () => void;
  /** Optional flow-specific title, e.g. "Choose a machine for SFMG". */
  title?: string;
}

/**
 * List of remote dev machines owned by the signed-in user.
 *
 * Tapping a device persists it to AsyncStorage and invokes `onPick`. The
 * SDK then uses that device's deviceId for agent discovery (LAN probe +
 * relay fallback through Convex).
 */
export const YaverMachinePickerScreen: React.FC<YaverMachinePickerProps> = ({
  token,
  currentDeviceId,
  onPick,
  onCancel,
  title = 'Choose a machine',
}) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<DeviceList>({ owned: [] });
  const [pairingDevice, setPairingDevice] = useState<RemoteDevice | null>(null);
  const [reachability, setReachability] = useState<Record<string, DeviceReachability | undefined>>({});
  const [selectingDeviceId, setSelectingDeviceId] = useState<string | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    const generation = ++loadGenerationRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await listReachableDevices(token);
      setList(result);
      setReachability({});
      // Convex already gives us a fresh, heartbeat-gated online answer. Render
      // that immediately. Only probe cloud-offline rows to detect a phone-LAN
      // route that came back before the next heartbeat, and publish each result
      // as it arrives instead of holding the whole list behind the slowest box.
      for (const device of result.owned.filter((candidate) => !candidate.isOnline)) {
        void probeDeviceReachability(device).then((probe) => {
          if (!mountedRef.current || loadGenerationRef.current !== generation) return;
          setReachability((prev) => ({ ...prev, [device.deviceId]: probe }));
        }).catch(() => {});
      }
      if (result.owned.length === 0) {
        setError('No machines found yet. Run `yaver auth` + `yaver serve` on your machine.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; };
  }, [load]);

  const handlePick = async (device: RemoteDevice) => {
    // Needs-auth device — show the in-SDK pair modal instead of
    // treating the tap as a "pick". The user enters the 6-char code
    // from their Mac terminal; the SDK POSTs it to /auth/pair/submit
    // on the agent directly. Once the device flips out of bootstrap
    // mode, the next load() picks up the fresh state.
    if (device.isOnline && device.needsAuth) {
      setPairingDevice(device);
      return;
    }
    const direct = device.isOnline
      ? { reachable: true } as DeviceReachability
      : await probeDeviceReachability(device);
    // Do not hard-block selection just because the LAN /health probe
    // failed. The standalone SDK can still reach a healthy machine via
    // the normal selected-device discovery path (including relay), and
    // the Yaver host path may already be proving the machine works.
    // Only treat the machine as unpickable when BOTH:
    //   1. Convex says it is offline, and
    //   2. the direct probe also failed.
    if (!device.isOnline && !direct.reachable && !device.needsAuth) {
      setError('Selected machine is not responding. Start `yaver serve` on it and try again.');
      setReachability((prev) => ({ ...prev, [device.deviceId]: direct }));
      return;
    }
    setSelectingDeviceId(device.deviceId);
    try {
      await saveSelectedDeviceId(device.deviceId);
      await onPick(device);
    } finally {
      if (mountedRef.current) setSelectingDeviceId(null);
    }
  };

  const renderDevice = (device: RemoteDevice) => {
    const selected = device.deviceId === currentDeviceId;
    const selecting = device.deviceId === selectingDeviceId;
    const probe = reachability[device.deviceId];
    // Trust Convex's `isOnline` — the backend already gates it on a
    // fresh 90 s heartbeat (see backend/convex/devices.ts
    // deriveIsOnline). Re-checking on the client produced false
    // yellows from phone↔backend clock skew around the 89-90 s mark.
    //
    // `runnerDown` intentionally does NOT flip the dot. That flag
    // tracks whether the AI runner (claude-code / codex / opencode)
    // is healthy — a separate concern from "can I reach this machine?"
    // Mobile app surfaces runner issues via a separate badge, not
    // this dot. Picker's job is reachability, nothing more.
    const effectivelyReachable = probe?.reachable === true;
    const explicitlyOffline = probe?.reachable === false;
    const healthColor = device.needsAuth
      ? '#f59e0b'
      : effectivelyReachable
        ? '#22c55e'
        : device.isOnline
          ? '#22c55e'
          : explicitlyOffline || !device.isOnline
          ? '#ef4444'
          : '#22c55e';
    // Derive a single short status phrase the user can act on.
    let statusLine = device.platform;
    if (selecting) {
      statusLine = 'Connecting…';
    } else if (probe === undefined && device.isOnline) {
      statusLine = device.platform || 'Online';
    } else if (!device.isOnline && effectivelyReachable) {
      statusLine = 'Reachable now — waiting for cloud status to refresh';
    } else if (!device.isOnline) {
      statusLine = 'Offline — start `yaver serve` on the machine';
    } else if (device.needsAuth) {
      statusLine =
        'Needs pairing — open the Yaver app to adopt this machine';
    } else if (explicitlyOffline) {
      statusLine = 'Online, but direct probe failed — relay / selected-machine path may still work';
    } else {
      // Happy-path subtitle.
      statusLine = device.platform;
    }
    return (
      <TouchableOpacity
        key={device.deviceId}
        style={[styles.deviceRow, selected && styles.deviceSelected]}
        onPress={() => handlePick(device)}
        disabled={selectingDeviceId !== null}
      >
        <View style={[styles.health, { backgroundColor: healthColor }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.deviceName}>{device.name || device.deviceId}</Text>
          <Text style={styles.deviceMeta}>{statusLine}</Text>
        </View>
        {selecting ? <ActivityIndicator color="#a5b4fc" size="small" /> : null}
        {selected && !selecting && <Text style={styles.selectedBadge}>selected</Text>}
      </TouchableOpacity>
    );
  };

  const availableDevices = list.owned
    .filter((device) => device.isOnline || reachability[device.deviceId]?.reachable === true)
    .sort((left, right) => Number(right.deviceId === currentDeviceId) - Number(left.deviceId === currentDeviceId));
  const unavailableDevices = list.owned.filter(
    (device) => !device.isOnline && reachability[device.deviceId]?.reachable !== true,
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {onCancel && (
          <TouchableOpacity onPress={onCancel} style={styles.cancel}>
            <Text style={styles.cancelText}>Close</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(true);
            }}
            tintColor="#6366f1"
          />
        }
      >
        {loading ? (
          <ActivityIndicator color="#6366f1" style={{ marginTop: 60 }} />
        ) : (
          <>
            {availableDevices.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Available now</Text>
                {availableDevices.map(renderDevice)}
              </View>
            )}
            {availableDevices.length === 0 && list.owned.length > 0 ? (
              <Text style={styles.emptyHint}>No online development machines right now.</Text>
            ) : null}
            {unavailableDevices.length > 0 ? (
              <View style={styles.section}>
                <TouchableOpacity
                  style={styles.unavailableToggle}
                  onPress={() => setShowUnavailable((current) => !current)}
                >
                  <Text style={styles.unavailableToggleText}>
                    {showUnavailable ? 'Hide' : 'Show'} unavailable machines ({unavailableDevices.length})
                  </Text>
                </TouchableOpacity>
                {showUnavailable ? unavailableDevices.map(renderDevice) : null}
              </View>
            ) : null}
            {error && <Text style={styles.error}>{error}</Text>}
          </>
        )}
      </ScrollView>

      <PairDeviceModal
        device={pairingDevice}
        onClose={() => setPairingDevice(null)}
        onPaired={() => {
          // Give the agent a moment to flip bootstrap → owner mode,
          // then reload the list so the now-authenticated device shows
          // up with a green dot and can be selected normally.
          setTimeout(() => void load(true), 1500);
        }}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  title: { color: '#e0e0e0', fontSize: 20, fontWeight: '700' },
  cancel: { padding: 8 },
  cancelText: { color: '#9ca3af', fontSize: 14 },
  content: { padding: 20, paddingTop: 0 },
  section: { marginBottom: 24 },
  sectionTitle: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  deviceSelected: {
    borderColor: 'rgba(99,102,241,0.5)',
    backgroundColor: 'rgba(99,102,241,0.15)',
  },
  health: { width: 10, height: 10, borderRadius: 5 },
  deviceName: { color: '#e0e0e0', fontSize: 15, fontWeight: '600' },
  deviceMeta: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  selectedBadge: {
    color: '#a5b4fc',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  unavailableToggle: {
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  unavailableToggleText: { color: '#a5b4fc', fontSize: 13, fontWeight: '700' },
  emptyHint: { color: '#9ca3af', fontSize: 13, lineHeight: 19, marginBottom: 16 },
  error: { color: '#ef4444', fontSize: 13, marginTop: 16, textAlign: 'center' },
});
