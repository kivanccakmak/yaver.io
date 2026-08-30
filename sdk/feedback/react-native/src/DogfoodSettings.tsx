import React, { useCallback, useEffect, useState } from 'react';
import { Alert, DeviceEventEmitter, Pressable, StyleSheet, Text, View } from 'react-native';
import { YaverFeedback } from './YaverFeedback';
import type {
  DogfoodAccessSnapshot,
  DogfoodRenderBehavior,
  DogfoodSessionBehavior,
  DogfoodStartBehavior,
  DogfoodUsageMode,
} from './dogfoodPolicy';
import type { VibeThreadSummary } from './P2PClient';
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
  onOpenSession,
}) => {
  const [access, setAccess] = useState<DogfoodAccessSnapshot | null>(null);
  const [mode, setMode] = useState<DogfoodUsageMode>('reload-and-chat');
  const [runtime, setRuntime] = useState<DogfoodRuntimeSelection | null>(null);
  const [startBehavior, setStartBehavior] = useState<DogfoodStartBehavior>('vibe-first');
  const [renderBehavior, setRenderBehavior] = useState<DogfoodRenderBehavior>('manual');
  const [sessionBehavior, setSessionBehavior] = useState<DogfoodSessionBehavior>('resume-last');
  const [sessions, setSessions] = useState<VibeThreadSummary[]>([]);
  const [busy, setBusy] = useState<'refresh' | 'mode' | 'setup' | 'exit' | null>('refresh');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy((current) => current || 'refresh');
    try {
      const next = await YaverFeedback.getDogfoodAccess();
      setAccess(next);
      if (next.authorized) {
        const [usage, runtimeSelection, start, render, session, roster] = await Promise.all([
          YaverFeedback.getDogfoodUsageMode(),
          YaverFeedback.getDogfoodRuntimeSelection(),
          YaverFeedback.getDogfoodStartBehavior(),
          YaverFeedback.getDogfoodRenderBehavior(),
          YaverFeedback.getDogfoodSessionBehavior(),
          YaverFeedback.getDogfoodSessions().catch(() => []),
        ]);
        setMode(usage);
        setRuntime(runtimeSelection);
        setStartBehavior(start);
        setRenderBehavior(render);
        setSessionBehavior(session);
        setSessions(roster);
      } else {
        setRuntime(null);
        setSessions([]);
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
      if (payload?.mode === 'reload-only' || payload?.mode === 'reload-and-chat') setMode(payload.mode);
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

  const selectExperience = async (
    kind: 'start' | 'render' | 'session',
    value: DogfoodStartBehavior | DogfoodRenderBehavior | DogfoodSessionBehavior,
  ) => {
    if (busy) return;
    setBusy('mode');
    setMessage(null);
    try {
      if (kind === 'start') setStartBehavior(await YaverFeedback.setDogfoodStartBehavior(value as DogfoodStartBehavior));
      if (kind === 'render') setRenderBehavior(await YaverFeedback.setDogfoodRenderBehavior(value as DogfoodRenderBehavior));
      if (kind === 'session') setSessionBehavior(await YaverFeedback.setDogfoodSessionBehavior(value as DogfoodSessionBehavior));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(null); }
  };

  const openSession = async (session: VibeThreadSummary) => {
    try {
      if (onOpenSession) await onOpenSession(session);
      else await YaverFeedback.openDogfoodSession(session.id);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const completeSession = async (id: string) => {
    try { await YaverFeedback.completeDogfoodSession(id); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const deleteSession = (session: VibeThreadSummary) => {
    Alert.alert('Delete Dogfood session?', 'This explicitly closes its runner seat and removes the conversation. Disconnecting alone never does this.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        void YaverFeedback.deleteDogfoodSession(session.id).then(refresh).catch((error) => {
          setMessage(error instanceof Error ? error.message : String(error));
        });
      } },
    ]);
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

  const authenticated = access?.yaverAuthenticated === true;
  const authorized = access?.authorized === true;
  const routing = YaverFeedback.getMachineRouting();
  const config = YaverFeedback.getConfig();

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Dogfood settings</Text>
      <Text style={styles.copy}>
        {authenticated
          ? authorized
            ? 'Yaver OAuth and this app installation are approved.'
            : 'Signed in to Yaver. Approve this installation before using Dogfood.'
          : 'Sign in with Yaver OAuth inside this app to use either Dogfood mode.'}
      </Text>

      <Text style={styles.section}>Dogfood UI</Text>
      <View style={styles.options}>
        <Choice
          title="Reload Only"
          detail="No SDK chat. Vibe in Yaver Tasks, Claude Code, Codex, or another MCP client."
          selected={mode === 'reload-only'}
          disabled={!authorized || busy !== null}
          onPress={() => void selectMode('reload-only')}
        />
        <Choice
          title="Reload + Chat"
          detail="Keep reload and the in-app Yaver Dogfood conversation."
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

      <Text style={styles.section}>Start & render</Text>
      <View style={styles.options}>
        <Choice title="Vibe first" detail="Open chat and durable sessions without starting a renderer." selected={startBehavior === 'vibe-first'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('start', 'vibe-first')} />
        <Choice title="Render when opened" detail="Start the selected lane immediately after entering Dogfood." selected={startBehavior === 'render-on-open'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('start', 'render-on-open')} />
        <Choice title="Tap Render updates" detail="Default. A UI-ready signal becomes an explicit action." selected={renderBehavior === 'manual'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('render', 'manual')} />
        <Choice title="Auto-render requested updates" detail="Opt in to one render after the runner explicitly says UI changes are ready." selected={renderBehavior === 'auto-on-request'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('render', 'auto-on-request')} />
      </View>

      <Text style={styles.section}>Runner sessions</Text>
      <View style={styles.options}>
        <Choice title="Resume newest session" detail="Reconnect Chat to the newest durable runner/tmux-backed topic." selected={sessionBehavior === 'resume-last'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('session', 'resume-last')} />
        <Choice title="Start with a new session" detail="Open a clean composer. Existing sessions remain available below." selected={sessionBehavior === 'new-session'} disabled={!authorized || busy !== null} onPress={() => void selectExperience('session', 'new-session')} />
      </View>
      {sessions.map((session) => (
        <View key={session.id} style={styles.sessionCard}>
          <View style={styles.sessionCopy}>
            <Text style={styles.sessionTitle} numberOfLines={1}>{session.title || 'Dogfood session'}</Text>
            <Text style={styles.sessionMeta} numberOfLines={2}>
              {[session.status, session.runnerId, session.model, session.deviceName, session.tmuxSession ? `tmux ${session.tmuxSession}` : session.resumable ? 'resumable' : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {mode === 'reload-and-chat' ? <Pressable onPress={() => void openSession(session)} style={styles.sessionAction}><Text style={styles.sessionActionText}>Open</Text></Pressable> : null}
          {session.status !== 'completed' ? <Pressable onPress={() => void completeSession(session.id)} style={styles.sessionAction}><Text style={styles.sessionActionText}>Complete</Text></Pressable> : null}
          <Pressable onPress={() => deleteSession(session)} style={styles.sessionAction}><Text style={styles.deleteText}>Delete</Text></Pressable>
        </View>
      ))}
      {authorized && sessions.length === 0 ? <Text style={styles.empty}>No Dogfood sessions yet. Starting Chat creates one without rendering.</Text> : null}

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
  title: { color: '#17171c', fontSize: 18, fontWeight: '800' },
  copy: { color: '#666674', fontSize: 13, lineHeight: 18, marginTop: 5 },
  section: { color: '#34343d', fontSize: 12, fontWeight: '800', marginTop: 18, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.6 },
  options: { gap: 8 },
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
  error: { color: '#b42318', fontSize: 12, lineHeight: 17, marginTop: 10 },
  sessionCard: { marginTop: 8, borderWidth: 1, borderColor: '#dedee6', borderRadius: 12, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  sessionCopy: { flex: 1, minWidth: 0 },
  sessionTitle: { color: '#24242b', fontSize: 12, fontWeight: '700' },
  sessionMeta: { color: '#71717e', fontSize: 10, lineHeight: 14, marginTop: 2 },
  sessionAction: { paddingHorizontal: 6, paddingVertical: 6 },
  sessionActionText: { color: '#5b4bd8', fontSize: 10, fontWeight: '700' },
  deleteText: { color: '#b42318', fontSize: 10, fontWeight: '700' },
  empty: { color: '#71717e', fontSize: 11, lineHeight: 16, marginTop: 8 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
});
