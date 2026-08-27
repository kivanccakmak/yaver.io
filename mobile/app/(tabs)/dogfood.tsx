/**
 * Contributor Dogfood mode.
 *
 * The installed native app remains the control plane. Any signed-in user can
 * render a verified Yaver source checkout from their own primary device. The
 * attached page receives a narrow, short-lived capability; normal bearer auth
 * still protects the box; the canonical main branch is protected by the agent.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { AppScreenHeader } from "../../src/components/AppScreenHeader";
import AttachModeSection from "../../src/components/AttachModeSection";
import { useColors } from "../../src/context/ThemeContext";
import { useTabletContentStyle } from "../../src/hooks/useTabletContentStyle";
import { useAuth } from "../../src/context/AuthContext";
import {
  listDogfoodApps,
  listDogfoodInstallations,
  registerThisDogfoodControlDevice,
  saveDogfoodApp,
  setDogfoodInstallationAction,
  type DogfoodAppRow,
  type DogfoodInstallationRow,
} from "../../src/lib/dogfoodRegistry";

export default function DogfoodScreen() {
  const router = useRouter();
  const c = useColors();
  const tabletContent = useTabletContentStyle("regular");
  const { token } = useAuth();
  const [apps, setApps] = useState<DogfoodAppRow[]>([]);
  const [installations, setInstallations] = useState<DogfoodInstallationRow[]>([]);
  const [appId, setAppId] = useState("");
  const [appLabel, setAppLabel] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [deviceStatus, setDeviceStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    const [nextApps, nextInstallations] = await Promise.all([
      listDogfoodApps(token), listDogfoodInstallations(token),
    ]);
    setApps(nextApps);
    setInstallations(nextInstallations);
  }, [token]);

  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);

  const registerDevice = async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const result = await registerThisDogfoodControlDevice(token);
      setDeviceStatus(`Registered · generation ${result.generation}${result.assurance === "browser-dev" ? " · browser test identity" : ""}`);
    } catch (error) {
      Alert.alert("Couldn't register this device", error instanceof Error ? error.message : "Try again.");
    } finally { setBusy(false); }
  };

  const createApp = async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      await saveDogfoodApp(token, { appId: appId.trim(), label: appLabel.trim(), projectSlug: projectSlug.trim() || undefined, allowedScopes: ["feedback", "blackbox"], enabled: true });
      setAppId(""); setAppLabel(""); setProjectSlug("");
      await refresh();
    } catch (error) {
      Alert.alert("Couldn't enable Dogfood", error instanceof Error ? error.message : "Try again.");
    } finally { setBusy(false); }
  };

  const act = async (row: DogfoodInstallationRow, action: "approve" | "cancel" | "revoke") => {
    if (!token || busy) return;
    setBusy(true);
    try { await setDogfoodInstallationAction(token, row._id, action); await refresh(); }
    catch (error) { Alert.alert("Dogfood device wasn't updated", error instanceof Error ? error.message : "Try again."); }
    finally { setBusy(false); }
  };

  const card = { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 14 } as const;
  const input = { color: c.textPrimary, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 } as const;
  const button = { alignSelf: "flex-start" as const, backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginTop: 12 };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <AppScreenHeader title="Develop Yaver" onBack={() => router.navigate("/(tabs)/more" as any)} />
      <ScrollView contentContainerStyle={[{ padding: 16, paddingBottom: 40 }, tabletContent]}>
        <View style={card}>
          <Text style={{ color: c.textPrimary, fontSize: 17, fontWeight: "700" }}>This device</Text>
          <Text style={{ color: c.textSecondary, marginTop: 6, lineHeight: 19 }}>
            Register this Yaver installation as an approval device. Its private key stays in this device's secure storage; only the public key reaches Yaver.
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Register this device for Dogfood apps" style={button} onPress={() => void registerDevice()} disabled={busy}>
            <Text style={{ color: "white", fontWeight: "700" }}>{busy ? "Working…" : "Register this device"}</Text>
          </Pressable>
          {deviceStatus ? <Text style={{ color: c.textSecondary, marginTop: 9 }}>{deviceStatus}</Text> : null}
        </View>

        <View style={card}>
          <Text style={{ color: c.textPrimary, fontSize: 17, fontWeight: "700" }}>Third-party Dogfood apps</Text>
          <Text style={{ color: c.textSecondary, marginTop: 6, lineHeight: 19 }}>
            Enable an app that has no OAuth or backend yet. Feedback and BlackBox are the safe defaults; reload/build access is never granted implicitly.
          </Text>
          <TextInput accessibilityLabel="Dogfood app id" value={appId} onChangeText={setAppId} placeholder="App ID, e.g. io.example.app" placeholderTextColor={c.textMuted} autoCapitalize="none" style={input} />
          <TextInput accessibilityLabel="Dogfood app label" value={appLabel} onChangeText={setAppLabel} placeholder="App name" placeholderTextColor={c.textMuted} style={input} />
          <TextInput accessibilityLabel="Dogfood project slug" value={projectSlug} onChangeText={setProjectSlug} placeholder="Project slug (optional)" placeholderTextColor={c.textMuted} autoCapitalize="none" style={input} />
          <Pressable accessibilityRole="button" accessibilityLabel="Enable Dogfood app" style={button} onPress={() => void createApp()} disabled={busy || !appId.trim() || !appLabel.trim()}>
            <Text style={{ color: "white", fontWeight: "700" }}>Enable app</Text>
          </Pressable>
          {apps.map((app) => <View key={app._id} style={{ borderTopColor: c.border, borderTopWidth: 1, marginTop: 14, paddingTop: 12 }}>
            <Text style={{ color: c.textPrimary, fontWeight: "700" }}>{app.label}</Text>
            <Text style={{ color: c.textSecondary, marginTop: 3 }}>{app.appId} · {app.allowedScopes.join(", ")}</Text>
          </View>)}
        </View>

        {installations.length ? <View style={card}>
          <Text style={{ color: c.textPrimary, fontSize: 17, fontWeight: "700" }}>App installations</Text>
          {installations.map((row) => <View key={row._id} style={{ borderTopColor: c.border, borderTopWidth: 1, marginTop: 12, paddingTop: 12 }}>
            <Text style={{ color: c.textPrimary, fontWeight: "600" }}>{row.label || row.platform} · {row.appId}</Text>
            <Text style={{ color: c.textSecondary, marginTop: 3 }}>{row.status}{row.proofVerifiedAt ? " · key verified" : " · awaiting key proof"}</Text>
            {row.status === "pending" && row.proofVerifiedAt ? <Pressable accessibilityRole="button" accessibilityLabel={`Approve ${row.label || row.platform}`} style={button} onPress={() => void act(row, "approve")}><Text style={{ color: "white", fontWeight: "700" }}>Approve</Text></Pressable> : null}
            {row.status === "pending" ? <Pressable accessibilityRole="button" accessibilityLabel={`Cancel ${row.label || row.platform}`} onPress={() => void act(row, "cancel")} style={{ paddingVertical: 10 }}><Text style={{ color: c.error }}>Cancel enrollment</Text></Pressable> : null}
            {row.status === "active" ? <Pressable accessibilityRole="button" accessibilityLabel={`Revoke ${row.label || row.platform}`} onPress={() => void act(row, "revoke")} style={{ paddingVertical: 10 }}><Text style={{ color: c.error }}>Revoke</Text></Pressable> : null}
          </View>)}
        </View> : null}
        <AttachModeSection c={c} />
      </ScrollView>
    </View>
  );
}
