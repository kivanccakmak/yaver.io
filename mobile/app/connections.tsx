// app/connections.tsx — People. This is an address book only; connections do
// not grant machine, project, runner, terminal, or support access.

import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "../src/context/ThemeContext";
import type { ThemeColors } from "../src/constants/colors";
import { AppBackButton } from "../src/components/AppBackButton";
import {
  listConnections,
  requestConnection,
  acceptConnection,
  removeConnection,
  suggestedConnections,
  type ConnectionsResponse,
  type SuggestedConnection,
} from "../src/lib/connections";

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/network request failed|failed to fetch|load failed/i.test(msg)) {
    return "Couldn't reach the server. Check your connection.";
  }
  return msg;
}

export default function ConnectionsScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const s = makeStyles(c);

  const [conns, setConns] = useState<ConnectionsResponse>({ accepted: [], incoming: [], outgoing: [], blocked: [] });
  const [suggested, setSuggested] = useState<SuggestedConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  // people input
  const [target, setTarget] = useState("");

  const flash = (m: { type: "ok" | "error"; text: string }) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  };

  const refresh = useCallback(async () => {
    try {
      const [cn, sg] = await Promise.all([
        listConnections(),
        suggestedConnections().catch(() => []),
      ]);
      setConns(cn);
      setSuggested(sg);
    } catch (e) {
      flash({ type: "error", text: friendlyError(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  async function act(fn: () => Promise<void>, okText: string) {
    setBusy(true);
    try { await fn(); flash({ type: "ok", text: okText }); await refresh(); }
    catch (e) { flash({ type: "error", text: friendlyError(e) }); }
    finally { setBusy(false); }
  }

  async function sendConnect() {
    const q = target.trim();
    if (!q) return;
    await act(async () => {
      const isEmail = q.includes("@");
      const res = await requestConnection(isEmail ? { peerEmail: q, source: "manual" } : { peerUserId: q, source: "manual" });
      flash({ type: "ok", text: res.status === "accepted" ? "Connected!" : "Request sent." });
      setTarget("");
    }, "Done.");
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <AppBackButton onPress={() => router.back()} />
        <Text style={[s.title, { color: c.textPrimary }]}>People</Text>
        <View style={{ width: 36 }} />
      </View>

      {msg && (
        <View style={[s.banner, { backgroundColor: msg.type === "ok" ? c.successBg : c.errorBg }]}>
          <Text style={{ color: msg.type === "ok" ? c.success : c.error, fontSize: 12 }}>{msg.text}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>
        {loading ? (
          <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            <Text style={[s.label, { color: c.textMuted }]}>Add by email or user id</Text>
            <View style={s.row}>
              <TextInput
                value={target}
                onChangeText={setTarget}
                placeholder="friend@example.com"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                style={[s.input, { backgroundColor: c.bgInput, color: c.textPrimary, borderColor: c.border }]}
              />
              <Pressable onPress={sendConnect} disabled={busy || !target.trim()} style={[s.primaryBtn, { backgroundColor: c.accent, opacity: busy || !target.trim() ? 0.4 : 1 }]}>
                <Text style={[s.primaryBtnText, { color: c.textInverse }]}>Connect</Text>
              </Pressable>
            </View>

            {conns.incoming.length > 0 && (
              <Section title={`Requests (${conns.incoming.length})`} c={c} s={s}>
                {conns.incoming.map((p) => (
                  <View key={p.peerUserId} style={[s.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.name, { color: c.textPrimary }]}>{p.fullName}</Text>
                      <Text style={[s.sub, { color: c.textMuted }]}>{p.email}</Text>
                    </View>
                    <Pressable onPress={() => act(() => acceptConnection(p.peerUserId), "Connected!")} disabled={busy} style={[s.pill, { backgroundColor: c.successBg }]}>
                      <Text style={{ color: c.success, fontSize: 12, fontWeight: "600" }}>Accept</Text>
                    </Pressable>
                    <Pressable onPress={() => act(() => removeConnection(p.peerUserId), "Declined.")} disabled={busy} style={[s.pill, { backgroundColor: c.neutralBg }]}>
                      <Text style={{ color: c.textMuted, fontSize: 12 }}>Decline</Text>
                    </Pressable>
                  </View>
                ))}
              </Section>
            )}

            <Section title={`Connections (${conns.accepted.length})`} c={c} s={s} empty={conns.accepted.length === 0 ? "No connections yet." : undefined}>
              {conns.accepted.map((p) => (
                <View key={p.peerUserId} style={[s.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.name, { color: c.textPrimary }]}>{p.nickname || p.fullName}</Text>
                    <Text style={[s.sub, { color: c.textMuted }]}>{p.email}</Text>
                  </View>
                  <Pressable onPress={() => act(() => removeConnection(p.peerUserId), "Removed.")} disabled={busy} style={[s.pill, { backgroundColor: c.neutralBg }]}>
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </Section>

            {conns.outgoing.length > 0 && (
              <Section title={`Pending (${conns.outgoing.length})`} c={c} s={s}>
                {conns.outgoing.map((p) => (
                  <View key={p.peerUserId} style={[s.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.name, { color: c.textPrimary }]}>{p.fullName}</Text>
                      <Text style={[s.sub, { color: c.textMuted }]}>Request sent</Text>
                    </View>
                    <Pressable onPress={() => act(() => removeConnection(p.peerUserId), "Cancelled.")} disabled={busy} style={[s.pill, { backgroundColor: c.neutralBg }]}>
                      <Text style={{ color: c.textMuted, fontSize: 12 }}>Cancel</Text>
                    </Pressable>
                  </View>
                ))}
              </Section>
            )}

            {suggested.length > 0 && (
              <Section title="Suggested" c={c} s={s}>
                {suggested.map((p) => (
                  <View key={p.userId} style={[s.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.name, { color: c.textPrimary }]}>{p.fullName}</Text>
                      <Text style={[s.sub, { color: c.textMuted }]}>{p.email} · via {p.source}</Text>
                    </View>
                    <Pressable onPress={() => act(() => requestConnection({ peerUserId: p.userId, source: "suggested" }).then(() => {}), "Request sent.")} disabled={busy} style={[s.pill, { backgroundColor: c.accentSoft }]}>
                      <Text style={{ color: c.accent, fontSize: 12, fontWeight: "600" }}>Connect</Text>
                    </Pressable>
                  </View>
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Section({ title, children, c, s, empty }: { title: string; children?: React.ReactNode; c: ThemeColors; s: any; empty?: string }) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={[s.sectionLabel, { color: c.textMuted }]}>{title}</Text>
      {empty ? <Text style={[s.sub, { color: c.textMuted }]}>{empty}</Text> : children}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingBottom: 8 },
    title: { fontSize: 17, fontWeight: "700" },
    segment: { flexDirection: "row", marginHorizontal: 16, marginBottom: 8, backgroundColor: c.bgInput, borderRadius: 10, padding: 3 },
    segBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
    banner: { marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
    label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
    sectionLabel: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
    primaryBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
    primaryBtnText: { fontSize: 14, fontWeight: "600" },
    pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginLeft: 6 },
    card: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
    createCard: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 4 },
    choice: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
    codePill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
    memberRow: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, paddingTop: 10, marginTop: 10 },
    name: { fontSize: 14, fontWeight: "600" },
    sub: { fontSize: 11, marginTop: 2 },
  });
}
