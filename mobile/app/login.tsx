import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import React, { useEffect } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/context/AuthContext";
import { getOAuthUrl } from "../src/lib/auth";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const { login } = useAuth();

  // Listen for deep link callback
  useEffect(() => {
    const subscription = Linking.addEventListener("url", async (event) => {
      const url = event.url;
      if (!url.startsWith("yaver://oauth-callback")) return;

      const parsed = Linking.parse(url);
      const token = parsed.queryParams?.token as string | undefined;
      if (token) {
        try {
          await login(token);
          router.replace("/(tabs)/tasks");
        } catch {
          // Token validation failed — stay on login screen.
        }
      }
    });

    return () => subscription.remove();
  }, [login]);

  const handleOAuth = async (provider: "google" | "microsoft") => {
    const url = getOAuthUrl(provider);
    await WebBrowser.openBrowserAsync(url, {
      showInRecents: true,
    });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>Yaver</Text>
          <Text style={styles.subtitle}>
            Your AI coding assistant, everywhere.
          </Text>
        </View>

        {/* Sign-in buttons */}
        <View style={styles.buttons}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.googleButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => handleOAuth("google")}
          >
            <Text style={styles.buttonIcon}>G</Text>
            <Text style={styles.buttonText}>Sign in with Google</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.microsoftButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => handleOAuth("microsoft")}
          >
            <Text style={styles.buttonIcon}>M</Text>
            <Text style={styles.buttonText}>Sign in with Microsoft</Text>
          </Pressable>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          By signing in you agree to the Terms of Service and Privacy Policy.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 64,
  },
  logo: {
    fontSize: 48,
    fontWeight: "800",
    color: "#ffffff",
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 16,
    color: "#a1a1aa",
    marginTop: 8,
  },
  buttons: {
    gap: 16,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
  },
  googleButton: {
    backgroundColor: "#1a1a2e",
    borderColor: "#2a2a4a",
  },
  microsoftButton: {
    backgroundColor: "#1a1a2e",
    borderColor: "#2a2a4a",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonIcon: {
    fontSize: 20,
    fontWeight: "700",
    color: "#6366f1",
    width: 32,
    textAlign: "center",
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#e4e4e7",
  },
  footer: {
    fontSize: 12,
    color: "#52525b",
    textAlign: "center",
    marginTop: 48,
    lineHeight: 18,
  },
});
