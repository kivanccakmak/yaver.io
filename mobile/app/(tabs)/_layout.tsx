import { Tabs } from "expo-router";
import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "../../src/context/ThemeContext";

const isTV = (Platform as any).isTV === true;

const TV_SECTIONS: Record<string, string> = {
  home: "Home",
  tasks: "Chat",
  projects: "Projects",
  devices: "Devices",
  settings: "Settings",
};

/** TV top navigation bar — no bottom tabs on Apple TV. */
function TvTabBar({ state, navigation }: any) {
  const c = useColors();
  const visible = state.routes.filter((r: any) => TV_SECTIONS[r.name]);
  return (
    <View style={[styles.tvBar, { backgroundColor: c.bg, borderBottomColor: c.border }]}>
      <View style={styles.tvBarInner}>
        {visible.map((route: any) => {
          const isFocused = state.index === state.routes.indexOf(route);
          const label = TV_SECTIONS[route.name] ?? route.name;
          return (
            <Pressable
              key={route.key}
              onPress={() => navigation.navigate(route.name)}
              style={({ focused }) => [
                styles.tvItem,
                { borderColor: isFocused ? c.accent : "transparent" },
                focused && styles.tvItemFocused,
              ]}
            >
              <Text style={[styles.tvItemText, { color: isFocused ? c.textPrimary : c.textSecondary }]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const c = useColors();
  const icons: Record<string, string> = {
    Tasks: "T",
    Todos: "☐",
    Devices: "D",
    Settings: "S",
  };
  return (
    <Text style={[styles.icon, { color: focused ? c.tabActive : c.tabInactive }]}>
      {icons[label] ?? "?"}
    </Text>
  );
}

export default function TabLayout() {
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: !isTV,
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.textPrimary,
        headerTitleStyle: { fontWeight: "700" },
        tabBarStyle: {
          backgroundColor: c.bgTabBar,
          borderTopColor: c.border,
          borderTopWidth: 1,
          ...(isTV ? { display: "none" as const } : {}),
        },
        tabBarActiveTintColor: c.tabActive,
        tabBarInactiveTintColor: c.tabInactive,
        sceneStyle: isTV ? { paddingTop: 64 } : undefined,
        ...(isTV ? { tabBar: (props: any) => <TvTabBar {...props} /> } : {}),
      }}
    >
      <Tabs.Screen
        name="home"
        options={{ title: "Home", href: null }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: "Tasks",
          tabBarIcon: ({ focused }) => <TabIcon label="Tasks" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="todos"
        options={{
          title: "Todos",
          tabBarIcon: ({ focused }) => <TabIcon label="Todos" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{ title: "Projects", href: null }}
      />
      <Tabs.Screen
        name="devices"
        options={{
          title: "Devices",
          tabBarIcon: ({ focused }) => <TabIcon label="Devices" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => <TabIcon label="Settings" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: {
    fontSize: 18,
    fontWeight: "700",
  },
  tvBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 64,
    zIndex: 100,
    borderBottomWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 48,
  },
  tvBarInner: {
    flexDirection: "row",
    gap: 16,
  },
  tvItem: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  tvItemFocused: {
    transform: [{ scale: 1.05 }],
    opacity: 0.9,
  },
  tvItemText: {
    fontSize: 22,
    fontWeight: "600",
  },
});
