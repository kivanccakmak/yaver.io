import { router } from "expo-router";
import React, { useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useDogfoodOverlay } from "../src/context/DogfoodOverlayContext";
import { useColors } from "../src/context/ThemeContext";
import { useRouteParamsCompat } from "../src/lib/useRouteParamsCompat";
import type { DogfoodLane } from "../../sdk/feedback/react-native/src/DogfoodRuntime";

export default function DogfoodLaunchScreen() {
  const c = useColors();
  const { begin } = useDogfoodOverlay();
  const startedRef = useRef(false);
  const params = useRouteParamsCompat<{
    workDir?: string;
    runner?: string;
    deviceId?: string;
    deviceName?: string;
    lane?: string;
    fallbackLane?: string;
    usageMode?: string;
    startBehavior?: string;
    renderBehavior?: string;
    sessionBehavior?: string;
  }>();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const lane: DogfoodLane = params.lane === "webrtc" || params.lane === "hermes" ? params.lane : "browser";
    const fallbackLane: DogfoodLane | undefined = params.fallbackLane === "browser" || params.fallbackLane === "webrtc" || params.fallbackLane === "hermes"
      ? params.fallbackLane
      : undefined;
    begin({
      workDir: String(params.workDir || ""),
      runner: String(params.runner || "codex"),
      deviceId: String(params.deviceId || ""),
      deviceName: String(params.deviceName || "the primary device"),
      lane,
      fallbackLane,
      usageMode: params.usageMode === "chat-only" || params.usageMode === "reload-and-chat" ? params.usageMode : "reload-only",
      startBehavior: params.startBehavior === "render-on-open" ? "render-on-open" : "vibe-first",
      renderBehavior: params.renderBehavior === "auto-on-request" ? "auto-on-request" : "manual",
      sessionBehavior: params.sessionBehavior === "new-session" ? "new-session" : "resume-last",
    });
    router.replace("/(tabs)/tasks" as any);
  }, [begin, params]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={styles.card}>
        <ActivityIndicator color={c.accent} />
        <Text style={[styles.text, { color: c.textMuted }]}>Preparing Dogfood in the background…</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: { alignItems: "center", gap: 12 },
  text: { fontSize: 13, fontWeight: "600" },
});
