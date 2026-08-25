// StudioChatPane.tsx — the RIGHT pane of the tablet Vibe Studio.
//
// A lean chat/composer/live-console pane for tablet vibe sessions. It
// deliberately reuses the app's shared task and console primitives
// instead of re-deriving them:
//   - streamTaskOutput (quic.ts) for the raw runner stdout SSE lane
//   - summarizeRawConsole + AnsiConsoleText for the foldable live console
//   - MessageBubble for user/assistant rows
//   - executeVibingSuggestion once, then continueTask for one conversation
// The pane talks to the connected box exactly like the Tasks screen does;
// finished consoles fold quietly while live output remains one tap away.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { summarizeRawConsole } from "../../_core/ansi";
import { AnsiConsoleText } from "../AnsiConsoleText";
import { MessageBubble } from "../MessageBubble";
import { quicClient, type Task } from "../../lib/quic";
import { useColors } from "../../context/ThemeContext";
import { useDevice } from "../../context/DeviceContext";

interface StudioChatPaneProps {
  /** Selected project the vibe prompt runs against (box-side workDir). */
  projectPath?: string;
  projectName?: string;
  onRequestProject?: () => void;
  previewLogs?: readonly string[];
  previewLogsLive?: boolean;
  /** Bubble/sheet host: conversation only, without project/task inventory. */
  compact?: boolean;
  /** Feedback-style host chrome used over a running guest preview. */
  feedbackStyle?: boolean;
  /** Explicit runner/model selected in the preview card. */
  runner?: string;
  model?: string;
  /** Lets the preview host queue reloads and lock routing while coding. */
  onTaskStateChange?: (task: Task | null) => void;
}

type ChatRow =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string };

export function StudioChatPane({
  projectPath,
  projectName,
  onRequestProject,
  previewLogs = [],
  previewLogsLive = false,
  compact = false,
  feedbackStyle = false,
  runner,
  model,
  onTaskStateChange,
}: StudioChatPaneProps) {
  const theme = useColors();
  // Browser-preview Vibing is the React-Native twin of the native
  // YaverFeedbackPane. Keep its transcript/composer dark and purple even when
  // the host app uses the light theme, so opening the same Y affordance does
  // not produce two unrelated products depending on the render lane.
  const c = feedbackStyle ? {
    ...theme,
    bg: "#0e0c1c",
    bgCard: "#151128",
    bgInput: "rgba(255,255,255,0.08)",
    surface: "#19152c",
    surfaceMuted: "#171329",
    border: "rgba(255,255,255,0.15)",
    borderSubtle: "rgba(255,255,255,0.10)",
    textPrimary: "#ffffff",
    textSecondary: "rgba(255,255,255,0.78)",
    textMuted: "rgba(255,255,255,0.58)",
    textTertiary: "rgba(255,255,255,0.38)",
    accent: "#8b8df8",
    accentSoft: "rgba(139,141,248,0.16)",
    brandPrimary: "#7568f8",
  } : theme;
  const { activeDevice, connectionStatus } = useDevice();
  const connected = connectionStatus === "connected" && !!activeDevice;

  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showTasks, setShowTasks] = useState(false);
  const [rawText, setRawText] = useState("");
  const [rawLive, setRawLive] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(false);
  const [previewLogsExpanded, setPreviewLogsExpanded] = useState(false);
  const [lastRawVersion, setLastRawVersion] = useState(0);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const streamAbortRef = useRef<null | (() => void)>(null);
  const listScrollRef = useRef<ScrollView>(null);
  const consolePreferenceRef = useRef<boolean | null>(null);
  const projectPathRef = useRef(projectPath);

  // Refresh the recent-task list when the pane mounts and after each send.
  const refreshTasks = useCallback(async () => {
    if (!connected) return;
    setLoadingTasks(true);
    try {
      const list = await quicClient.listTasks();
      setTasks(list.slice(0, 12));
    } catch {
      // keep the last list; the surface is advisory
    } finally {
      setLoadingTasks(false);
    }
  }, [connected]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  // Tear down any live stream when the pane unmounts.
  useEffect(() => {
    return () => {
      streamAbortRef.current?.();
    };
  }, []);

  const subscribeTask = useCallback((taskId: string, status?: Task["status"]) => {
    streamAbortRef.current?.();
    setRawText("");
    setRawLive(false);
    setLastRawVersion((v) => v + 1);
    consolePreferenceRef.current = null;
    setConsoleExpanded(status === "running" || status === "queued");
    // Seed with the retained tail (rawSince=0 → raw_replay full=true) so a
    // just-finished task paints its console immediately.
    streamAbortRef.current = quicClient.streamTaskOutput(
      taskId,
      () => {
        // groomed transcript already lives in the task; we show raw only
      },
      (status) => {
        setRawLive(false);
        setActiveTask((prev) => prev?.id === taskId ? { ...prev, status: status as Task["status"] } : prev);
        if (consolePreferenceRef.current === null) setConsoleExpanded(false);
        setLastRawVersion((v) => v + 1);
        void quicClient.getTask(taskId).then((task) => {
          setActiveTask(task);
          setRows([]);
        }).catch(() => {});
        void refreshTasks();
      },
      (evt) => {
        if (!evt || typeof evt.type !== "string") return;
        if (evt.type === "runtime_render_requested") return;
      },
      {
        rawSince: 0,
        onRaw: (text, _offset, full) => {
          setRawText((prev) => {
            const next = full ? text : prev + text;
            return next.length > 512 * 1024 ? next.slice(next.length - 512 * 1024) : next;
          });
          setRawLive(true);
          setActiveTask((prev) => prev?.id === taskId ? { ...prev, status: "running" } : prev);
          if (consolePreferenceRef.current === null) setConsoleExpanded(true);
          setLastRawVersion((v) => v + 1);
        },
        onEnd: () => setRawLive(false),
      },
    );
  }, [refreshTasks]);

  const handleSend = useCallback(async () => {
    const text = composerText.trim();
    if (!text || sending || !connected) return;
    setComposerText("");
    setSending(true);
    setSendError(null);
    setRows((prev) => [...prev, { kind: "user", text }]);
    try {
      if (activeTask) {
        // A chat stays one task. Creating a fresh /vibing/execute task for every
        // message made the Studio look conversational while discarding context.
        await quicClient.continueTask(activeTask.id, text);
        setActiveTask((prev) => prev ? { ...prev, status: "running" } : prev);
        subscribeTask(activeTask.id, "running");
      } else {
        const result = await quicClient.executeVibingSuggestion(text, projectPath || "", {
          projectName,
          runner,
          model,
        });
        const taskId = (result as any)?.taskId;
        if (taskId) {
          const now = Date.now();
          setActiveTask({ id: String(taskId), title: text, description: "", status: "queued", output: [], createdAt: now, updatedAt: now });
          subscribeTask(String(taskId), "queued");
          void quicClient.getTask(String(taskId)).then((task) => {
            setActiveTask(task);
            if (task.turns?.length) setRows([]);
          }).catch(() => {});
        } else {
          setRows((prev) => [...prev, { kind: "system", text: result?.message || "Sent — no task id returned." }]);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not send";
      // A rejected prompt was never part of the conversation. Restore it to
      // the composer so retrying does not require retyping it.
      setRows((prev) => prev.slice(0, -1));
      setComposerText(text);
      setSendError(msg);
    } finally {
      setSending(false);
      void refreshTasks();
    }
  }, [composerText, sending, connected, projectPath, projectName, runner, model, subscribeTask, refreshTasks, activeTask]);

  const handleTaskTap = useCallback(
    (task: Task) => {
      setActiveTask(task);
      setRows([]);
      void quicClient.getTask(task.id).then((hydrated) => setActiveTask(hydrated)).catch(() => {});
      subscribeTask(task.id, task.status);
    },
    [subscribeTask],
  );

  const isRunning = activeTask?.status === "running" || activeTask?.status === "queued";
  const isRenderable = activeTask?.status === "completed" || activeTask?.status === "review";
  const consoleStatus = activeTask?.status === "failed" || activeTask?.status === "stopped"
    ? `○ ${activeTask.status}`
    : isRenderable
      ? "○ done"
      : "○ idle";
  const conversationRows = useMemo<ChatRow[]>(() => {
    const hydrated: ChatRow[] = (activeTask?.turns || []).map((turn) => ({
      kind: turn.role === "user" ? "user" : "assistant",
      text: turn.content,
    }));
    return [...hydrated, ...rows];
  }, [activeTask?.turns, rows]);

  const resetConversation = useCallback(() => {
    streamAbortRef.current?.();
    streamAbortRef.current = null;
    setActiveTask(null);
    setRows([]);
    setRawText("");
    setRawLive(false);
    setSendError(null);
    consolePreferenceRef.current = null;
    setConsoleExpanded(false);
  }, []);

  useEffect(() => {
    if (projectPathRef.current === projectPath) return;
    projectPathRef.current = projectPath;
    resetConversation();
  }, [projectPath, resetConversation]);

  useEffect(() => {
    onTaskStateChange?.(activeTask);
  }, [activeTask, onTaskStateChange]);

  return (
    <View style={[styles.wrap, { backgroundColor: c.bg }]}>
      {/* Header strip: box + project + task-list toggle */}
      {!compact ? <View style={[styles.header, { borderBottomColor: c.borderSubtle }]}>
        <View style={styles.headerChips}>
          <View style={[styles.chip, { backgroundColor: connected ? c.successBg : c.surfaceMuted, borderColor: connected ? c.successBorder : c.borderSubtle }]}>
            <View style={[styles.dot, { backgroundColor: connected ? c.success : c.textTertiary }]} />
            <Text style={[styles.chipText, { color: connected ? c.success : c.textMuted }]} numberOfLines={1}>
              {connected ? activeDevice?.name || "box" : "disconnected"}
            </Text>
          </View>
          {projectName ? (
            <Pressable onPress={onRequestProject} style={[styles.chip, { backgroundColor: c.accentSoft, borderColor: c.borderSubtle }]}>
              <Ionicons name="folder-open" size={12} color={c.accent} />
              <Text style={[styles.chipText, { color: c.accent }]} numberOfLines={1}>
                {projectName}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          {activeTask ? (
            <Pressable
              onPress={resetConversation}
              hitSlop={8}
              style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="New conversation"
            >
              <Ionicons name="add-circle-outline" size={19} color={c.textSecondary} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setShowTasks((v) => !v)}
            hitSlop={8}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={showTasks ? "Hide task list" : "Show task list"}
          >
            <Ionicons name={showTasks ? "list" : "list-outline"} size={18} color={c.textSecondary} />
          </Pressable>
        </View>
      </View> : null}

      {/* Task list (foldable, advisory) */}
      {!compact && showTasks ? (
        <ScrollView
          style={[styles.taskList, { borderBottomColor: c.borderSubtle, backgroundColor: c.surfaceMuted }]}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {loadingTasks ? <ActivityIndicator size="small" color={c.textMuted} style={{ padding: 12 }} /> : null}
          {tasks.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => handleTaskTap(t)}
              style={[styles.taskRow, activeTask?.id === t.id && { backgroundColor: c.accentSoft }]}
            >
              <View style={[styles.taskDot, { backgroundColor: t.status === "running" || t.status === "queued" ? c.warn : t.status === "completed" ? c.success : c.textTertiary }]} />
              <Text style={[styles.taskTitle, { color: c.textPrimary }]} numberOfLines={1}>
                {t.title || "task"}
              </Text>
              <Text style={[styles.taskStatus, { color: c.textMuted }]}>{t.status}</Text>
            </Pressable>
          ))}
          {tasks.length === 0 && !loadingTasks ? (
            <Text style={[styles.taskEmpty, { color: c.textMuted }]}>No tasks yet — send a vibe prompt below.</Text>
          ) : null}
        </ScrollView>
      ) : null}

      {/* Conversation / live console */}
      <ScrollView
        ref={listScrollRef}
        style={styles.conversation}
        contentContainerStyle={styles.conversationContent}
        onContentSizeChange={() => listScrollRef.current?.scrollToEnd({ animated: true })}
      >
        {/* Dev-server output belongs beside the preview, not hidden behind its
            loading layer. Keep it folded by default like web UI sections; the
            latest line remains readable without covering the app. */}
        {previewLogsLive || previewLogs.length > 0 ? (
          <View style={[styles.consoleWrap, { borderColor: c.border }]}>
            <Pressable
              onPress={() => setPreviewLogsExpanded((value) => !value)}
              style={({ pressed }) => [styles.consoleToggle, { backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityLabel={previewLogsExpanded ? "Hide preview logs" : "Show preview logs"}
              accessibilityState={{ expanded: previewLogsExpanded }}
            >
              <Text style={[styles.consoleCaret, { color: c.textMuted }]}>{previewLogsExpanded ? "▼" : "▶"}</Text>
              <Text style={[styles.consoleTitle, { color: c.textSecondary }]}>Logs</Text>
              {!previewLogsExpanded && previewLogs.length > 0 ? (
                <Text style={[styles.previewLogLatest, { color: c.textTertiary }]} numberOfLines={1}>
                  {previewLogs[previewLogs.length - 1]}
                </Text>
              ) : null}
              <Text style={[styles.consoleDot, { color: previewLogsLive ? "#4ade80" : c.textTertiary }]}>
                {previewLogsLive ? "● live" : "○ idle"}
              </Text>
            </Pressable>
            {previewLogsExpanded ? (
              <ScrollView
                style={[styles.previewLogBody, { backgroundColor: c.bgCard, borderTopColor: c.border }]}
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {previewLogs.length > 0 ? (
                  <AnsiConsoleText text={previewLogs.join("\n")} fontSize={11} />
                ) : (
                  <Text style={{ color: c.textTertiary, fontSize: 12 }}>Waiting for dev-server output…</Text>
                )}
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        {conversationRows.length === 0 && !rawText.trim() ? (
          <Text style={[styles.emptyHint, { color: c.textTertiary }]}>
            {connected
              ? `Type a vibe prompt — ${[runner, model].filter(Boolean).join(" · ") || "the box's runner"} will edit the project and the live console will show it working.`
              : "Connect a box to start vibing."}
          </Text>
        ) : null}
        {conversationRows.map((row, i) => {
          if (row.kind === "user") return <MessageBubble key={i} variant="user" content={row.text} mono />;
          if (row.kind === "assistant") return <MessageBubble key={i} variant="tool" content={row.text} />;
          return <MessageBubble key={i} variant="system" content={row.text} />;
        })}

        {/* Foldable live console — same grammar as the opencode console */}
        {activeTask || rawText.trim() ? (
          <View style={[styles.consoleWrap, { borderColor: c.border }]}>
            <Pressable
              onPress={() => setConsoleExpanded((v) => {
                consolePreferenceRef.current = !v;
                return !v;
              })}
              style={({ pressed }) => [styles.consoleToggle, { backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityState={{ expanded: consoleExpanded }}
            >
              <Text style={[styles.consoleCaret, { color: c.textMuted }]}>{consoleExpanded ? "▼" : "▶"}</Text>
              <Text style={[styles.consoleTitle, { color: c.textSecondary }]}>Console</Text>
              {rawLive && isRunning ? (
                <Text style={[styles.consoleDot, { color: "#4ade80" }]}>● live</Text>
              ) : (
                <Text style={[styles.consoleDot, { color: activeTask?.status === "failed" ? c.error : c.textTertiary }]}>{consoleStatus}</Text>
              )}
              <Text style={[styles.consoleCount, { color: c.textTertiary }]}>
                {rawText.length > 1024 ? `${Math.round(rawText.length / 1024)} KB` : `${rawText.length} B`}
              </Text>
            </Pressable>
            {consoleExpanded ? (
              <ScrollView
                style={[styles.consoleBody, { backgroundColor: c.bgCard, borderTopColor: c.border }]}
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {/* re-render on rawVersion so streaming frames repaint */}
                {rawText.trim() ? (
                  <AnsiConsoleText key={lastRawVersion} text={summarizeRawConsole(rawText, isRunning)} fontSize={11} />
                ) : (
                  <Text style={{ color: c.textTertiary, fontSize: 12 }}>
                    {isRunning ? "Waiting for runner output…" : "No console output was retained for this task."}
                  </Text>
                )}
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        {sending ? (
          <View style={styles.sendingRow}>
            <ActivityIndicator size="small" color={c.accent} />
            <Text style={{ color: c.textMuted, fontSize: 13 }}>Sending…</Text>
          </View>
        ) : null}
        {sendError ? <MessageBubble variant="error" content={sendError} /> : null}
      </ScrollView>

      {/* Composer */}
      <View style={[styles.composer, { borderTopColor: c.borderSubtle }]}>
        <TextInput
          style={[styles.input, { backgroundColor: c.bgInput, color: c.textPrimary, borderColor: c.borderSubtle }]}
          value={composerText}
          onChangeText={setComposerText}
          placeholder={!connected ? "Connect a box first" : isRunning ? "Runner is coding…" : activeTask ? "Continue this task…" : "What should we change?"}
          placeholderTextColor={c.textTertiary}
          multiline
          editable={connected && !isRunning}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={handleSend}
          disabled={!connected || isRunning || sending || !composerText.trim()}
          style={[styles.sendBtn, { backgroundColor: c.brandPrimary }, (!connected || isRunning || sending || !composerText.trim()) && { opacity: 0.4 }]}
          accessibilityRole="button"
          accessibilityLabel="Send vibe prompt"
        >
          <Ionicons name="arrow-up" size={18} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerChips: { flexDirection: "row", gap: 6, flex: 1, minWidth: 0 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: "48%",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 12, fontWeight: "700", flexShrink: 1 },
  iconBtn: { padding: 6 },
  taskList: {
    maxHeight: 180,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  taskDot: { width: 7, height: 7, borderRadius: 4 },
  taskTitle: { flex: 1, fontSize: 13, fontWeight: "600" },
  taskStatus: { fontSize: 11, textTransform: "uppercase" },
  taskEmpty: { padding: 14, fontSize: 13 },
  conversation: { flex: 1 },
  conversationContent: { padding: 12, gap: 8 },
  emptyHint: { fontSize: 13, textAlign: "center", paddingTop: 24, lineHeight: 20 },
  consoleWrap: { borderWidth: 1, borderRadius: 10, overflow: "hidden", marginTop: 4 },
  consoleToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  consoleCaret: { fontSize: 10 },
  consoleTitle: { fontSize: 13, fontWeight: "700" },
  previewLogLatest: { flex: 1, minWidth: 0, fontSize: 11, fontFamily: "monospace" },
  consoleDot: { fontSize: 11, fontWeight: "700", marginLeft: "auto" },
  consoleCount: { fontSize: 11 },
  consoleBody: { maxHeight: 280, padding: 10 },
  previewLogBody: { maxHeight: 220, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
  sendingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 19,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
