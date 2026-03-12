import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { AuthProvider } from "../src/context/AuthContext";
import { DeviceProvider } from "../src/context/DeviceContext";

export default function RootLayout() {
  return (
    <AuthProvider>
      <DeviceProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "#0a0a0a" },
            animation: "fade",
          }}
        />
      </DeviceProvider>
    </AuthProvider>
  );
}
