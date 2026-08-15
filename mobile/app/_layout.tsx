import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { LogBox, Platform } from "react-native";
import { AuthProvider } from "../src/context/AuthContext";
import { DeviceProvider } from "../src/context/DeviceContext";
import { CloudStudioProvider } from "../src/context/CloudStudioContext";
import { ThemeProvider, useTheme } from "../src/context/ThemeContext";

if ((Platform as any).isTV === true) {
  LogBox.ignoreLogs(["Persistent storage is not supported on tvOS"]);
}

function InnerLayout() {
  const { isDark, colors } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "fade",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DeviceProvider>
          <CloudStudioProvider>
            <InnerLayout />
          </CloudStudioProvider>
        </DeviceProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
