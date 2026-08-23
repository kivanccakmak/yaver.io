/**
 * Owner-only Dogfood mode.
 *
 * The installed native app remains the control plane. Dogfood renders Yaver's
 * own Expo/RN-web target from the account's primary device, inside native
 * chrome that always retains the Production escape. Authorization comes from
 * the backend-computed isOwner flag; no email address is embedded in the app.
 */

import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { AppScreenHeader } from "../../src/components/AppScreenHeader";
import AttachModeSection from "../../src/components/AttachModeSection";
import { useAuth } from "../../src/context/AuthContext";
import { useColors } from "../../src/context/ThemeContext";
import { useTabletContentStyle } from "../../src/hooks/useTabletContentStyle";

export default function DogfoodScreen() {
  const router = useRouter();
  const c = useColors();
  const tabletContent = useTabletContentStyle("regular");
  const { user } = useAuth();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <AppScreenHeader title="Dogfood mode" onBack={() => router.navigate("/(tabs)/more" as any)} />
      <ScrollView contentContainerStyle={[{ padding: 16, paddingBottom: 40 }, tabletContent]}>
        {user?.isOwner === true ? (
          <AttachModeSection c={c} primaryOnly />
        ) : (
          <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16 }}>
            <Text style={{ color: c.textPrimary, fontSize: 16, fontWeight: "700" }}>Owner access only</Text>
            <Text style={{ color: c.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
              Dogfood mode is available only to the Yaver owner account.
            </Text>
            <Pressable onPress={() => router.replace("/(tabs)/more" as any)} style={{ marginTop: 14 }}>
              <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>Back to More</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
