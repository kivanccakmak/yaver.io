import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ThemeColors } from '../constants/colors';
import {
  BrowserShortcutController,
  type BrowserShortcutSnapshot,
} from '../../../sdk/feedback/react-native/src/BrowserShortcut';
import { BrowserShortcutStatusRail } from '../../../sdk/feedback/react-native/src/BrowserShortcutStatusRail';
import {
  approveBrowserShortcutEnrollment,
  browserShortcutDriverFor,
  installBrowserShortcutTool,
  listBrowserShortcutEnrollments,
  type BrowserShortcutEnrollment,
} from '../lib/browserShortcutClient';

export interface BrowserShortcutProject {
  name: string;
  path: string;
  framework?: string;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function browserShortcutAppIdForProject(project: BrowserShortcutProject): string {
  const slug = String(project.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';
  return `io.yaver.shortcut.${slug}.${stableHash(project.path)}`;
}

export default function BrowserShortcutExportModal({
  visible,
  onClose,
  deviceId,
  connected,
  project,
  c,
}: {
  visible: boolean;
  onClose: () => void;
  deviceId?: string;
  connected: boolean;
  project: BrowserShortcutProject | null;
  c: ThemeColors;
}) {
  const controller = useRef(new BrowserShortcutController());
  const [customOrigin, setCustomOrigin] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installLine, setInstallLine] = useState('');
  const [enrollments, setEnrollments] = useState<BrowserShortcutEnrollment[]>([]);
  const [approvingCode, setApprovingCode] = useState('');
  const [snapshot, setSnapshot] = useState<BrowserShortcutSnapshot>({
    phase: 'idle', progress: 0, message: 'Ready to check this project on its machine.',
  });
  const appId = useMemo(() => project ? browserShortcutAppIdForProject(project) : '', [project]);
  const originKey = deviceId && appId ? `@yaver/browser-shortcut-origin/${deviceId}/${appId}` : '';
  const busy = installing || ['checking', 'building', 'publishing', 'verifying'].includes(snapshot.phase);

  useEffect(() => {
    controller.current.cancel();
    setSnapshot({ phase: 'idle', progress: 0, message: 'Ready to check this project on its machine.' });
    setInstallLine('');
    setEnrollments([]);
    setApprovingCode('');
    setInstalling(false);
    setCustomOrigin('');
    if (!visible || !originKey) return;
    let cancelled = false;
    void AsyncStorage.getItem(originKey).then((saved) => { if (!cancelled) setCustomOrigin(saved || ''); }).catch(() => {});
    return () => { cancelled = true; controller.current.cancel(); };
  }, [originKey, visible]);

  useEffect(() => {
    if (!visible || !deviceId || !connected || snapshot.phase !== 'ready' || snapshot.release?.mode !== 'remote-runtime') {
      setEnrollments([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const next = await listBrowserShortcutEnrollments(deviceId, appId);
      if (!cancelled) setEnrollments(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [appId, connected, deviceId, snapshot.phase, snapshot.release?.mode, visible]);

  const shown = useMemo<BrowserShortcutSnapshot>(() => {
    if (snapshot.phase !== 'idle' || connected) return snapshot;
    return {
      phase: 'blocked', activeStep: 'connection', progress: 0,
      code: 'BROWSER_SHORTCUT_BOX_OFFLINE', message: 'This project’s machine is not connected.',
      remedy: 'Reconnect or wake it. Yaver will not start a build while it is offline.',
    };
  }, [connected, snapshot]);

  const start = async () => {
    if (!deviceId || !project || !connected || busy) return;
    const driver = browserShortcutDriverFor(deviceId);
    if (!driver) {
      setSnapshot({
        phase: 'blocked', activeStep: 'connection', progress: 0,
        code: 'BROWSER_SHORTCUT_BOX_OFFLINE', message: 'The project’s machine disconnected.',
        remedy: 'Reconnect it, then retry. No build was started.',
      });
      return;
    }
    const origin = customOrigin.trim();
    await controller.current.run(driver, {
      appId,
      projectPath: project.path,
      ...(origin ? { publicOrigin: origin } : {}),
      brand: { displayName: project.name, shortName: project.name.slice(0, 24), themeColor: '#6C5CE7', backgroundColor: '#FFFFFF' },
      mode: 'auto',
      buildMode: 'full',
    }, setSnapshot);
  };

  const approve = async (code: string) => {
    if (!deviceId || approvingCode) return;
    setApprovingCode(code);
    const result = await approveBrowserShortcutEnrollment(deviceId, appId, code);
    setApprovingCode('');
    if (result.ok) {
      setEnrollments((current) => current.filter((item) => item.code !== code));
    } else {
      setSnapshot((current) => ({
        ...current,
        phase: 'failed',
        code: 'BROWSER_SHORTCUT_APPROVAL_FAILED',
        message: result.error || 'Could not approve this shortcut connection.',
        remedy: 'Keep the shortcut open, reconnect the machine, and retry approval.',
      }));
    }
  };

  const installFlutter = async () => {
    if (!deviceId || installing) return;
    setInstalling(true);
    setInstallLine('Starting Flutter installation…');
    const result = await installBrowserShortcutTool(deviceId, 'flutter', (line) => setInstallLine(line));
    setInstalling(false);
    if (result.ok) {
      setSnapshot({ phase: 'idle', progress: 0, message: 'Flutter installed. Retry the project export.' });
    } else {
      setSnapshot({ phase: 'failed', activeStep: 'build', progress: 1, code: 'FLUTTER_INSTALL_FAILED', message: result.error || 'Flutter installation failed.', remedy: 'Review the streamed installer output, then retry.' });
    }
  };

  if (!project) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.42)', justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close browser shortcut export" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgCard, padding: 18, paddingBottom: 30 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accentSoft }}>
              <Ionicons name="phone-portrait-outline" size={22} color={c.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.textPrimary, fontSize: 17, fontWeight: '800' }}>Export browser shortcut</Text>
              <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 2 }} numberOfLines={2}>{project.name} · {project.framework || 'detecting framework'}</Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close browser shortcut export" style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color={c.textMuted} />
            </Pressable>
          </View>

          <TextInput
            value={customOrigin}
            onChangeText={(value) => {
              setCustomOrigin(value);
              if (originKey) void AsyncStorage.setItem(originKey, value.trim()).catch(() => {});
            }}
            editable={!busy}
            accessibilityLabel="Custom browser shortcut HTTPS origin"
            placeholder="Automatic isolated Yaver URL"
            placeholderTextColor={c.textMuted}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ color: c.textPrimary, borderColor: c.border, backgroundColor: c.bg, borderWidth: 1, borderRadius: 10, padding: 11, fontSize: 12, opacity: busy ? 0.6 : 1 }}
          />
          <Text style={{ color: c.textMuted, fontSize: 10, lineHeight: 15 }}>
            Blank uses a stable per-app HTTPS hostname through the connected Yaver relay. IP addresses and auth tokens are never installed in the shortcut.
          </Text>

          {['swift', 'kotlin'].includes(String(project.framework || '').toLowerCase()) ? (
            <View style={{ borderRadius: 11, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, padding: 11, gap: 4 }}>
              <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: '700' }}>Native app stays native</Text>
              <Text style={{ color: c.textMuted, fontSize: 10, lineHeight: 15 }}>
                The Home Screen icon opens a full-screen viewer. Yaver builds and launches the Swift app in an iOS Simulator or the Kotlin app in an Android emulator, then carries only pixels and touch input over WebRTC.
              </Text>
            </View>
          ) : null}

          <BrowserShortcutStatusRail snapshot={shown} colors={{ background: c.bg, border: c.border, text: c.textPrimary, muted: c.textMuted, accent: c.accent, ready: c.success, blocked: c.error }} />
          {installLine ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              {installing ? <ActivityIndicator size="small" color={c.accent} /> : null}
              <Text style={{ flex: 1, color: c.textMuted, fontSize: 10, lineHeight: 15 }} numberOfLines={3}>{installLine}</Text>
            </View>
          ) : null}


          {enrollments.map((enrollment) => (
            <View key={enrollment.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 11, borderWidth: 1, borderColor: c.accent, backgroundColor: c.accentSoft, padding: 11 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.textPrimary, fontSize: 11, fontWeight: '800' }}>Connect shortcut {enrollment.code}</Text>
                <Text style={{ color: c.textMuted, fontSize: 9, marginTop: 2 }}>Only this project and its simulator/emulator will be accessible.</Text>
              </View>
              <Pressable
                disabled={Boolean(approvingCode)}
                onPress={() => void approve(enrollment.code)}
                accessibilityRole="button"
                accessibilityLabel={`Approve browser shortcut ${enrollment.code}`}
                style={({ pressed }) => ({ borderRadius: 9, backgroundColor: c.accent, paddingHorizontal: 13, paddingVertical: 9, opacity: approvingCode ? 0.5 : pressed ? 0.75 : 1 })}
              >
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{approvingCode === enrollment.code ? 'Approving…' : 'Approve'}</Text>
              </Pressable>
            </View>
          ))}

          {snapshot.phase === 'ready' && snapshot.release ? (
            <Pressable onPress={() => void Linking.openURL(snapshot.release!.installUrl)} style={({ pressed }) => ({ borderRadius: 11, backgroundColor: c.accent, paddingVertical: 13, alignItems: 'center', opacity: pressed ? 0.75 : 1 })}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>Open and add to Home Screen</Text>
            </Pressable>
          ) : snapshot.code === 'FLUTTER_NOT_INSTALLED' ? (
            <Pressable disabled={installing} onPress={() => void installFlutter()} style={({ pressed }) => ({ borderRadius: 11, backgroundColor: c.accent, paddingVertical: 13, alignItems: 'center', opacity: installing ? 0.5 : pressed ? 0.75 : 1 })}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>{installing ? 'Installing Flutter…' : 'Install Flutter'}</Text>
            </Pressable>
          ) : busy ? (
            <Pressable onPress={() => { controller.current.cancel(); setSnapshot({ phase: 'idle', progress: 0, message: 'Export cancelled.' }); }} style={{ borderRadius: 11, borderWidth: 1, borderColor: c.error, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: c.error, fontWeight: '700' }}>Cancel export</Text>
            </Pressable>
          ) : (
            <Pressable disabled={!connected} onPress={() => void start()} accessibilityState={{ disabled: !connected }} style={({ pressed }) => ({ borderRadius: 11, backgroundColor: c.accent, paddingVertical: 13, alignItems: 'center', opacity: !connected ? 0.45 : pressed ? 0.75 : 1 })}>
              <Text style={{ color: '#fff', fontWeight: '800' }}>Build and export</Text>
            </Pressable>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
