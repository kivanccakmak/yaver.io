import React, { useCallback, useEffect, useState } from 'react';
import { Alert, DeviceEventEmitter, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { YaverFeedback } from './YaverFeedback';
import type {
  DogfoodAccessSnapshot,
  DogfoodUsageMode,
} from './dogfoodPolicy';
import { resolveReportIdentity, type VibeThreadSummary } from './P2PClient';
import type { DogfoodRuntimeSelection } from './preferences';

export interface DogfoodSettingsProps {
  /** Optional app-native escape. In a Yaver guest this returns to the installed
   * host; in a standalone app it normally navigates out of developer settings. */
  onBackToNative?: () => void | Promise<void>;
  /** Keep Exit Dogfood visible by default. */
  showExit?: boolean;
  /** Custom hosts may navigate to their own session screen instead of using
   * the SDK FeedbackModal event consumer. */
  onOpenSession?: (session: VibeThreadSummary) => void | Promise<void>;
}

/**
 * Embeddable SDK settings for SFMG and other third-party apps.
 *
 * This is deliberately separate from DogfoodUsage: settings owns OAuth,
 * machine/runner/checkout/lane setup and the UI-mode choice; usage owns the
 * tiny reload/chat control shown over the app. Both modes require the same
 * full Yaver OAuth account and approved installation.
 */
export const DogfoodSettings: React.FC<DogfoodSettingsProps> = ({
  onBackToNative,
  showExit = true,
}) => {
  const [access, setAccess] = useState<DogfoodAccessSnapshot | null>(null);
  const [mode, setMode] = useState<DogfoodUsageMode>('reload-and-chat');
  const [runtime, setRuntime] = useState<DogfoodRuntimeSelection | null>(null);
  const [entryIconVisible, setEntryIconVisible] = useState(true);
  const [busy, setBusy] = useState<'refresh' | 'mode' | 'setup' | 'exit' | 'signout' | null>('refresh');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy((current) => current || 'refresh');
    try {
      const next = await YaverFeedback.getDogfoodAccess();
      setAccess(next);
      if (next.authorized) {
        const [usage, runtimeSelection, iconHidden] = await Promise.all([
          YaverFeedback.getDogfoodUsageMode(),
          YaverFeedback.getDogfoodRuntimeSelection(),
          YaverFeedback.isDogfoodEntryIconHidden(),
        ]);
        setMode(usage);
        setRuntime(runtimeSelection);
        setEntryIconVisible(!iconHidden);
      } else {
        setRuntime(null);
      }
      setMessage(null);
    } catch (error) {
      setAccess(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const auth = DeviceEventEmitter.addListener('yaverFeedback:authChanged', () => void refresh());
    const dogfood = DeviceEventEmitter.addListener('yaverFeedback:dogfoodChanged', () => void refresh());
    const usage = DeviceEventEmitter.addListener('yaverFeedback:dogfoodUsageModeChanged', (payload) => {
      if (payload?.mode === 'chat-only' || payload?.mode === 'reload-only' || payload?.mode === 'reload-and-chat') setMode(payload.mode);
    });
    return () => { auth.remove(); dogfood.remove(); usage.remove(); };
  }, [refresh]);

  const selectMode = async (next: DogfoodUsageMode) => {
    if (busy) return;
    setBusy('mode');
    setMessage(null);
    try {
      setMode(await YaverFeedback.setDogfoodUsageMode(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openSetup = async () => {
    if (busy) return;
    setBusy('setup');
    setMessage(null);
    try {
      const result = await YaverFeedback.openDogfood();
      if (result.phase === 'denied' || result.phase === 'error') {
        setMessage(result.error || 'Dogfood setup is not available for this Yaver account.');
      }
    } finally {
      setBusy(null);
    }
  };

  const exit = async () => {
    if (busy) return;
    setBusy('exit');
    try {
      await YaverFeedback.exitDogfoodMode();
      await onBackToNative?.();
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    if (busy) return;
    setBusy('signout');
    setMessage(null);
    try {
      await YaverFeedback.signOut();
      await onBackToNative?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const confirmSignOut = () => {
    if (busy) return;
    Alert.alert('Sign out of Yaver?', 'Chat and Reload will require Yaver sign-in again on this app.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); } },
    ]);
  };

  const authenticated = access?.yaverAuthenticated === true;
  const authorized = access?.authorized === true;
  const routing = YaverFeedback.getMachineRouting();
  const config = YaverFeedback.getConfig();
  const identity = resolveReportIdentity({
    projectName: config?.projectName,
    bundleId: config?.bundleId,
    appVersion: config?.appVersion,
    buildNumber: config?.buildNumber,
    runtimeMode: authorized ? 'dogfood' : 'native',
  });
  const versionLabel = identity.app.version
    ? `v${identity.app.version}${identity.app.buildNumber ? ` (${identity.app.buildNumber})` : ''}`
    : 'Version unavailable';

  return (
    <View style={styles.root}>
      <View style={styles.titleRow} accessibilityRole="header" accessibilityLabel="Dogfood Settings">
        <Text style={styles.titleIcon} accessible={false}>{'🧪'}</Text>
        <Text style={styles.title}>Dogfood Settings</Text>
      </View>
      <View style={styles.identity} accessibilityLabel={`${versionLabel}, ${authorized ? 'Dogfood' : 'Native'} mode`}>
        <Text style={styles.identityVersion}>{versionLabel}</Text>
        <Text style={styles.identityMode}>{authorized ? 'Dogfood mode' : 'Native mode'}</Text>
      </View>
      <Text style={styles.copy}>
        {authenticated
          ? authorized
            ? 'Yaver OAuth and this app installation are approved.'
            : 'Signed in to Yaver. Approve this installation before using Dogfood.'
          : 'Sign in with Yaver OAuth inside this app to use either Dogfood mode.'}
      </Text>

      <Text style={styles.section}>Dogfood UI</Text>
      <View style={styles.iconSetting}>
        <View style={styles.iconSettingCopy}>
          <Text style={styles.choiceTitle}>Show Y over the app</Text>
          <Text style={styles.choiceDetail}>On by default. Y opens this native Dogfood menu without covering the app.</Text>
        </View>
        <Switch
          accessibilityLabel="Show Y over the app"
          value={entryIconVisible}
          disabled={!authorized || busy !== null}
          onValueChange={(visible) => {
            setEntryIconVisible(visible);
            void YaverFeedback.setDogfoodEntryIconVisible(visible).catch((error) => {
              setEntryIconVisible(!visible);
              setMessage(error instanceof Error ? error.message : String(error));
            });
          }}
        />
      </View>
      <View style={styles.options}>
        <Choice
          title="Chat Only"
          detail="Keep the in-app conversation available from the native Dogfood menu."
          selected={mode === 'chat-only'}
          disabled={!authorized || busy !== null}
          onPress={() => void selectMode('chat-only')}
        />
        <Choice
          title="Reload Only"
          detail="Vibe in Tasks or an agent, then reload from the native Dogfood menu."
          selected={mode === 'reload-only'}
          disabled={!authorized || busy !== null}
          onPress={() => void selectMode('reload-only')}
        />
        <Choice
          title="Reload + Chat"
          detail="Keep both actions in the native Dogfood menu, never over the running app."
          selected={mode === 'reload-and-chat'}
          disabled={!authorized || busy !== null}
          onPress={() => void selectMode('reload-and-chat')}
        />
      </View>

      <Text style={styles.section}>Dogfood runtime</Text>
      <View style={styles.summary}>
        <Text style={styles.summaryLine}>Render box · {routing.renderDeviceId || 'Choose in setup'}</Text>
        <Text style={styles.summaryLine}>Coding box · {routing.codingDeviceId || 'Choose in setup'}</Text>
        <Text style={styles.summaryLine}>Checkout · {runtime?.projectPath || runtime?.projectName || config?.dogfood?.projectName || config?.projectName || 'Choose in setup'}</Text>
        <Text style={styles.summaryLine}>Lane · {runtime?.lane || 'Choose Browser, Hermes, or WebRTC in setup'}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Configure Dogfood machine runner checkout and lane"
        disabled={busy !== null}
        onPress={() => void openSetup()}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>{authenticated ? 'Configure box, runner, checkout & lane' : 'Sign in to Yaver'}</Text>
      </Pressable>

      {showExit && authorized ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit Dogfood and return to native app"
          disabled={busy !== null}
          onPress={() => void exit()}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>Back to native app</Text>
        </Pressable>
      ) : null}
      {authenticated ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out of Yaver"
          disabled={busy !== null}
          onPress={confirmSignOut}
          style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
        >
          <Text style={styles.signOutText}>{busy === 'signout' ? 'Signing out…' : 'Sign out of Yaver'}</Text>
        </Pressable>
      ) : null}
      {message ? <Text style={styles.error}>{message}</Text> : null}
    </View>
  );
};

const Choice: React.FC<{
  title: string;
  detail: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}> = ({ title, detail, selected, disabled, onPress }) => (
  <Pressable
    accessibilityRole="radio"
    accessibilityState={{ selected, disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, disabled && styles.disabled, pressed && styles.pressed]}
  >
    <View style={[styles.radio, selected && styles.radioSelected]} />
    <View style={styles.choiceCopy}>
      <Text style={styles.choiceTitle}>{title}</Text>
      <Text style={styles.choiceDetail}>{detail}</Text>
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  root: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#d4d4dc', borderRadius: 16, padding: 16, backgroundColor: '#fff' },
  identity: { marginTop: 10, marginBottom: 4, padding: 10, borderRadius: 10, backgroundColor: '#f4f4f8', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  identityVersion: { color: '#24242b', fontSize: 12, fontWeight: '700' },
  identityMode: { color: '#6d4aff', fontSize: 11, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleIcon: { fontSize: 18, lineHeight: 22 },
  title: { color: '#17171c', fontSize: 18, fontWeight: '800' },
  copy: { color: '#666674', fontSize: 13, lineHeight: 18, marginTop: 5 },
  section: { color: '#34343d', fontSize: 12, fontWeight: '800', marginTop: 18, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.6 },
  options: { gap: 8 },
  iconSetting: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#dedee6', borderRadius: 12, padding: 12, marginBottom: 8 },
  iconSettingCopy: { flex: 1 },
  choice: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderColor: '#dedee6', borderRadius: 12, padding: 12 },
  choiceSelected: { borderColor: '#6b5ce7', backgroundColor: '#f4f2ff' },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: '#9292a0', marginTop: 2 },
  radioSelected: { borderWidth: 5, borderColor: '#6b5ce7' },
  choiceCopy: { flex: 1, marginLeft: 10 },
  choiceTitle: { color: '#24242b', fontSize: 14, fontWeight: '700' },
  choiceDetail: { color: '#71717e', fontSize: 12, lineHeight: 17, marginTop: 2 },
  summary: { borderRadius: 12, backgroundColor: '#f6f6f8', padding: 12, gap: 5 },
  summaryLine: { color: '#5e5e69', fontSize: 12 },
  primary: { marginTop: 10, borderRadius: 11, backgroundColor: '#5b4bd8', paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  secondary: { marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: '#d4d4dc', paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  secondaryText: { color: '#4e4e59', fontSize: 13, fontWeight: '700' },
  signOut: { marginTop: 8, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  signOutText: { color: '#b42318', fontSize: 13, fontWeight: '700' },
  error: { color: '#b42318', fontSize: 12, lineHeight: 17, marginTop: 10 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
});
