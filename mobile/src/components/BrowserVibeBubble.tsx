import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useDevice } from "../context/DeviceContext";
import { type RunnerInfo, type Task } from "../lib/quic";
import { connectionManager } from "../lib/connectionManager";
import { OpenCodeConfigModal } from "./OpenCodeConfigModal";
import RunnerAuthModal from "./RunnerAuthModal";
import { StudioChatPane } from "./studio/StudioChatPane";

type ReloadKind = "fast" | "full";
type VibeTab = "chat" | "settings";
type MachineRole = "runner" | "render";
type CodingProbeState = "idle" | "checking" | "reachable" | "unreachable";

const FLOATING_DOCK_WIDTH = 180;
const FLOATING_DOCK_EXCEPTION_WIDTH = 296;
const FLOATING_DOCK_HEIGHT = 56;
const FLOATING_DOCK_EDGE_GAP = 8;
const FLOATING_DOCK_DRAG_THRESHOLD = 6;

type FloatingDockPosition = { x: number; y: number };
type FloatingDockViewport = {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Keep the entire Dogfood dock reachable after a drag, rotation, or resize. */
export function clampFloatingDockPosition(
  position: FloatingDockPosition,
  viewport: FloatingDockViewport,
  dockWidth = FLOATING_DOCK_WIDTH,
): FloatingDockPosition {
  const minX = viewport.left + FLOATING_DOCK_EDGE_GAP;
  const minY = viewport.top + FLOATING_DOCK_EDGE_GAP;
  const maxX = Math.max(minX, viewport.width - viewport.right - dockWidth - FLOATING_DOCK_EDGE_GAP);
  const maxY = Math.max(minY, viewport.height - viewport.bottom - FLOATING_DOCK_HEIGHT - FLOATING_DOCK_EDGE_GAP);
  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  };
}

function initialFloatingDockPosition(viewport: FloatingDockViewport, dockWidth: number): FloatingDockPosition {
  // Start just above the common bottom-navigation lane and on the left, away
  // from the guest screen's primary FAB (normally bottom-right). The dock is
  // still freely movable because no fixed default can know a guest app's UI.
  return clampFloatingDockPosition({
    x: viewport.left + 16,
    y: viewport.height - viewport.bottom - FLOATING_DOCK_HEIGHT - 84,
  }, viewport, dockWidth);
}

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
  onFixException,
  exceptionFixBusy = false,
}: {
  projectPath?: string;
  projectName?: string;
  onExitPreview: () => void;
  onReload: (kind: ReloadKind) => boolean | void | Promise<boolean | void>;
  reloadBusy?: boolean;
  onFixException?: () => void | Promise<void>;
  exceptionFixBusy?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const {
    activeDevice,
    devices,
    connectedDeviceIds,
    primaryRunnerByDevice,
    primaryModelByDevice,
    machineRoles,
    setMachineRolesFavorite,
    setPrimaryRunnerForDevice,
    retryConnection,
  } = useDevice();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<VibeTab>("chat");
  const [machineChoicesOpen, setMachineChoicesOpen] = useState<MachineRole | null>(null);
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
  const [codingProbeState, setCodingProbeState] = useState<CodingProbeState>("idle");
  const [codingProbeError, setCodingProbeError] = useState<string | null>(null);
  const [dockViewportSize, setDockViewportSize] = useState({ width: 0, height: 0 });
  const [dockReady, setDockReady] = useState(false);
  const dockWidth = onFixException ? FLOATING_DOCK_EXCEPTION_WIDTH : FLOATING_DOCK_WIDTH;
  const dockPosition = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const dockPointRef = useRef<FloatingDockPosition>({ x: 0, y: 0 });
  const dockDragOriginRef = useRef<FloatingDockPosition>({ x: 0, y: 0 });
  const dockWasPositionedRef = useRef(false);
  const dockViewportRef = useRef<FloatingDockViewport>({
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });

  useEffect(() => {
    if (dockViewportSize.width <= 0 || dockViewportSize.height <= 0) return;
    const viewport: FloatingDockViewport = {
      ...dockViewportSize,
      top: insets.top,
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left,
    };
    dockViewportRef.current = viewport;
    const next = dockWasPositionedRef.current
      ? clampFloatingDockPosition(dockPointRef.current, viewport, dockWidth)
      : initialFloatingDockPosition(viewport, dockWidth);
    dockWasPositionedRef.current = true;
    dockPointRef.current = next;
    dockPosition.setValue(next);
    setDockReady(true);
  }, [dockPosition, dockViewportSize, dockWidth, insets.bottom, insets.left, insets.right, insets.top]);

  const dockPanResponder = useMemo(() => PanResponder.create({
    // A tap remains a tap on either Pressable. Only a deliberate move claims
    // the responder, at which point both controls travel as one compact dock.
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) =>
      Math.abs(gesture.dx) > FLOATING_DOCK_DRAG_THRESHOLD || Math.abs(gesture.dy) > FLOATING_DOCK_DRAG_THRESHOLD,
    onPanResponderGrant: () => {
      dockDragOriginRef.current = dockPointRef.current;
    },
    onPanResponderMove: (_, gesture) => {
      const next = clampFloatingDockPosition({
        x: dockDragOriginRef.current.x + gesture.dx,
        y: dockDragOriginRef.current.y + gesture.dy,
      }, dockViewportRef.current, dockWidth);
      dockPointRef.current = next;
      dockPosition.setValue(next);
    },
    onPanResponderRelease: () => {
      const next = clampFloatingDockPosition(dockPointRef.current, dockViewportRef.current, dockWidth);
      dockPointRef.current = next;
      dockPosition.setValue(next);
    },
    onPanResponderTerminate: () => {
      const next = clampFloatingDockPosition(dockPointRef.current, dockViewportRef.current, dockWidth);
      dockPointRef.current = next;
      dockPosition.setValue(next);
    },
  }), [dockPosition, dockWidth]);

  const fallbackDeviceId = activeDevice?.id || "";
  const codingDeviceId = machineRoles?.runnerDeviceId || fallbackDeviceId;
  const renderDeviceId = machineRoles?.renderDeviceId || fallbackDeviceId;
  const codingDevice = devices.find((row) => row.id === codingDeviceId) || activeDevice;
  const renderDevice = devices.find((row) => row.id === renderDeviceId) || activeDevice;
  const codingConnected = !!codingDeviceId && connectedDeviceIds.includes(codingDeviceId);
  const renderConnected = !!renderDeviceId && connectedDeviceIds.includes(renderDeviceId);
  const codingClient = useMemo(
    () => codingDeviceId ? connectionManager.clientFor(codingDeviceId) : connectionManager.runnerClient(),
    [codingDeviceId],
  );
  const savedRunner = runnerKey(codingDeviceId ? primaryRunnerByDevice[codingDeviceId] : "");
  const savedModel = codingDeviceId ? primaryModelByDevice[codingDeviceId] || "" : "";

  const loadRunners = useCallback(async () => {
    if (!codingDeviceId) {
      setCodingProbeState("unreachable");
      setCodingProbeError("No coding machine is selected.");
      return;
    }
    setCodingProbeState("checking");
    setRunnersLoading(true);
    setSelectionError(null);
    try {
      const rows = (await codingClient.getRunners()).filter((row) => ["claude", "codex", "opencode"].includes(runnerKey(row.id)));
      // This API response is the operation Vibing needs. It is stronger
      // evidence than a pooled-client badge that can lag during an RN-web
      // relay reconnect.
      setCodingProbeState("reachable");
      setCodingProbeError(null);
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
      const message = error instanceof Error ? error.message : "Could not read runner choices";
      setCodingProbeState("unreachable");
      setCodingProbeError(message);
      setSelectionError(message);
      setSelectedRunnerId(savedRunner);
      setSelectedModelId(savedModel);
    } finally {
      setRunnersLoading(false);
    }
  }, [codingClient, codingDeviceId, savedModel, savedRunner]);

  useEffect(() => {
    setCodingProbeState(codingConnected ? "reachable" : "idle");
    setCodingProbeError(null);
  }, [codingConnected, codingDeviceId]);

  useEffect(() => {
    if (!open) return;
    void loadRunners();
  }, [codingConnected, open, loadRunners]);

  useEffect(() => {
    if (!selectedRunnerId && savedRunner) setSelectedRunnerId(savedRunner);
    if (!selectedModelId && savedModel) setSelectedModelId(savedModel);
  }, [savedModel, savedRunner, selectedModelId, selectedRunnerId]);

  const selectedRunner = useMemo(
    () => runners.find((row) => runnerKey(row.id) === selectedRunnerId),
    [runners, selectedRunnerId],
  );
  const codingAvailable = codingConnected || codingProbeState === "reachable";
  const renderAvailable = renderConnected || (renderDeviceId === codingDeviceId && codingAvailable);

  const retryCodingConnection = useCallback(() => {
    setCodingProbeState("checking");
    setCodingProbeError(null);
    // Preserve the last good SFMG preview. Re-open both the global reachability
    // sweep and this exact pooled client, then probe the API in place.
    retryConnection();
    codingClient.triggerReconnect();
    void loadRunners();
  }, [codingClient, loadRunners, retryConnection]);

  const chooseRunner = useCallback(async (runner: RunnerInfo) => {
    if (!codingDeviceId || !runner.installed || runner.ready === false || activeTask?.status === "running" || activeTask?.status === "queued") return;
    const model = runner.models?.find((item) => item.isDefault) || runner.models?.[0];
    const nextRunner = runnerKey(runner.id);
    const previousRunner = selectedRunnerId;
    const previousModel = selectedModelId;
    setSelectedRunnerId(nextRunner);
    setSelectedModelId(model?.id || "");
    setSelectionError(null);
    try {
      await setPrimaryRunnerForDevice(codingDeviceId, nextRunner, model?.id || null);
      setConversationKey((value) => value + 1);
    } catch (error) {
      setSelectedRunnerId(previousRunner);
      setSelectedModelId(previousModel);
      setSelectionError(error instanceof Error ? error.message : "Could not save runner");
    }
  }, [activeTask?.status, codingDeviceId, selectedModelId, selectedRunnerId, setPrimaryRunnerForDevice]);

  const chooseModel = useCallback(async (modelId: string) => {
    if (!codingDeviceId || !selectedRunnerId || activeTask?.status === "running" || activeTask?.status === "queued") return;
    const previousModel = selectedModelId;
    setSelectedModelId(modelId);
    setSelectionError(null);
    try {
      await setPrimaryRunnerForDevice(codingDeviceId, selectedRunnerId, modelId || null);
      setConversationKey((value) => value + 1);
    } catch (error) {
      setSelectedModelId(previousModel);
      setSelectionError(error instanceof Error ? error.message : "Could not save model");
    }
  }, [activeTask?.status, codingDeviceId, selectedModelId, selectedRunnerId, setPrimaryRunnerForDevice]);

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
  const runnerSummary = runnersLoading && !selectedRunnerId
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
    if (runnerSetupBusy || !codingAvailable) return;
    if (runner.installed) {
      if (id === "opencode") setShowOpenCodeConfig(true);
      else setRunnerAuthFor(id);
      return;
    }
    setRunnerSetupBusy(id);
    setRunnerSetupProgress(`Installing ${runnerLabel(runner, id)}…`);
    setSelectionError(null);
    try {
      const result = await codingClient.installRunner(id, {
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
  }, [codingAvailable, codingClient, loadRunners, runnerSetupBusy]);

  const saveMachineRole = useCallback(async (role: "runner" | "render", nextDeviceId: string) => {
    if (isCoding) return;
    const nextRunnerDeviceId = role === "runner" ? nextDeviceId : (codingDeviceId || nextDeviceId);
    const nextRenderDeviceId = role === "render" ? nextDeviceId : (renderDeviceId || nextDeviceId);
    setSelectionError(null);
    try {
      await setMachineRolesFavorite({
        runnerDeviceId: nextRunnerDeviceId,
        renderDeviceId: nextRenderDeviceId,
        projectName: projectName || undefined,
      });
      if (role === "runner") {
        setSelectedRunnerId("");
        setSelectedModelId("");
        setConversationKey((value) => value + 1);
      } else if (nextDeviceId !== fallbackDeviceId) {
        setReloadNotice(`Render machine set to ${devices.find((row) => row.id === nextDeviceId)?.name || "selected machine"} · reload to move this surface`);
      }
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Could not save machine routing");
    }
  }, [codingDeviceId, devices, fallbackDeviceId, isCoding, projectName, renderDeviceId, setMachineRolesFavorite]);

  // Do not turn an inventory transition into a machine verdict. Only show the
  // recovery card after the actual Vibing API probe failed.
  const disconnected = !codingAvailable && codingProbeState === "unreachable";
  const noReadyRunner = !runnersLoading && runners.length > 0 && !runners.some((runner) => runner.installed && runner.ready !== false);

  return (
    <View
      pointerEvents="box-none"
      style={styles.layer}
      testID="browser-vibe-overlay"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setDockViewportSize((current) => current.width === width && current.height === height ? current : { width, height });
      }}
    >
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
                onPress={() => { setOpen(false); onExitPreview(); }}
                accessibilityRole="button"
                accessibilityLabel="Exit preview and return to Yaver"
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <Ionicons name="exit-outline" size={19} color="#777782" />
              </Pressable>
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Minimize Vibing"
                style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
              >
                <Ionicons name="remove" size={22} color="#656570" />
              </Pressable>
            </View>

            <View style={styles.tabs} testID="browser-vibe-tabs">
              {(["chat", "settings"] as const).map((tab) => (
                <Pressable
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === tab }}
                  style={[styles.tab, activeTab === tab && styles.tabSelected]}
                >
                  <Text style={[styles.tabText, activeTab === tab && styles.tabTextSelected]}>{tab === "chat" ? "Chat" : "Settings"}</Text>
                </Pressable>
              ))}
            </View>
            {reloadNotice ? <Text style={styles.reloadNotice}>{reloadNotice}</Text> : isCoding ? (
              <Text style={styles.reloadNotice}>Runner is coding · minimize Vibing to keep testing</Text>
            ) : null}

            <View style={[styles.tabBody, activeTab !== "settings" && styles.hidden]}>
              <ScrollView style={styles.settingsScroll} contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
                {(["runner", "render"] as const).map((role) => {
                  const roleDevice = role === "runner" ? codingDevice : renderDevice;
                  const roleDeviceId = role === "runner" ? codingDeviceId : renderDeviceId;
                  const roleConnected = role === "runner" ? codingAvailable : renderAvailable;
                  const choicesOpen = machineChoicesOpen === role;
                  if (machineChoicesOpen && !choicesOpen) return null;
                  return (
                    <View key={role} style={styles.settingsCard} testID={`browser-vibe-${role}-machine`}>
                      <Pressable
                        onPress={() => setMachineChoicesOpen((current) => current === role ? null : role)}
                        accessibilityRole="button"
                        accessibilityLabel={`${choicesOpen ? "Hide" : "Choose"} ${role} settings`}
                        accessibilityState={{ expanded: choicesOpen }}
                        style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}
                      >
                        <View style={styles.cardHeaderCopy}>
                          <Text style={styles.cardTitle}>{role === "runner" ? "Runner" : "Render"}</Text>
                          <Text style={styles.cardValue} numberOfLines={1}>{roleDevice?.name || "Choose device"}</Text>
                        </View>
                        <View style={styles.changeButton}>
                          <Text style={styles.changeButtonText}>{choicesOpen ? "Done" : "Change"}</Text>
                        </View>
                      </Pressable>
                      <View style={styles.currentRow}>
                        <View style={[styles.machineDot, { backgroundColor: roleConnected ? "#22c55e" : "#a7a7b0" }]} />
                        <Text style={styles.currentMeta} numberOfLines={1}>
                          {role === "runner"
                            ? `${roleConnected ? "Connected" : "Offline"} · ${runnerSummary || "Choose coding agent"}`
                            : roleConnected ? "Connected" : "Offline · tap to choose a connected machine"}
                        </Text>
                      </View>
                      {choicesOpen ? (
                        <>
                          {role === "runner" ? <Text style={styles.menuLabel}>Machine</Text> : null}
                          <View style={styles.machineList}>
                            {devices.map((device) => (
                              <Pressable
                                key={`${role}:${device.id}`}
                                onPress={() => void saveMachineRole(role, device.id)}
                                disabled={isCoding}
                                accessibilityRole="button"
                                accessibilityLabel={`Use ${device.name || device.id.slice(0, 8)} as ${role} machine`}
                                accessibilityState={{ selected: device.id === roleDeviceId, disabled: isCoding }}
                                style={[styles.machineChoice, device.id === roleDeviceId && styles.optionSelected]}
                              >
                                <View style={[styles.machineDot, { backgroundColor: connectedDeviceIds.includes(device.id) ? "#22c55e" : "#a7a7b0" }]} />
                                <Text
                                  style={[styles.machineChoiceText, device.id === roleDeviceId && styles.optionTextSelected]}
                                  numberOfLines={2}
                                >
                                  {device.name || device.id.slice(0, 8)}
                                </Text>
                                <Text style={styles.machineChoiceState}>
                                  {connectedDeviceIds.includes(device.id) ? "Connected" : "Offline"}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        </>
                      ) : null}
                      {choicesOpen && role === "runner" ? (
                        <>
                          <Text style={styles.menuLabel}>Coding agent</Text>
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
                        </>
                      ) : null}
                    </View>
                  );
                })}
                {selectionError ? <Text style={styles.selectionError}>{selectionError}</Text> : null}
                {runnerSetupProgress ? <Text style={styles.setupProgress} numberOfLines={2}>{runnerSetupProgress}</Text> : null}
              </ScrollView>
            </View>
            <View style={[styles.tabBody, activeTab !== "chat" && styles.hidden]}>
              {disconnected ? <View style={styles.failureCard} testID="browser-vibe-machine-failure">
                <Ionicons name="cloud-offline-outline" size={22} color="#ffb36b" />
                <Text style={styles.failureTitle}>Can’t reach coding machine</Text>
                <Text style={styles.failureDetail}>
                  {codingProbeError || `The ${projectName || "guest"} preview stays available while Yaver reconnects the coding lane.`}
                </Text>
                <Pressable onPress={retryCodingConnection} accessibilityRole="button" style={styles.failureAction}>
                  <Text style={styles.failureActionText}>Retry Connection</Text>
                </Pressable>
              </View> : noReadyRunner ? <View style={styles.failureCard} testID="browser-vibe-runner-failure">
                <Ionicons name="warning-outline" size={22} color="#ffb36b" />
                <Text style={styles.failureTitle}>Runner needs attention</Text>
                <Text style={styles.failureDetail}>Choose, install, sign in, or configure a coding runner without leaving the preview.</Text>
                <Pressable onPress={() => { setActiveTab("settings"); setMachineChoicesOpen("runner"); }} accessibilityRole="button" style={styles.failureAction}>
                  <Text style={styles.failureActionText}>Open Runner Setup</Text>
                </Pressable>
              </View> : (
              <StudioChatPane
                key={conversationKey}
                compact
                feedbackStyle
                projectPath={projectPath}
                projectName={projectName}
                runner={selectedRunnerId || savedRunner || undefined}
                model={selectedModelId || savedModel || undefined}
                client={codingClient}
                clientConnected={codingAvailable}
                codingMachineName={codingDevice?.name}
                onTaskStateChange={setActiveTask}
              />
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <RunnerAuthModal
        visible={runnerAuthFor !== null}
        runner={runnerAuthFor || "codex"}
        deviceName={codingDevice?.name || "coding machine"}
        target={codingDeviceId && codingDeviceId !== fallbackDeviceId ? codingDeviceId : undefined}
        onClose={() => setRunnerAuthFor(null)}
        onCompleted={() => { setRunnerAuthFor(null); void loadRunners(); }}
      />
      <OpenCodeConfigModal
        visible={showOpenCodeConfig}
        target={codingDeviceId && codingDeviceId !== fallbackDeviceId ? codingDeviceId : undefined}
        onClose={() => { setShowOpenCodeConfig(false); void loadRunners(); }}
      />

      {!open ? <Animated.View
        {...dockPanResponder.panHandlers}
        pointerEvents="box-none"
        testID="browser-vibe-dock"
        accessibilityLabel="Dogfood controls"
        accessibilityHint="Drag to move Fast Reload and Vibing together"
        style={[
          styles.floatingDock,
          { width: dockWidth, opacity: dockReady ? 1 : 0, transform: [{ translateX: dockPosition.x }, { translateY: dockPosition.y }] },
        ]}
      >
        <Pressable
          onPress={() => void reload("fast")}
          disabled={busy || !renderAvailable}
          accessibilityRole="button"
          accessibilityLabel={isCoding ? "Queue fast reload after coding" : "Fast reload preview"}
          accessibilityHint="Drag to move the Dogfood controls"
          testID="browser-vibe-fast-reload"
          style={({ pressed }) => [
            styles.reloadBubble,
            (busy || !renderAvailable) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          {busy ? <ActivityIndicator size="small" color="#6f58f5" /> : <Ionicons name="reload-outline" size={18} color="#6f58f5" />}
          <Text style={styles.reloadBubbleText}>Fast Reload</Text>
        </Pressable>

        {onFixException ? (
          <Pressable
            onPress={() => void onFixException()}
            disabled={exceptionFixBusy}
            accessibilityRole="button"
            accessibilityLabel="Fix captured preview exception"
            accessibilityHint="Starts a coding task with the captured URL and stack trace"
            testID="browser-vibe-fix-exception"
            style={({ pressed }) => [
              styles.fixExceptionBubble,
              exceptionFixBusy && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {exceptionFixBusy
              ? <ActivityIndicator size="small" color="#d94b5e" />
              : <Ionicons name="build-outline" size={17} color="#d94b5e" />}
            <Text style={styles.fixExceptionText}>Fix exception</Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={() => setOpen((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={open ? "Minimize Vibing" : "Open Vibing"}
          accessibilityHint="Drag to move the Dogfood controls"
          accessibilityState={{ expanded: open }}
          testID="browser-vibe-bubble"
          style={({ pressed }) => [
            styles.bubble,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.bubbleText}>{open ? "−" : "Y"}</Text>
          {!open ? <View style={styles.liveDot} /> : null}
        </Pressable>
      </Animated.View> : null}
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
    backgroundColor: "#f8f8fb",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#dedee7",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 22,
    elevation: 24,
  },
  handleWrap: { alignItems: "center", paddingTop: 7 },
  handle: { width: 38, height: 4, borderRadius: 2, backgroundColor: "#c5c5cf" },
  panelHeader: {
    minHeight: 50,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5ec",
  },
  titleWrap: { flex: 1, minWidth: 0 },
  panelTitle: { color: "#17171d", fontSize: 17, fontWeight: "800" },
  panelSubtitle: { color: "#8b8b96", fontSize: 11, marginTop: 1 },
  headerButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  tabs: { flexDirection: "row", gap: 6, marginHorizontal: 12, marginTop: 8, padding: 3, borderRadius: 12, backgroundColor: "#ededf3" },
  tab: { flex: 1, minHeight: 34, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  tabSelected: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  tabText: { color: "#858590", fontSize: 12, fontWeight: "700" },
  tabTextSelected: { color: "#6252e8" },
  tabBody: { flex: 1, minHeight: 0 },
  settingsScroll: { flex: 1 },
  settingsContent: { padding: 12, paddingBottom: 18, gap: 10 },
  settingsCard: { padding: 12, gap: 9, borderRadius: 15, backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#e0e0e8" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardHeaderCopy: { flex: 1, minWidth: 0 },
  cardTitle: { color: "#898994", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  cardValue: { color: "#1d1d24", fontSize: 14, lineHeight: 19, fontWeight: "800", marginTop: 2 },
  changeButton: { minHeight: 34, paddingHorizontal: 10, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#f0efff" },
  changeButtonText: { color: "#6252e8", fontSize: 11, fontWeight: "800" },
  currentRow: { minHeight: 18, flexDirection: "row", alignItems: "center", gap: 6 },
  currentMeta: { flex: 1, color: "#777782", fontSize: 10, fontWeight: "600" },
  menuLabel: { color: "#898994", fontSize: 9, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  machineList: { width: "100%", gap: 7 },
  machineChoice: { width: "100%", minHeight: 46, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: "#f5f5f8", borderWidth: 1, borderColor: "#e6e6ec" },
  machineChoiceText: { flex: 1, minWidth: 0, color: "#5e5e68", fontSize: 12, lineHeight: 16, fontWeight: "700" },
  machineChoiceState: { color: "#91919b", fontSize: 9, fontWeight: "700" },
  machineDot: { width: 7, height: 7, borderRadius: 4 },
  optionRow: { gap: 7, alignItems: "stretch" },
  option: { minHeight: 42, flexDirection: "row", alignItems: "center", paddingLeft: 11, borderRadius: 10, backgroundColor: "#fff", borderWidth: 1, borderColor: "#e3e3e9" },
  optionChoice: { flex: 1, minWidth: 110, justifyContent: "center", paddingVertical: 7, paddingRight: 7 },
  modelOption: { minHeight: 34, justifyContent: "center", paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#fff", borderWidth: 1, borderColor: "#e3e3e9" },
  optionSelected: { backgroundColor: "#eceaff", borderColor: "#8b8df8" },
  optionText: { color: "#5e5e68", fontSize: 12, fontWeight: "600" },
  optionTextSelected: { color: "#5e4ce6" },
  optionMeta: { color: "#9999a3", fontSize: 9, marginTop: 2 },
  selectionError: { color: "#ff8b8b", fontSize: 11 },
  setupProgress: { color: "#757580", fontSize: 10, lineHeight: 14 },
  repairButton: { minHeight: 40, minWidth: 58, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "#e1e1e8" },
  repairButtonText: { color: "#6654e8", fontSize: 10, fontWeight: "800" },
  failureCard: { margin: 12, padding: 16, borderRadius: 16, alignItems: "center", gap: 7, backgroundColor: "#fff8ef", borderWidth: StyleSheet.hairlineWidth, borderColor: "#f0c898" },
  failureTitle: { color: "#28282f", fontSize: 16, fontWeight: "800" },
  failureDetail: { color: "#6f6f79", fontSize: 12, lineHeight: 17, textAlign: "center" },
  failureAction: { marginTop: 5, minHeight: 42, paddingHorizontal: 16, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#6f58f5" },
  failureActionText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  reloadNotice: { color: "#6555df", fontSize: 11, paddingHorizontal: 14, paddingTop: 6 },
  floatingDock: {
    position: "absolute",
    left: 0,
    top: 0,
    width: FLOATING_DOCK_WIDTH,
    height: FLOATING_DOCK_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reloadBubble: {
    width: 116,
    height: 56,
    paddingHorizontal: 14,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#dedee7",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 9,
    elevation: 19,
  },
  reloadBubbleText: { color: "#5e4ce6", fontSize: 12, fontWeight: "800" },
  fixExceptionBubble: {
    width: 108,
    height: 56,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#f0bcc4",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 9,
    elevation: 19,
  },
  fixExceptionText: { color: "#c93f52", fontSize: 11, fontWeight: "900" },
  bubble: {
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
