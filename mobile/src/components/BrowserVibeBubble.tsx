import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useDevice } from "../context/DeviceContext";
import { quicClient, type RunnerInfo, type Task } from "../lib/quic";
import { OpenCodeConfigModal } from "./OpenCodeConfigModal";
import RunnerAuthModal from "./RunnerAuthModal";
import { StudioChatPane } from "./studio/StudioChatPane";

type ReloadKind = "fast" | "full";

function runnerKey(id: string | undefined): string {
  return id === "claude-code" ? "claude" : (id || "").trim();
}

function runnerLabel(runner: RunnerInfo | undefined, fallback: string): string {
  if (runner?.name) return runner.name;
  if (fallback === "claude") return "Claude Code";
  if (fallback === "codex") return "OpenAI Codex";
  if (fallback === "opencode") return "OpenCode";
  return fallback || "Choose runner";
}

/**
 * Yaver-owned control over a browser-lane guest.
 *
 * This mirrors the native YaverFeedbackPane contract: keyboard-safe composer,
 * visible/changeable runner + model, live transcript, reload, overflow actions,
 * and a route back to the Yaver host. Minimizing hides only the card; the
 * mounted StudioChatPane and its task SSE subscription stay alive so the user
 * can test the guest while the runner keeps coding.
 */
export function BrowserVibeBubble({
  projectPath,
  projectName,
  onExitPreview,
  onReload,
  reloadBusy = false,
}: {
  projectPath?: string;
  projectName?: string;
  onExitPreview: () => void;
  onReload: (kind: ReloadKind) => boolean | void | Promise<boolean | void>;
  reloadBusy?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const {
    activeDevice,
    connectionStatus,
    primaryRunnerByDevice,
    primaryModelByDevice,
    setPrimaryRunnerForDevice,
  } = useDevice();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [runnersLoading, setRunnersLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectedRunnerId, setSelectedRunnerId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [localReloadBusy, setLocalReloadBusy] = useState(false);
  const [queuedReload, setQueuedReload] = useState<ReloadKind | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [conversationKey, setConversationKey] = useState(0);
  const [runnerAuthFor, setRunnerAuthFor] = useState<string | null>(null);
  const [showOpenCodeConfig, setShowOpenCodeConfig] = useState(false);
  const [runnerSetupBusy, setRunnerSetupBusy] = useState<string | null>(null);
  const [runnerSetupProgress, setRunnerSetupProgress] = useState<string | null>(null);

  const deviceId = activeDevice?.id || "";
  const savedRunner = runnerKey(deviceId ? primaryRunnerByDevice[deviceId] : "");
  const savedModel = deviceId ? primaryModelByDevice[deviceId] || "" : "";

  const loadRunners = useCallback(async () => {
    if (connectionStatus !== "connected") return;
    setRunnersLoading(true);
    setSelectionError(null);
    try {
      const rows = (await quicClient.getRunners()).filter((row) => ["claude", "codex", "opencode"].includes(runnerKey(row.id)));
      setRunners(rows);
      const preferred = rows.find((row) => runnerKey(row.id) === savedRunner);
      const preferredReady = preferred?.installed && preferred.ready !== false ? preferred : undefined;
      const fallback = rows.find((row) => row.isDefault && row.installed && row.ready !== false)
        || rows.find((row) => row.installed && row.ready !== false)
        || preferred
        || rows[0];
      const chosen = preferredReady || fallback;
      if (chosen) {
        const model = chosen.models?.find((item) => item.id === savedModel)
          || chosen.models?.find((item) => item.isDefault)
          || chosen.models?.[0];
        setSelectedRunnerId(runnerKey(chosen.id));
        setSelectedModelId(model?.id || "");
      }
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Could not read runner choices");
      setSelectedRunnerId(savedRunner);
      setSelectedModelId(savedModel);
    } finally {
      setRunnersLoading(false);
    }
  }, [connectionStatus, savedModel, savedRunner]);

  useEffect(() => {
    if (!open) return;
    void loadRunners();
  }, [open, loadRunners]);

  useEffect(() => {
    if (!selectedRunnerId && savedRunner) setSelectedRunnerId(savedRunner);
    if (!selectedModelId && savedModel) setSelectedModelId(savedModel);
  }, [savedModel, savedRunner, selectedModelId, selectedRunnerId]);

  const selectedRunner = useMemo(
    () => runners.find((row) => runnerKey(row.id) === selectedRunnerId),
    [runners, selectedRunnerId],
  );

  const chooseRunner = useCallback(async (runner: RunnerInfo) => {
    if (!deviceId || !runner.installed || runner.ready === false || activeTask?.status === "running" || activeTask?.status === "queued") return;
    const model = runner.models?.find((item) => item.isDefault) || runner.models?.[0];
    const nextRunner = runnerKey(runner.id);
    const previousRunner = selectedRunnerId;
    const previousModel = selectedModelId;
    setSelectedRunnerId(nextRunner);
    setSelectedModelId(model?.id || "");
    setSelectionError(null);
    try {
      await setPrimaryRunnerForDevice(deviceId, nextRunner, model?.id || null);
      setConversationKey((value) => value + 1);
    } catch (error) {
      setSelectedRunnerId(previousRunner);
      setSelectedModelId(previousModel);
      setSelectionError(error instanceof Error ? error.message : "Could not save runner");
    }
  }, [activeTask?.status, deviceId, selectedModelId, selectedRunnerId, setPrimaryRunnerForDevice]);

  const chooseModel = useCallback(async (modelId: string) => {
    if (!deviceId || !selectedRunnerId || activeTask?.status === "running" || activeTask?.status === "queued") return;
    const previousModel = selectedModelId;
    setSelectedModelId(modelId);
    setSelectionError(null);
    try {
      await setPrimaryRunnerForDevice(deviceId, selectedRunnerId, modelId || null);
      setConversationKey((value) => value + 1);
    } catch (error) {
      setSelectedModelId(previousModel);
      setSelectionError(error instanceof Error ? error.message : "Could not save model");
    }
  }, [activeTask?.status, deviceId, selectedModelId, selectedRunnerId, setPrimaryRunnerForDevice]);

  const runReloadNow = useCallback(async (kind: ReloadKind) => {
    if (reloadBusy || localReloadBusy) return;
    setLocalReloadBusy(true);
    setReloadNotice(kind === "fast" ? "Reloading preview…" : "Restarting preview…");
    try {
      const reloaded = await onReload(kind);
      if (reloaded === false) {
        setReloadNotice("Reload failed — use the shown recovery action");
        return;
      }
      setMenuOpen(false);
      setReloadNotice(kind === "fast" ? "Preview reloaded" : "Preview restarted");
    } catch (error) {
      setReloadNotice(error instanceof Error ? `Reload failed: ${error.message}` : "Reload failed");
    } finally {
      setLocalReloadBusy(false);
    }
  }, [localReloadBusy, onReload, reloadBusy]);

  const isCoding = activeTask?.status === "running" || activeTask?.status === "queued";
  const reload = useCallback(async (kind: ReloadKind) => {
    if (isCoding) {
      setQueuedReload(kind);
      setReloadNotice(kind === "fast" ? "Reload queued until coding finishes" : "Restart queued until coding finishes");
      setMenuOpen(false);
      return;
    }
    await runReloadNow(kind);
  }, [isCoding, runReloadNow]);

  useEffect(() => {
    if (isCoding || !queuedReload || reloadBusy || localReloadBusy) return;
    const kind = queuedReload;
    setQueuedReload(null);
    void runReloadNow(kind);
  }, [isCoding, localReloadBusy, queuedReload, reloadBusy, runReloadNow]);

  useEffect(() => {
    if (!reloadNotice || queuedReload || localReloadBusy) return;
    const timer = setTimeout(() => setReloadNotice(null), 2400);
    return () => clearTimeout(timer);
  }, [localReloadBusy, queuedReload, reloadNotice]);

  const busy = reloadBusy || localReloadBusy;
  const chipLabel = runnersLoading && !selectedRunnerId
    ? "Checking runner…"
    : [
        runnerLabel(
          runners.find((row) => runnerKey(row.id) === runnerKey(activeTask?.runnerId)) || selectedRunner,
          runnerKey(activeTask?.runnerId) || selectedRunnerId,
        ),
        activeTask?.model || selectedModelId,
      ].filter(Boolean).join(" · ");

  const repairRunner = useCallback(async (runner: RunnerInfo) => {
    const id = runnerKey(runner.id);
    if (runnerSetupBusy || connectionStatus !== "connected") return;
    if (runner.installed) {
      if (id === "opencode") setShowOpenCodeConfig(true);
      else setRunnerAuthFor(id);
      return;
    }
    setRunnerSetupBusy(id);
    setRunnerSetupProgress(`Installing ${runnerLabel(runner, id)}…`);
    setSelectionError(null);
    try {
      const result = await quicClient.installRunner(id, {
        onProgress: (line) => {
          const clean = line.trim();
          if (clean) setRunnerSetupProgress(clean.slice(-180));
        },
      });
      if (!result.ok) throw new Error(result.error || `Could not install ${runnerLabel(runner, id)}`);
      setRunnerSetupProgress(`${runnerLabel(runner, id)} installed`);
      await loadRunners();
      if (id === "opencode") setShowOpenCodeConfig(true);
      else setRunnerAuthFor(id);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : `Could not install ${runnerLabel(runner, id)}`);
      setRunnerSetupProgress(null);
    } finally {
      setRunnerSetupBusy(null);
    }
  }, [connectionStatus, loadRunners, runnerSetupBusy]);

  const disconnected = connectionStatus !== "connected";
  const noReadyRunner = !runnersLoading && runners.length > 0 && !runners.some((runner) => runner.installed && runner.ready !== false);

  return (
    <View pointerEvents="box-none" style={styles.layer} testID="browser-vibe-overlay">
      <KeyboardAvoidingView
        pointerEvents={open ? "box-none" : "none"}
        style={styles.keyboardLayer}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <View
          style={[
            styles.panelPosition,
            { paddingTop: Math.max(insets.top + 8, 18), paddingBottom: Math.max(insets.bottom + 76, 86) },
            !open && styles.hidden,
          ]}
        >
          <View
            style={styles.panel}
            accessibilityViewIsModal={open}
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? "yes" : "no-hide-descendants"}
          >
            <View style={styles.handleWrap}><View style={styles.handle} /></View>
            <View style={styles.panelHeader}>
              <View style={styles.titleWrap}>
                <Text style={styles.panelTitle}>Vibing</Text>
                <Text style={styles.panelSubtitle} numberOfLines={1}>{projectName || "browser preview"}</Text>
              </View>
              <Pressable
                onPress={() => void reload("fast")}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Reload preview"
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed, busy && styles.disabled]}
              >
                {busy ? <ActivityIndicator size="small" color="#a8a9ff" /> : <Ionicons name="refresh" size={18} color="#a8a9ff" />}
              </Pressable>
              <Pressable
                onPress={() => { setMenuOpen((value) => !value); setPickerOpen(false); }}
                accessibilityRole="button"
                accessibilityLabel="Preview actions"
                accessibilityState={{ expanded: menuOpen }}
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <Ionicons name="ellipsis-horizontal-circle" size={20} color="#a8a9ff" />
              </Pressable>
              <Pressable
                onPress={() => { setOpen(false); setMenuOpen(false); setPickerOpen(false); }}
                accessibilityRole="button"
                accessibilityLabel="Minimize Vibing"
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <Ionicons name="remove" size={22} color="rgba(255,255,255,0.68)" />
              </Pressable>
            </View>

            <Pressable
              onPress={() => { if (!isCoding) setPickerOpen((value) => !value); setMenuOpen(false); }}
              accessibilityRole="button"
              accessibilityLabel={`Runner and model: ${chipLabel || "not selected"}`}
              accessibilityState={{ expanded: pickerOpen }}
              style={({ pressed }) => [styles.runnerChip, pressed && styles.pressed]}
            >
              <Ionicons name="sparkles" size={13} color="#a8a9ff" />
              <Text style={styles.runnerChipText} numberOfLines={1}>{chipLabel || "Choose runner and model"}</Text>
              <Ionicons name={pickerOpen ? "chevron-up" : "chevron-down"} size={13} color="rgba(255,255,255,0.55)" />
            </Pressable>
            {reloadNotice ? <Text style={styles.reloadNotice}>{reloadNotice}</Text> : isCoding ? (
              <Text style={styles.reloadNotice}>Runner is coding · minimize Vibing to keep testing</Text>
            ) : null}

            {menuOpen ? (
              <View style={styles.actionShelf} testID="browser-vibe-actions">
                <Pressable onPress={() => void reload("fast")} disabled={busy} style={styles.actionItem}>
                  <Ionicons name="flash-outline" size={18} color="#a8a9ff" />
                  <Text style={styles.actionText}>Hot Reload</Text>
                </Pressable>
                <Pressable onPress={() => void reload("full")} disabled={busy} style={styles.actionItem}>
                  <Ionicons name="reload-outline" size={18} color="#a8a9ff" />
                  <Text style={styles.actionText}>Full Reload</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setOpen(false); setMenuOpen(false); onExitPreview(); }}
                  style={[styles.actionItem, styles.exitAction]}
                  accessibilityRole="button"
                  accessibilityLabel="Exit preview and return to Yaver"
                >
                  <Ionicons name="exit-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>Exit Preview</Text>
                </Pressable>
              </View>
            ) : null}

            {pickerOpen ? (
              <View style={styles.picker} testID="browser-vibe-runner-picker">
                {runnersLoading ? <ActivityIndicator size="small" color="#a8a9ff" /> : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionRow}>
                    {runners.map((runner) => {
                      const ready = runner.installed && runner.ready !== false;
                      const selected = runnerKey(runner.id) === selectedRunnerId;
                      return (
                        <View key={runner.id} style={[styles.option, selected && styles.optionSelected]}>
                          <Pressable onPress={() => void chooseRunner(runner)} disabled={!ready} style={styles.optionChoice}>
                            <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{runnerLabel(runner, runner.id)}</Text>
                            {!ready ? <Text style={styles.optionMeta}>{runner.error || runner.warning || (runner.installed ? "sign-in or configuration required" : "not installed")}</Text> : null}
                          </Pressable>
                          {!ready ? (
                            <Pressable
                              onPress={() => void repairRunner(runner)}
                              disabled={runnerSetupBusy !== null}
                              accessibilityRole="button"
                              accessibilityLabel={`${runner.installed ? "Configure" : "Install"} ${runnerLabel(runner, runner.id)}`}
                              style={styles.repairButton}
                            >
                              {runnerSetupBusy === runnerKey(runner.id) ? <ActivityIndicator size="small" color="#fff" /> : (
                                <Text style={styles.repairButtonText}>{runner.installed ? (runnerKey(runner.id) === "opencode" ? "Configure" : "Sign in") : "Install"}</Text>
                              )}
                            </Pressable>
                          ) : null}
                        </View>
                      );
                    })}
                  </ScrollView>
                )}
                {(selectedRunner?.models?.length || 0) > 0 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.optionRow}>
                    {selectedRunner!.models.map((model) => {
                      const selected = model.id === selectedModelId;
                      return (
                        <Pressable key={model.id} onPress={() => void chooseModel(model.id)} style={[styles.modelOption, selected && styles.optionSelected]}>
                          <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{model.name || model.id}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : null}
                {selectionError ? <Text style={styles.selectionError}>{selectionError}</Text> : null}
                {runnerSetupProgress ? <Text style={styles.setupProgress} numberOfLines={2}>{runnerSetupProgress}</Text> : null}
              </View>
            ) : null}

            {disconnected ? (
              <View style={styles.failureCard} testID="browser-vibe-machine-failure">
                <Ionicons name="cloud-offline-outline" size={22} color="#ffb36b" />
                <Text style={styles.failureTitle}>Machine disconnected</Text>
                <Text style={styles.failureDetail}>The preview stays available, but Yaver cannot send prompts or reload it until the machine reconnects.</Text>
                <Pressable onPress={onExitPreview} accessibilityRole="button" style={styles.failureAction}>
                  <Text style={styles.failureActionText}>Exit Preview &amp; Reconnect</Text>
                </Pressable>
              </View>
            ) : noReadyRunner ? (
              <View style={styles.failureCard} testID="browser-vibe-runner-failure">
                <Ionicons name="warning-outline" size={22} color="#ffb36b" />
                <Text style={styles.failureTitle}>Runner needs attention</Text>
                <Text style={styles.failureDetail}>Choose a coding runner above, then install, sign in, or configure it without leaving the preview.</Text>
                <Pressable onPress={() => setPickerOpen(true)} accessibilityRole="button" style={styles.failureAction}>
                  <Text style={styles.failureActionText}>Open Runner Setup</Text>
                </Pressable>
              </View>
            ) : (
              <StudioChatPane
                key={conversationKey}
                compact
                feedbackStyle
                projectPath={projectPath}
                projectName={projectName}
                runner={selectedRunnerId || savedRunner || undefined}
                model={selectedModelId || savedModel || undefined}
                onTaskStateChange={setActiveTask}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      <RunnerAuthModal
        visible={runnerAuthFor !== null}
        runner={runnerAuthFor || "codex"}
        deviceName={activeDevice?.name || "selected machine"}
        onClose={() => setRunnerAuthFor(null)}
        onCompleted={() => { setRunnerAuthFor(null); void loadRunners(); }}
      />
      <OpenCodeConfigModal
        visible={showOpenCodeConfig}
        onClose={() => { setShowOpenCodeConfig(false); void loadRunners(); }}
      />

      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={open ? "Minimize Vibing" : "Open Vibing"}
        accessibilityState={{ expanded: open }}
        testID="browser-vibe-bubble"
        style={({ pressed }) => [
          styles.bubble,
          { bottom: Math.max(insets.bottom + 14, 18) },
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.bubbleText}>{open ? "−" : "Y"}</Text>
        {!open ? <View style={styles.liveDot} /> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject, zIndex: 200, elevation: 200 },
  keyboardLayer: { ...StyleSheet.absoluteFillObject },
  panelPosition: { flex: 1, justifyContent: "flex-end", paddingHorizontal: 12 },
  panel: {
    height: "78%",
    maxHeight: 680,
    minHeight: 300,
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: "#0e0c1c",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(168,169,255,0.35)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.38,
    shadowRadius: 22,
    elevation: 24,
  },
  handleWrap: { alignItems: "center", paddingTop: 7 },
  handle: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.22)" },
  panelHeader: {
    minHeight: 50,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.09)",
  },
  titleWrap: { flex: 1, minWidth: 0 },
  panelTitle: { color: "#fff", fontSize: 17, fontWeight: "800" },
  panelSubtitle: { color: "rgba(255,255,255,0.42)", fontSize: 11, marginTop: 1 },
  headerButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  runnerChip: {
    marginHorizontal: 12,
    marginVertical: 8,
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(139,141,248,0.14)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(139,141,248,0.35)",
  },
  runnerChipText: { color: "#d9d9ff", fontSize: 12, fontWeight: "700", flex: 1 },
  actionShelf: { flexDirection: "row", gap: 7, paddingHorizontal: 12, paddingBottom: 8 },
  actionItem: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
  },
  exitAction: { backgroundColor: "rgba(117,104,248,0.24)", borderColor: "rgba(139,141,248,0.45)" },
  actionText: { color: "rgba(255,255,255,0.82)", fontSize: 11, fontWeight: "700" },
  picker: { paddingHorizontal: 12, paddingBottom: 8, gap: 6 },
  optionRow: { gap: 7, alignItems: "stretch" },
  option: { minHeight: 42, flexDirection: "row", alignItems: "center", paddingLeft: 11, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)" },
  optionChoice: { flex: 1, minWidth: 110, justifyContent: "center", paddingVertical: 7, paddingRight: 7 },
  modelOption: { minHeight: 34, justifyContent: "center", paddingHorizontal: 10, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.09)" },
  optionSelected: { backgroundColor: "rgba(139,141,248,0.22)", borderColor: "#8b8df8" },
  optionText: { color: "rgba(255,255,255,0.72)", fontSize: 12, fontWeight: "600" },
  optionTextSelected: { color: "#fff" },
  optionMeta: { color: "rgba(255,255,255,0.35)", fontSize: 9, marginTop: 2 },
  selectionError: { color: "#ff8b8b", fontSize: 11 },
  setupProgress: { color: "rgba(255,255,255,0.56)", fontSize: 10, lineHeight: 14 },
  repairButton: { minHeight: 40, minWidth: 58, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "rgba(255,255,255,0.14)" },
  repairButtonText: { color: "#d9d9ff", fontSize: 10, fontWeight: "800" },
  failureCard: { margin: 12, padding: 16, borderRadius: 16, alignItems: "center", gap: 7, backgroundColor: "rgba(255,179,107,0.09)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,179,107,0.32)" },
  failureTitle: { color: "#fff", fontSize: 16, fontWeight: "800" },
  failureDetail: { color: "rgba(255,255,255,0.58)", fontSize: 12, lineHeight: 17, textAlign: "center" },
  failureAction: { marginTop: 5, minHeight: 42, paddingHorizontal: 16, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#6f58f5" },
  failureActionText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  reloadNotice: { color: "rgba(168,169,255,0.82)", fontSize: 11, paddingHorizontal: 14, paddingBottom: 7 },
  bubble: {
    position: "absolute",
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#6f58f5",
    shadowColor: "#6f58f5",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.42,
    shadowRadius: 10,
    elevation: 20,
  },
  bubbleText: { color: "#fff", fontSize: 25, fontWeight: "900", fontStyle: "italic" },
  liveDot: { position: "absolute", right: 7, top: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: "#48e58b" },
  pressed: { opacity: 0.74 },
  disabled: { opacity: 0.42 },
  hidden: { display: "none" },
});
