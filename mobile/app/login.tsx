import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/context/AuthContext";
import {
  type OAuthProvider,
  getConvexSiteUrl,
  getOAuthUrl,
} from "../src/lib/auth";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const { login } = useAuth();
  const [isLoading, setIsLoading] = useState(false);

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
          // Token validation failed
        }
      }
    });

    return () => subscription.remove();
  }, [login]);

  const handleOAuth = async (provider: OAuthProvider) => {
    const url = getOAuthUrl(provider);
    await WebBrowser.openBrowserAsync(url, {
      showInRecents: true,
    });
  };

  const handleAppleNative = async () => {
    setIsLoading(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken) {
        throw new Error("No identity token");
      }

      const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
        .filter(Boolean)
        .join(" ") || undefined;

      const res = await fetch(`${getConvexSiteUrl()}/auth/apple-native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityToken: credential.identityToken,
          fullName,
        }),
      });

      if (!res.ok) {
        throw new Error("Auth failed");
      }

      const { token } = await res.json();
      await login(token);
      router.replace("/(tabs)/tasks");
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED") {
        // User cancelled — do nothing
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.logo}>Yaver</Text>
          <Text style={styles.subtitle}>
            Your AI coding assistant, everywhere.
          </Text>
        </View>

        <View style={styles.buttons}>
          {/* Native Apple Sign-In on iOS */}
          {Platform.OS === "ios" && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={12}
              style={styles.appleButton}
              onPress={handleAppleNative}
            />
          )}

          {/* Fallback Apple OAuth on Android */}
          {Platform.OS !== "ios" && (
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.oauthButton,
                pressed && styles.buttonPressed,
              ]}
              onPress={() => handleOAuth("apple")}
            >
              <View style={[styles.iconBox, { backgroundColor: "#fff" }]}>
                <Text style={[styles.buttonIcon, { color: "#000" }]}>{"\uF8FF"}</Text>
              </View>
              <Text style={styles.buttonText}>Continue with Apple</Text>
            </Pressable>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.oauthButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => handleOAuth("google")}
          >
            <View style={[styles.iconBox, { backgroundColor: "#fff" }]}>
              <Text style={[styles.buttonIcon, { color: "#4285F4" }]}>G</Text>
            </View>
            <Text style={styles.buttonText}>Continue with Google</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.oauthButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => handleOAuth("microsoft")}
          >
            <View style={[styles.iconBox, { backgroundColor: "#fff" }]}>
              <Text style={[styles.buttonIcon, { color: "#00A4EF" }]}>M</Text>
            </View>
            <Text style={styles.buttonText}>Continue with Microsoft</Text>
          </Pressable>
        </View>

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
    gap: 12,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  oauthButton: {
    backgroundColor: "#111111",
    borderColor: "#2a2a2a",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  appleButton: {
    height: 52,
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  buttonIcon: {
    fontSize: 18,
    fontWeight: "700",
  },
  buttonText: {
    fontSize: 15,
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
