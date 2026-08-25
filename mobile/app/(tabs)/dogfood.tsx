/**
 * Contributor Dogfood mode.
 *
 * The installed native app remains the control plane. Any signed-in user can
 * render a verified Yaver source checkout from their own primary device. The
 * attached page receives a narrow, short-lived capability; normal bearer auth
 * still protects the box; the canonical main branch is protected by the agent.
 */

import React from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { AppScreenHeader } from "../../src/components/AppScreenHeader";
import AttachModeSection from "../../src/components/AttachModeSection";
import { useColors } from "../../src/context/ThemeContext";
import { useTabletContentStyle } from "../../src/hooks/useTabletContentStyle";

export default function DogfoodScreen() {
  const router = useRouter();
  const c = useColors();
  const tabletContent = useTabletContentStyle("regular");

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <AppScreenHeader title="Develop Yaver" onBack={() => router.navigate("/(tabs)/more" as any)} />
      <ScrollView contentContainerStyle={[{ padding: 16, paddingBottom: 40 }, tabletContent]}>
        <AttachModeSection c={c} primaryOnly />
      </ScrollView>
    </View>
  );
}
