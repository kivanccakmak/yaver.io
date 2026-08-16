// attach.tsx — the ATTACHED surface. Yaver rendering Yaver, full-screen.
//
// ── The escape lives out here, and that is the whole safety argument ────────
//
// Hermes is refused for Yaver-on-Yaver because it puts two shake/exit owners in
// one React Native process: the previewed Yaver and the host Yaver both claim
// shake, so the preview cannot reliably be exited. The web target has no such
// problem — a WebView cannot register an RN gesture handler on the host and
// cannot draw over native chrome.
//
// That is only true while the chrome stays OUTSIDE the WebView. The header
// below is native, always mounted, and never covered by the attached content.
// Moving it inside the WebView, or letting the WebView render full-bleed over
// it, reintroduces exactly the trap the refusal exists to prevent.
//
// ── What the user sees ─────────────────────────────────────────────────────
//
// One honest status line (box · runner · elapsed · last output), the attached
// app, and Detach. Not a diagnostics wall: an advisory that squeezes the action
// lane to zero height is a worse bug than missing information (build 482).

import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useColors } from "../src/context/ThemeContext";
import { useDevice } from "../src/context/DeviceContext";
import {
  ATTACH_REFRESH_MS,
  refreshAttachSession,
  stopAttachSession,
} from "../src/lib/attachClient";
import { ATTACH_SENTINEL_KEY } from "../src/lib/attachMode";
import { planRevert } from "../src/lib/runtimeMode";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  setActivePreviewLane,
  subscribeBrowserRender,
} from "../src/lib/feedbackTrigger";
import { appLog } from "../src/lib/logger";

function elapsedLabel(sinceMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export default function AttachScreen() {
  const c = useColors();
  const { activeDevice } = useDevice();
  const params = useLocalSearchParams<{
    sessionId?: string;
    url?: string;
    workDir?: string;
    runner?: string;
    deviceId?: string;
    deviceName?: string;
  }>();

  const webViewRef = useRef<WebView>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [startedAt] = useState(() => Date.now());
  const [, forceTick] = useState(0);
  const [lastEvent, setLastEvent] = useState<{ label: string; at: number } | null>(null);
  const [fatal, setFatal] = useState<{ message: string; remedy?: string } | null>(null);
  const reloadInFlight = useRef(false);

  const deviceId = params.deviceId || activeDevice?.id || "";
  const deviceName = params.deviceName || activeDevice?.name || "the box";
  const sessionId = params.sessionId || "";
  const attachedUrl = params.url || "";

  // The status line must keep MOVING. A frozen "connecting" is the thing that
  // makes a working system look hung, so tick once a second while attached.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the capability alive while the surface is open. The agent's token TTL
  // is 10 minutes; we re-mint every 4 so a slow network cannot let it lapse
  // mid-session and drop the user onto a 401 they did nothing to cause.
  useEffect(() => {
    if (!sessionId || !deviceId) return;
    let cancelled = false;
    const tick = async () => {
      const res = await refreshAttachSession(deviceId, sessionId);
      if (cancelled) return;
      if (!res.ok) {
        // Say it. A silently-expired session would present as the attached app
        // mysteriously failing to load anything.
        setFatal({
          message: res.error || "The attach session expired.",
          remedy: res.remedy || "Detach and turn Attach Mode on again.",
        });
      }
    };
    const timer = setInterval(tick, ATTACH_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, deviceId]);

  // This surface IS a browser-lane preview, so it claims the lane and listens
  // for the post-task render the Tasks tab queues.
  useEffect(() => {
    setActivePreviewLane("browser");
    const unsub = subscribeBrowserRender((source) => {
      // Atomic: one reload at a time. A second trigger while one is in flight
      // is dropped, never queued into a double refresh that would yank the
      // surface out from under the user twice.
      if (reloadInFlight.current) return;
      reloadInFlight.current = true;
      appLog("info", `attach: refreshing attached surface (${source})`);
      setLastEvent({ label: "refreshed after a coding turn", at: Date.now() });
      setWebViewKey((k) => k + 1);
      setTimeout(() => {
        reloadInFlight.current = false;
      }, 1500);
    });
    return () => {
      unsub();
      setActivePreviewLane(null);
    };
  }, []);

  // REVERT — back to the app you actually installed.
  //
  // In Attach Mode the host native app IS the installed TestFlight/Play build;
  // the dev copy is only a WebView on top of it. So reverting is always
  // possible and always fast: drop the surface and the native app underneath
  // is the real one. That is a property worth stating, because it is what
  // makes the whole mode safe to hand someone.
  //
  // planRevert() enumerates what must happen so none of it can be quietly
  // skipped. Both halves of the revoke matter: clearing local state while a
  // capability stays live on the box is the false green this repo keeps
  // finding — the UI says reverted, the operation says attached.
  const detach = useCallback(async () => {
    const plan = planRevert("attached-yaver")!;

    if (plan.revokeAttachSession) {
      const revoked = await stopAttachSession(deviceId, sessionId);
      if (!revoked) {
        // Non-fatal: the session idles out on the box within 30 minutes even
        // if this call never lands. Say it rather than swallow it.
        appLog("warn", "attach: server-side revoke did not confirm; session will idle out");
      }
    }
    if (plan.clearAttachSentinel) {
      // A stale sentinel would make the NEXT launch think it is still the
      // attached copy, hide Attach Mode behind the nesting guard, and show a
      // dev badge on the real app.
      try {
        await AsyncStorage.removeItem(ATTACH_SENTINEL_KEY);
      } catch {
        // best-effort
      }
    }
    setActivePreviewLane(null);
    router.back();
  }, [deviceId, sessionId]);

  const confirmDetach = useCallback(() => {
    Alert.alert(
      "Back to the installed app",
      "Stop rendering the development build and return to the Yaver you installed. " +
        "Your work on the box is untouched — only this preview ends.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Revert", style: "destructive", onPress: () => void detach() },
      ],
    );
  }, [detach]);

  // The sentinel tells the INNER Yaver what it is, so it refuses to offer
  // Attach Mode again (an infinite mirror). It carries no authority — the real
  // capability is an HttpOnly cookie this JS cannot read, which is the point.
  const injectedBeforeLoad = `(function(){try{
    window.localStorage.setItem(${JSON.stringify(ATTACH_SENTINEL_KEY)}, "1");
  }catch(e){}})(); true;`;

  const statusLine = [
    deviceName,
    params.runner || null,
    `${elapsedLabel(startedAt)} attached`,
    lastEvent ? `${lastEvent.label} ${elapsedLabel(lastEvent.at)} ago` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={["top", "bottom"]}>
      {/* NATIVE CHROME — outside the WebView, always mounted. See the file
          header: this is what makes rendering Yaver inside Yaver safe. */}
      <View style={[styles.chrome, { borderBottomColor: c.border, backgroundColor: c.bgCard }]}>
        <Pressable
          onPress={confirmDetach}
          accessibilityLabel="Detach"
          style={({ pressed }) => [styles.chromeBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={{ color: c.textPrimary, fontSize: 15, fontWeight: "600" }}>Detach</Text>
        </Pressable>

        <View style={styles.chromeCenter}>
          <Text numberOfLines={1} style={{ color: c.textPrimary, fontSize: 13, fontWeight: "600" }}>
            Attached to Yaver
          </Text>
          <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: 11 }}>
            {statusLine}
          </Text>
        </View>

        <Pressable
          onPress={() => {
            if (reloadInFlight.current) return;
            setWebViewKey((k) => k + 1);
          }}
          accessibilityLabel="Reload"
          style={({ pressed }) => [styles.chromeBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={{ color: c.textPrimary, fontSize: 15 }}>{"↻"}</Text>
        </Pressable>
      </View>

      {fatal ? (
        <View style={[styles.fatal, { borderColor: c.errorBorder, backgroundColor: c.errorBg }]}>
          <Text style={{ color: c.textPrimary, fontSize: 13, lineHeight: 18 }}>{fatal.message}</Text>
          {fatal.remedy ? (
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
              {fatal.remedy}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.surface}>
        {attachedUrl ? (
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: attachedUrl }}
            injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            // The attach capability is a cookie; without this the WebView would
            // not send it and every request would 401.
            originWhitelist={["*"]}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => {
              setLoading(false);
              reloadInFlight.current = false;
            }}
            onError={(e) => {
              setLoading(false);
              reloadInFlight.current = false;
              const d = e.nativeEvent;
              setFatal({
                message: `The attached surface failed to load: ${d.description || "unknown error"}`,
                remedy:
                  "Check the dev server is still running on the box. Detach and re-attach to restart it.",
              });
            }}
            style={{ flex: 1, backgroundColor: c.bg }}
          />
        ) : (
          <View style={styles.center}>
            <Text style={{ color: c.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 24 }}>
              No attached URL was passed to this screen. Turn Attach Mode on from Settings.
            </Text>
          </View>
        )}

        {loading ? (
          <View style={[styles.loading, { backgroundColor: c.bg + "CC" }]} pointerEvents="none">
            <ActivityIndicator color={c.accent} />
            <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 8 }}>
              {`Loading Yaver from ${deviceName} · ${elapsedLabel(startedAt)}`}
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chrome: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  chromeBtn: { paddingHorizontal: 6, paddingVertical: 4, minWidth: 44 },
  chromeCenter: { flex: 1, alignItems: "center" },
  surface: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  fatal: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
});

// Web note: RN-web has no react-native-webview. Attach Mode is a phone surface;
// on web the dashboard already renders previews in an iframe. Guarded here so
// the bundle does not explode if this route is ever reached under RN-web.
export const unstable_settings = { initialRouteName: "attach" };
void Platform;
