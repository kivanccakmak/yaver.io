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

const BUTTON_SIZE = 46;
const PANEL_WIDTH = 280;

/**
 * Global feedback overlay — draggable indigo "y" debug button.
 * Reads config from AsyncStorage. Appears when Feedback SDK is enabled.
 *
 * Panel auto-positions: opens left when button is near right edge,
 * opens right when near left edge.
 */
export function FeedbackOverlay() {
  const { user, token } = useAuth();
  const { activeDevice, connectionStatus } = useDevice();
  const [enabled, setEnabled] = useState(false);
  const [buttonColor, setButtonColor] = useState("#6366f1");
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [reloading, setReloading] = useState(false);
  const isDragging = useRef(false);
  const buttonPosX = useRef(0);

  const { width: screenWidth } = Dimensions.get("window");
  const startX = screenWidth - BUTTON_SIZE - 10;
  const pan = useRef(new Animated.ValueXY({ x: startX, y: 90 })).current;

  // Track button X position for panel alignment
  useEffect(() => {
    const id = pan.x.addListener(({ value }) => { buttonPosX.current = value; });
    return () => pan.x.removeListener(id);
  }, [pan.x]);

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

  // Load config — reset state on re-enable
  useEffect(() => {
    if (!user?.id) return;
    const key = `@yaver/u/${user.id}/feedback_config`;
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) return;
        const cfg = JSON.parse(raw);
        const newEnabled = cfg.enabled === true;
        if (newEnabled && !enabled) {
          // Re-enable: reset chat state
          setChatOpen(false);
          setOutput([]);
          setMessage("");
          setSending(false);
        }
        setEnabled(newEnabled);
        if (cfg.buttonColor) setButtonColor(cfg.buttonColor);
      } catch {}
    };
    load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [user?.id, enabled]);

  const agentUrl = activeDevice ? `http://${activeDevice.host}:${activeDevice.port}` : null;
  const isConnected = connectionStatus === "connected" && !!agentUrl;

  const addOutput = useCallback((line: string) => {
    setOutput((prev) => [...prev.slice(-8), line]); // keep last 9 lines
  }, []);

  const handleTap = useCallback(() => {
    if (isDragging.current) return;
    setChatOpen((prev) => !prev);
  }, []);

  // Send message → create task → poll for output
  const handleSend = useCallback(async () => {
    if (!message.trim() || !agentUrl || !token) return;
    const msg = message.trim();
    setSending(true);
    setMessage("");
    Keyboard.dismiss();
    addOutput(`> ${msg}`);

    try {
      const resp = await fetch(`${agentUrl}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: msg, source: "feedback-console" }),
      });
      if (!resp.ok) {
        addOutput(`err: ${resp.status}`);
        setSending(false);
        return;
      }
      const data = await resp.json();
      const taskId = data.id ?? data.task?.id;
      if (!taskId) {
        addOutput("task created (no id)");
        setSending(false);
        return;
      }
      addOutput(`task ${taskId} started...`);

      // Poll task output for up to 30s
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const statusResp = await fetch(`${agentUrl}/tasks/${taskId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!statusResp.ok) {
            clearInterval(poll);
            setSending(false);
            return;
          }
          const task = await statusResp.json();
          const t = task.task ?? task;

          if (t.status === "finished" || t.status === "failed" || t.status === "stopped") {
            // Get the last bit of output
            const out = t.output ?? t.rawOutput ?? "";
            if (out) {
              const lines = out.split("\n").filter((l: string) => l.trim());
              const last3 = lines.slice(-3);
              for (const l of last3) addOutput(l.slice(0, 60));
            }
            addOutput(t.status === "finished" ? "done." : `${t.status}.`);
            clearInterval(poll);
            setSending(false);
          } else if (attempts >= 15) {
            addOutput("running in background...");
            clearInterval(poll);
            setSending(false);
          }
        } catch {
          clearInterval(poll);
          setSending(false);
        }
      }, 2000);
    } catch (e) {
      addOutput(`fail: ${String(e).slice(0, 40)}`);
      setSending(false);
    }
  }, [message, agentUrl, token, addOutput]);

  // Reload
  const handleReload = useCallback(async () => {
    if (!agentUrl || !token) return;
    setReloading(true);
    addOutput("> reload");
    try {
      const resp = await fetch(`${agentUrl}/exec`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "reload", type: "hot-reload" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        addOutput(data.output ?? data.message ?? "reload triggered");
      } else {
        addOutput(`reload err: ${resp.status}`);
      }
    } catch (e) {
      addOutput(`reload fail: ${String(e).slice(0, 30)}`);
    } finally {
      setReloading(false);
    }
  }, [agentUrl, token, addOutput]);

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

  // Panel alignment: if button is in right half, panel opens to the left
  const panelOnLeft = buttonPosX.current > screenWidth / 2;
  const btnBg = isConnected ? buttonColor : `${buttonColor}66`;

  return (
    <Animated.View
      style={[
        styles.root,
        { transform: [{ translateX: pan.x }, { translateY: pan.y }] },
        panelOnLeft ? { alignItems: "flex-end" } : { alignItems: "flex-start" },
      ]}
      {...panResponder.panHandlers}
    >
      {/* Panel */}
      {chatOpen && (
        <View style={[styles.panel, { borderColor: `${buttonColor}44`, shadowColor: buttonColor }]}>
          {/* Header */}
          <View style={styles.headerRow}>
            <Text style={[styles.headerTitle, { color: buttonColor }]}>yaver debug</Text>
            <View style={[styles.dot, isConnected ? styles.green : styles.red]} />
            <Text style={styles.headerStatus}>{isConnected ? "live" : "off"}</Text>
            <TouchableOpacity onPress={() => setChatOpen(false)} style={styles.xBtn}>
              <Text style={styles.xBtnText}>{"\u2715"}</Text>
            </TouchableOpacity>
          </View>

          {/* Output area */}
          {output.length > 0 && (
            <View style={styles.outputArea}>
              {output.map((line, i) => (
                <Text key={i} style={[styles.outputLine, line.startsWith(">") && { color: "#9ca3af" }]}>
                  {line}
                </Text>
              ))}
              {sending && <ActivityIndicator color={buttonColor} size="small" style={{ marginTop: 4 }} />}
            </View>
          )}

          {/* Input */}
          <View style={styles.inputRow}>
            <Text style={[styles.prompt, { color: buttonColor }]}>&gt;</Text>
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
              style={[styles.goBtn, { backgroundColor: buttonColor }, (sending || !message.trim()) && styles.dim]}
              onPress={handleSend}
              disabled={sending || !message.trim() || !isConnected}
            >
              <Text style={styles.goBtnText}>run</Text>
            </TouchableOpacity>
          </View>

          {/* Actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, !isConnected && styles.dim]}
              onPress={handleReload}
              disabled={reloading || !isConnected}
            >
              <Text style={styles.actionText}>{reloading ? "..." : "reload"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => setOutput([])}
            >
              <Text style={styles.actionText}>clear</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={handleDisable}>
              <Text style={[styles.actionText, { color: "#f87171" }]}>quit</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Button */}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: btnBg }]}
        activeOpacity={0.7}
        onPress={handleTap}
      >
        <Text style={styles.buttonIcon}>{chatOpen ? "\u2715" : "y"}</Text>
        <View style={[styles.statusDot, isConnected ? styles.green : styles.red]} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    zIndex: 99999,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: 12,
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
    fontSize: 24,
    fontWeight: "800",
    fontStyle: "italic",
  },
  statusDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#000",
  },
  green: { backgroundColor: "#22c55e" },
  red: { backgroundColor: "#ef4444" },
  // Panel
  panel: {
    width: PANEL_WIDTH,
    backgroundColor: "#0a0a0a",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
    gap: 5,
  },
  headerTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
    fontStyle: "italic",
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  headerStatus: { fontSize: 10, color: "#555", fontFamily: "Courier" },
  xBtn: { paddingHorizontal: 6, paddingVertical: 2 },
  xBtnText: { color: "#555", fontSize: 14 },
  // Output
  outputArea: {
    backgroundColor: "#111",
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    maxHeight: 140,
  },
  outputLine: {
    fontSize: 11,
    color: "#22c55e",
    fontFamily: "Courier",
    lineHeight: 16,
  },
  // Input
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  prompt: { fontSize: 16, fontWeight: "700", fontFamily: "Courier" },
  input: {
    flex: 1,
    backgroundColor: "#111",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 7,
    color: "#e5e5e5",
    fontSize: 13,
    fontFamily: "Courier",
    borderWidth: 1,
    borderColor: "#222",
  },
  goBtn: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7 },
  goBtnText: { color: "#fff", fontSize: 12, fontWeight: "700", fontFamily: "Courier" },
  dim: { opacity: 0.3 },
  // Actions
  actionsRow: { flexDirection: "row", gap: 4 },
  actionBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: "center",
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },
  actionText: { fontSize: 11, color: "#888", fontWeight: "600", fontFamily: "Courier" },
});
