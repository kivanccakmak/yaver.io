import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "../context/ThemeContext";
import { StudioChatPane } from "./studio/StudioChatPane";

/**
 * Browser previews deliberately have no Yaver navigation or debug chrome.
 * The one host control that belongs over the guest is Vibing: the same small
 * Y entry point used by an embedded Hermes guest, backed by the normal
 * execute-once/continue-the-same-task chat implementation.
 */
export function BrowserVibeBubble({
  projectPath,
  projectName,
}: {
  projectPath?: string;
  projectName?: string;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);

  return (
    <View pointerEvents="box-none" style={styles.layer} testID="browser-vibe-overlay">
      <View
        style={[
          styles.panel,
          { backgroundColor: c.bg, borderColor: c.border, shadowColor: c.textPrimary },
          !open && styles.hidden,
        ]}
        pointerEvents={open ? "auto" : "none"}
        accessibilityViewIsModal={open}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "yes" : "no-hide-descendants"}
      >
        <View style={[styles.panelHeader, { borderBottomColor: c.borderSubtle }]}>
          <Text style={[styles.panelTitle, { color: c.textPrimary }]}>Vibing</Text>
          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close Vibing chat"
            hitSlop={10}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={[styles.closeText, { color: c.textSecondary }]}>×</Text>
          </Pressable>
        </View>
        <StudioChatPane compact projectPath={projectPath} projectName={projectName} />
      </View>

      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={open ? "Close Vibing chat" : "Open Vibing chat"}
        accessibilityState={{ expanded: open }}
        testID="browser-vibe-bubble"
        style={({ pressed }) => [
          styles.bubble,
          { backgroundColor: c.brandPrimary, shadowColor: c.brandPrimary },
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.bubbleText}>{open ? "×" : "Y"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
    elevation: 200,
  },
  panel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 86,
    height: "68%",
    maxHeight: 620,
    minHeight: 320,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 20,
    elevation: 24,
  },
  panelHeader: {
    minHeight: 44,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  panelTitle: { fontSize: 16, fontWeight: "800" },
  closeButton: { minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 28, lineHeight: 30, fontWeight: "400" },
  bubble: {
    position: "absolute",
    right: 16,
    bottom: 18,
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 9,
    elevation: 20,
  },
  bubbleText: { color: "#fff", fontSize: 25, fontWeight: "900", fontStyle: "italic" },
  pressed: { opacity: 0.78 },
  hidden: { display: "none" },
});
