import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";

type CardDef = {
  key: string;
  label: string;
  subtitle: string;
  icon: string;
  route: string;
  primary?: boolean;
};

const CARDS: CardDef[] = [
  { key: "chat", label: "Chat", subtitle: "Run and watch tasks", icon: "💬", route: "/tasks", primary: true },
  { key: "projects", label: "Projects", subtitle: "Repositories on device", icon: "📁", route: "/projects" },
  { key: "devices", label: "Devices", subtitle: "Switch machine", icon: "🖥️", route: "/devices" },
  { key: "settings", label: "Settings", subtitle: "Profile, relays, API keys", icon: "⚙️", route: "/settings" },
];

function DeviceBar() {
  const c = useColors();
  const { activeDevice, connectionStatus, devices } = useDevice();
  const statusColor =
    connectionStatus === "connected" ? c.success
    : connectionStatus === "connecting" ? c.warn
    : c.textMuted;
  return (
    <Pressable
      onPress={() => router.push("/devices")}
      style={({ focused }) => [styles.deviceBar, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]}
    >
      <View style={[styles.onlineDot, { backgroundColor: statusColor }]} />
      <Text style={[styles.deviceBarText, { color: c.textPrimary }]}>
        {activeDevice ? activeDevice.name : "No device selected"}
      </Text>
      <Text style={[styles.deviceBarStatus, { color: statusColor }]}>
        {connectionStatus}
      </Text>
      {devices.length > 1 && <Text style={[styles.deviceBarHint, { color: c.textMuted }]}>· switch</Text>}
    </Pressable>
  );
}

export default function TvHomeScreen() {
  const c = useColors();
  const { user } = useAuth();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.logoBlock}>
            <Text style={[styles.logo, { color: c.textPrimary }]}>
              yaver<Text style={{ color: c.accent }}>.io</Text>
            </Text>
            <Text style={[styles.greeting, { color: c.textSecondary }]}>
              {user?.name ? `Hi ${user.name.split(" ")[0]}` : "Your AI, everywhere"}
            </Text>
          </View>
          <DeviceBar />
        </View>

        <View style={styles.grid}>
          {CARDS.map((card) => (
            <Pressable
              key={card.key}
              hasTVPreferredFocus={card.primary === true}
              onPress={() => router.push(card.route)}
              style={({ focused }) => [
                styles.card,
                { backgroundColor: c.bgCard, borderColor: focused ? c.accent : c.border },
                focused && styles.focused,
              ]}
            >
              <Text style={styles.cardIcon}>{card.icon}</Text>
              <Text style={[styles.cardTitle, { color: c.textPrimary }]}>{card.label}</Text>
              <Text style={[styles.cardSubtitle, { color: c.textSecondary }]}>{card.subtitle}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.footer, { color: c.textMuted }]}>
          Sign in to Yaver on your phone to manage devices from anywhere
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1, padding: 64, paddingTop: 48 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 48,
  },
  logoBlock: {},
  logo: { fontSize: 44, fontWeight: "800", letterSpacing: -2 },
  greeting: { fontSize: 22, marginTop: 4 },
  deviceBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  onlineDot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  deviceBarText: { fontSize: 22, fontWeight: "600" },
  deviceBarStatus: { fontSize: 18, marginLeft: 12, textTransform: "capitalize" },
  deviceBarHint: { fontSize: 16, marginLeft: 6 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 24,
    marginBottom: 40,
  },
  card: {
    width: 210,
    height: 150,
    borderRadius: 18,
    borderWidth: 2,
    padding: 18,
    justifyContent: "center",
  },
  cardIcon: { fontSize: 32, marginBottom: 10 },
  cardTitle: { fontSize: 26, fontWeight: "700" },
  cardSubtitle: { fontSize: 15, marginTop: 4 },
  focused: { transform: [{ scale: 1.06 }], opacity: 0.92 },
  footer: { textAlign: "center", fontSize: 16 },
});
