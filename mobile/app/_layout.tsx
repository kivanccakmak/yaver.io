// Crypto + tweetnacl setup. MUST be the first import — everything
// else (DeviceContext → encryptedPair → tweetnacl) depends on the
// PRNG being installed before tweetnacl's import-time IIFE runs.
// See ../src/lib/cryptoSetup.ts for why this is two steps.
import "../src/lib/cryptoSetup";

// Runtime polyfills — Hermes lacks the static AbortSignal.timeout()/any()
// helpers, so every `fetch(url, { signal: AbortSignal.timeout(ms) })` threw
// "undefined is not a function" (broke mesh enable + presence probes). Install
// before any network code runs. Side-effect import.
import "../src/lib/polyfills";

// Runtime debug — install global JS error + unhandled-rejection
// handlers so uncaught errors land in the appLog ring buffer AND
// (when a device is connected) get forwarded to that agent's
// BlackBox stream. Pairs with the agent's `debug=true` build flag
// in /dev/build-native — once SFMG/yaver bundle is compiled with
// hermesc -g + sourcemaps, the captured stacks here can be
// symbolicated against the .map sidecar to point at real source
// lines. Side-effect import; install fires at module load.
import { installRuntimeDebugHandlers } from "../src/lib/runtimeDebug";
installRuntimeDebugHandlers();

import { router as navigationRouter, Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as ScreenOrientation from "expo-screen-orientation";
import React, { useEffect, useState } from "react";
import { AppState, Dimensions, NativeModules, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { breakpoints } from "../src/theme/tokens";
import { AuthProvider } from "../src/context/AuthContext";
import { DeviceProvider } from "../src/context/DeviceContext";
import { CloudStudioProvider } from "../src/context/CloudStudioContext";
import { ThemeProvider, useTheme } from "../src/context/ThemeContext";
import { getUserSettings } from "../src/lib/auth";
import { FeedbackOverlay } from "../src/components/FeedbackOverlay";
import { ShareComposeModal } from "../src/components/ShareComposeModal";
import { RunningTasksPill } from "../src/components/RunningTasksPill";
import { WatchBridgeHost } from "../src/components/WatchBridgeHost";
import { RuntimeTurnAnnouncerHost } from "../src/components/RuntimeTurnAnnouncerHost";
import YaverSplash from "../src/components/YaverSplash";
import { AuthPushHost } from "../src/components/AuthPushHost";
import { PairLinkHandler } from "../src/lib/pairLinkHandler";
import { PendingDeviceApprovalHost } from "../src/lib/pendingDeviceApproval";
import { ShareIntentReceiver } from "../src/lib/shareReceiver";
import { registerNativeScreenRecorder } from "../src/lib/screenRecorder";
import { startFeedbackShakeBridge } from "../src/lib/feedbackTrigger";
import { useAuth } from "../src/context/AuthContext";
import { recoverInterruptedRemotelessTasks } from "../src/lib/remotelessTaskLifecycle";
import { markCachedRemotelessTasksForReview } from "../src/lib/storage";
import { DogfoodOverlayProvider } from "../src/context/DogfoodOverlayContext";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; detailsOpen: boolean }
> {
  state = { error: null as Error | null, detailsOpen: false };

  static getDerivedStateFromError(error: Error) {
    return { error, detailsOpen: false };
  }

  private recover = (destination: "back" | "more") => {
    try {
      if (destination === "back" && navigationRouter.canGoBack()) navigationRouter.back();
      else navigationRouter.replace("/(tabs)/more" as any);
    } finally {
      this.setState({ error: null, detailsOpen: false });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: "#0a0a0a", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#ef4444", fontSize: 18, fontWeight: "700", marginBottom: 12 }}>
            This screen hit an error
          </Text>
          <Text style={{ color: "#d4d4d8", fontSize: 13, lineHeight: 18 }}>{this.state.error.message}</Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
            <Pressable onPress={() => this.recover("back")} style={{ flex: 1, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#27272a" }}>
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>Back</Text>
            </Pressable>
            <Pressable onPress={() => this.recover("more")} style={{ flex: 1, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#6f58f5" }}>
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>Return to More</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => this.setState((state) => ({ ...state, detailsOpen: !state.detailsOpen }))} style={{ marginTop: 14, paddingVertical: 8 }}>
            <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{this.state.detailsOpen ? "Hide details" : "Show details"}</Text>
          </Pressable>
          {this.state.detailsOpen ? (
            <ScrollView style={{ maxHeight: 240 }}>
              <Text style={{ color: "#888888", fontSize: 11, fontFamily: "monospace" }}>{this.state.error.stack}</Text>
            </ScrollView>
          ) : null}
        </View>
      );
    }
    return this.props.children;
  }
}

function InnerLayout() {
  const { isDark, colors, hydrated: themeHydrated, setTheme } = useTheme();
  const { user, token } = useAuth();
  const router = useRouter();
  // Branded cold-start overlay ("Remote AI Runtime"). Shows on top of the
  // app the moment the native splash hides, then fades itself out via
  // onDone. One-shot per app launch.
  const [showSplash, setShowSplash] = useState(true);
  useEffect(() => {
    if (!token || !themeHydrated) return;
    let cancelled = false;
    void getUserSettings(token).then((settings) => {
      if (cancelled) return;
      const row = settings.appearanceThemeBySurface?.find((item) => item.surface === "mobile");
      if (row?.theme === "light" || row?.theme === "dark") setTheme(row.theme);
    }).catch(() => {
      // Offline boot keeps the locally cached theme. Appearance must never
      // delay or block the authenticated app.
    });
    return () => { cancelled = true; };
  }, [setTheme, themeHydrated, token]);
  useEffect(() => {
    // Fresh process = no safe continuation closure. Convert stale RUNNING to
    // REVIEW so no surface can leave an eternal spinner or falsely say done.
    void recoverInterruptedRemotelessTasks().then((interrupted) => {
      const phoneTaskRows = interrupted.filter((record) => record.id.startsWith("phone-local-"));
      if (!phoneTaskRows.length) return;
      void markCachedRemotelessTasksForReview(
        phoneTaskRows.map((record) => record.id),
        "Background execution ended before completion. Review the working tree, then retry.",
      );
    });
  }, []);
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);
  // Wire the native screen-recorder bridge once on first render. Idempotent
  // — vibePreview.ts.setNativeScreenRecorder just stores the latest fn.
  useEffect(() => {
    registerNativeScreenRecorder();
  }, []);
  useEffect(() => {
    return startFeedbackShakeBridge(user?.id);
  }, [user?.id]);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let mounted = true;
    const consume = async () => {
      try {
        const pending = await (NativeModules as any)?.YaverInfo?.consumePendingCarVoiceLaunch?.();
        if (!mounted || !pending) return;
        router.navigate({
          pathname: "/car-voice-coding",
          params: { autostart: "1", surface: "ios-car" },
        } as any);
      } catch {
        // Optional native bridge; no-op on builds without the method.
      }
    };
    void consume();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void consume();
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [router]);
  // Orientation policy: phones stay portrait (system rotation lock
  // is unreliable across Android OEMs, so enforce in-app); tablets
  // run free so split-pane layouts can use landscape. Decision is
  // made by short-edge dp at boot — a foldable will reach this
  // hook again on configuration change because react-native
  // remounts layout on size class shifts when the OS reports it.
  useEffect(() => {
    const { width, height } = Dimensions.get("window");
    const isTablet = Math.min(width, height) >= breakpoints.tablet;
    (async () => {
      try {
        if (isTablet) {
          await ScreenOrientation.unlockAsync();
        } else {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        }
      } catch {
        // Some Android OEMs / iPad multitasking modes reject lock
        // requests; falling back to manifest defaults is fine.
      }
    })();
  }, []);
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
      <FeedbackOverlay />
      <RunningTasksPill />
      <PairLinkHandler />
      <PendingDeviceApprovalHost />
      <ShareIntentReceiver />
      <ShareComposeModal />
      <WatchBridgeHost />
      <RuntimeTurnAnnouncerHost />
      <AuthPushHost />
      {showSplash ? <YaverSplash onDone={() => setShowSplash(false)} /> : null}
    </>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <DeviceProvider>
            <DogfoodOverlayProvider>
              <CloudStudioProvider>
                <InnerLayout />
              </CloudStudioProvider>
            </DogfoodOverlayProvider>
          </DeviceProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
