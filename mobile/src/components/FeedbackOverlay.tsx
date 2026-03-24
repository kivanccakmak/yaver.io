import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Keyboard,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../context/AuthContext";
import { useDevice } from "../context/DeviceContext";

const BUTTON_SIZE = 40;
const DEFAULT_COLOR = "#ec4899"; // hot pink — unmistakable debug tool

/**
 * Global feedback overlay — draggable debug console button.
 *
 * When user enables Feedback SDK in Settings, this appears as a
 * hot-pink terminal-style ">_" button in the top-right corner.
 * Tap to expand chat panel. Drag to reposition.
 *
 * Distinctively styled so it's never confused with app UI:
 * - Hot pink default (customizable via settings)
 * - Terminal prompt icon ">_"
 * - Green/red connection dot
 */
export function FeedbackOverlay() {
  const { user, token } = useAuth();
  const { activeDevice, connectionStatus } = useDevice();
  const [enabled, setEnabled] = useState(false);
  const [buttonColor, setButtonColor] = useState(DEFAULT_COLOR);
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const isDragging = useRef(false);

  const { width: screenWidth } = Dimensions.get("window");
  const pan = useRef(
    new Animated.ValueXY({ x: screenWidth - BUTTON_SIZE - 10, y: 90 })
  ).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4,
      onPanResponderGrant: () => {
        pan.extractOffset();
        isDragging.current = false;
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dx) > 4 || Math.abs(gs.dy) > 4) isDragging.current = true;
        Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })(_, gs);
      },
      onPanResponderRelease: () => pan.flattenOffset(),
    })
  ).current;

  // Load and poll config from AsyncStorage
  useEffect(() => {
    if (!user?.id) return;
    const key = `@yaver/u/${user.id}/feedback_config`;
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) return;
        const cfg = JSON.parse(raw);
        setEnabled(cfg.enabled === true);
        if (cfg.buttonColor) setButtonColor(cfg.buttonColor);
      } catch {}
    };
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [user?.id]);

  const agentUrl = activeDevice ? `http://${activeDevice.host}:${activeDevice.port}` : null;
  const isConnected = connectionStatus === "connected" && !!agentUrl;

  const handleTap = useCallback(() => {
    if (isDragging.current) return;
    setChatOpen((prev) => !prev);
    setLastResponse(null);
  }, []);

  const handleSend = useCallback(async () => {
    if (!message.trim() || !agentUrl || !token) return;
    setSending(true);
    setLastResponse(null);
    Keyboard.dismiss();
    try {
      const resp = await fetch(`${agentUrl}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: message.trim(), source: "feedback-chat" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setLastResponse(`> task ${data.id ?? "ok"}`);
      } else {
        setLastResponse(`> err ${resp.status}`);
      }
      setMessage("");
    } catch (e) {
      setLastResponse(`> fail: ${String(e).slice(0, 40)}`);
    } finally {
      setSending(false);
    }
  }, [message, agentUrl, token]);

  const handleReload = useCallback(async () => {
    if (!agentUrl || !token) return;
    setReloading(true);
    try {
      await fetch(`${agentUrl}/exec`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "reload", type: "hot-reload" }),
      });
      setLastResponse("> reload ok");
    } catch {
      setLastResponse("> reload fail");
    } finally {
      setReloading(false);
    }
  }, [agentUrl, token]);

  const handleDisable = useCallback(async () => {
    if (!user?.id) return;
    const key = `@yaver/u/${user.id}/feedback_config`;
    const raw = await AsyncStorage.getItem(key);
    const cfg = raw ? JSON.parse(raw) : {};
    cfg.enabled = false;
    await AsyncStorage.setItem(key, JSON.stringify(cfg));
    setEnabled(false);
    setChatOpen(false);
  }, [user?.id]);

  if (!enabled) return null;

  // Button tint based on connection
  const btnBg = isConnected ? buttonColor : `${buttonColor}88`;

  return (
    <Animated.View
      style={[styles.root, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
      {...panResponder.panHandlers}
    >
      {/* Chat panel */}
      {chatOpen && (
        <View style={styles.panel}>
          {/* Header */}
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>yaver debug</Text>
            <View style={[styles.dotSmall, isConnected ? styles.green : styles.red]} />
            <Text style={styles.headerStatus}>{isConnected ? "live" : "off"}</Text>
            <TouchableOpacity onPress={handleDisable} style={styles.xBtn}>
              <Text style={styles.xBtnText}>\u2715</Text>
            </TouchableOpacity>
          </View>

          {/* Terminal-style input */}
          <View style={styles.inputRow}>
            <Text style={styles.prompt}>&gt;</Text>
            <TextInput
              style={styles.input}
              placeholder="tell the agent..."
              placeholderTextColor="#444"
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={handleSend}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[styles.goBtn, (sending || !message.trim()) && styles.dim]}
              onPress={handleSend}
              disabled={sending || !message.trim() || !isConnected}
            >
              {sending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.goBtnText}>run</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Quick actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, !isConnected && styles.dim]}
              onPress={handleReload}
              disabled={reloading || !isConnected}
            >
              <Text style={styles.actionText}>{reloading ? "..." : "reload"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={handleDisable}>
              <Text style={[styles.actionText, { color: "#f87171" }]}>quit</Text>
            </TouchableOpacity>
          </View>

          {/* Output */}
          {lastResponse && (
            <Text style={styles.output}>{lastResponse}</Text>
          )}
        </View>
      )}

      {/* The button — terminal-style >_ icon */}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: btnBg }]}
        activeOpacity={0.7}
        onPress={handleTap}
      >
        <Text style={styles.buttonIcon}>{chatOpen ? "\u2715" : ">_"}</Text>
        <View style={[styles.statusDot, isConnected ? styles.green : styles.red]} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    zIndex: 99999,
    alignItems: "flex-end",
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    elevation: 10,
  },
  buttonIcon: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "900",
    fontFamily: "Courier",
  },
  statusDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#000",
  },
  green: { backgroundColor: "#22c55e" },
  red: { backgroundColor: "#ef4444" },
  // Panel — dark terminal style
  panel: {
    width: 260,
    backgroundColor: "#0a0a0a",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#ec489944",
    shadowColor: "#ec4899",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 5,
  },
  headerTitle: {
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    color: "#ec4899",
    fontFamily: "Courier",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  dotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  headerStatus: {
    fontSize: 10,
    color: "#666",
    fontFamily: "Courier",
  },
  xBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  xBtnText: {
    color: "#666",
    fontSize: 12,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  prompt: {
    color: "#ec4899",
    fontSize: 14,
    fontWeight: "700",
    fontFamily: "Courier",
  },
  input: {
    flex: 1,
    backgroundColor: "#111",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: "#e5e5e5",
    fontSize: 12,
    fontFamily: "Courier",
    borderWidth: 1,
    borderColor: "#222",
  },
  goBtn: {
    backgroundColor: "#ec4899",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  goBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    fontFamily: "Courier",
  },
  dim: { opacity: 0.3 },
  actionsRow: {
    flexDirection: "row",
    gap: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 6,
    alignItems: "center",
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },
  actionText: {
    fontSize: 10,
    color: "#888",
    fontWeight: "600",
    fontFamily: "Courier",
  },
  output: {
    marginTop: 6,
    fontSize: 11,
    color: "#22c55e",
    fontFamily: "Courier",
  },
});
