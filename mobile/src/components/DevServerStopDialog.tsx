import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { isActiveDevServerStatus } from "../lib/devServerState";
import type { DevServerStatus } from "../lib/quic";

export type DevServerStopPhase = "confirm" | "stopping" | "failed" | "stopped";

type StopResult = {
  ok?: boolean;
  stoppedServing?: boolean;
  verified?: boolean;
  message?: string;
  error?: string;
} | null;

type StopClient = {
  stopDevServer: () => Promise<StopResult>;
  getDevServerStatus: () => Promise<DevServerStatus | null>;
};

export function DevServerStopDialog({
  visible,
  inline = false,
  project,
  port,
  client,
  onCancel,
  onStopped,
  onPhaseChange,
}: {
  visible: boolean;
  inline?: boolean;
  project: string;
  port?: number;
  client: StopClient;
  onCancel: () => void;
  onStopped: () => void;
  onPhaseChange?: (phase: DevServerStopPhase) => void;
}) {
  const [phase, setPhase] = useState<DevServerStopPhase>("confirm");
  const [error, setError] = useState("");

  const moveTo = useCallback((next: DevServerStopPhase) => {
    setPhase(next);
    onPhaseChange?.(next);
  }, [onPhaseChange]);

  useEffect(() => {
    if (!visible) return;
    setError("");
    moveTo("confirm");
  }, [moveTo, visible]);

  const confirmStop = useCallback(async () => {
    if (phase === "stopping") return;
    setError("");
    moveTo("stopping");
    try {
      const result = await client.stopDevServer();
      if (!result?.ok) throw new Error(result?.error || result?.message || "The agent rejected the stop request.");

      // Current agents prove the subprocess is gone before acknowledging.
      // Older agents omit `verified`; independently poll their real /dev/status
      // operation instead of treating a successful HTTP request as a stop.
      let verified = result.verified === true;
      if (result.verified !== false && !verified) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const status = await client.getDevServerStatus();
          if (status && !status.error && !isActiveDevServerStatus(status)) {
            verified = true;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        }
      }
      if (!verified) {
        throw new Error(result.error || "The agent did not confirm that the preview process exited. It may still be running.");
      }

      moveTo("stopped");
      await new Promise((resolveWait) => setTimeout(resolveWait, 650));
      onStopped();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      moveTo("failed");
    }
  }, [client, moveTo, onStopped, phase]);

  if (!visible) return null;

  const body = (
    <View style={[styles.backdrop, inline && styles.inlineBackdrop]} accessibilityViewIsModal>
      <View style={styles.dialog} accessibilityRole="alert">
        <Text style={styles.title}>
          {phase === "stopping" ? "Stopping preview…" : phase === "stopped" ? "Preview stopped" : "Stop this preview?"}
        </Text>
        <Text style={styles.detail}>
          {phase === "confirm"
            ? `${project}${port ? ` on port ${port}` : ""} will stop serving. Your project files are not changed.`
            : phase === "stopping"
              ? "Waiting for the Yaver agent to confirm the server process has exited."
              : phase === "stopped"
                ? "The agent confirmed the server is no longer running."
                : error}
        </Text>
        {phase === "stopping" ? <ActivityIndicator size="small" color="#ef4444" /> : null}
        {phase === "confirm" || phase === "failed" ? (
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={[styles.button, styles.cancelButton]} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void confirmStop()} style={[styles.button, styles.stopButton]} accessibilityRole="button">
              <Text style={styles.stopText}>{phase === "failed" ? "Try again" : "Yes, stop"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );

  if (inline) return body;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={phase === "stopping" ? undefined : onCancel}>
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  inlineBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
  },
  dialog: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#3f3f46",
    backgroundColor: "#151518",
    padding: 20,
    gap: 12,
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "800" },
  detail: { color: "#cbd5e1", fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  button: { minHeight: 44, borderRadius: 10, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  cancelButton: { backgroundColor: "#27272a" },
  stopButton: { backgroundColor: "#7f1d1d" },
  cancelText: { color: "#e4e4e7", fontSize: 14, fontWeight: "700" },
  stopText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
