import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDevice } from "../../src/context/DeviceContext";
import {
  ConnectionState,
  quicClient,
  Task,
  TaskStatus,
} from "../../src/lib/quic";

// ── Constants ────────────────────────────────────────────────────────

const STATUS_COLORS: Record<TaskStatus, string> = {
  queued: "#eab308",
  running: "#6366f1",
  completed: "#22c55e",
  failed: "#ef4444",
  stopped: "#a1a1aa",
};

const BANNER_CONFIG: Record<
  ConnectionState,
  { bg: string; border: string; dot: string; text: string; label: string }
> = {
  connected: {
    bg: "#0d1a0d",
    border: "#1a2e1a",
    dot: "#22c55e",
    text: "#4ade80",
    label: "Connected",
  },
  connecting: {
    bg: "#1a1a0d",
    border: "#2e2e1a",
    dot: "#eab308",
    text: "#facc15",
    label: "Connecting",
  },
  error: {
    bg: "#1a0d0d",
    border: "#2e1a1a",
    dot: "#ef4444",
    text: "#f87171",
    label: "Connection lost",
  },
  disconnected: {
    bg: "#111",
    border: "#222",
    dot: "#666",
    text: "#666",
    label: "Disconnected",
  },
};

const SWIPE_THRESHOLD = -80;

// ── Swipeable task row ───────────────────────────────────────────────

function SwipeableTaskRow({
  item,
  onPress,
  onDelete,
}: {
  item: Task;
  onPress: () => void;
  onDelete: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const canSwipe = item.status === "completed" || item.status === "failed";

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        canSwipe && Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => {
        if (gesture.dx < 0) {
          translateX.setValue(gesture.dx);
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx < SWIPE_THRESHOLD) {
          Animated.timing(translateX, {
            toValue: -300,
            duration: 200,
            useNativeDriver: true,
          }).start(() => onDelete());
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const lastOutput =
    item.status === "running" && item.output.length > 0
      ? item.output[item.output.length - 1]
      : null;

  return (
    <View style={styles.swipeContainer}>
      {/* Delete background */}
      {canSwipe && (
        <View style={styles.deleteBackground}>
          <Text style={styles.deleteBackgroundText}>Delete</Text>
        </View>
      )}

      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...(canSwipe ? panResponder.panHandlers : {})}
      >
        <Pressable
          style={({ pressed }) => [
            styles.taskCard,
            pressed && styles.taskCardPressed,
          ]}
          onPress={onPress}
        >
          <View style={styles.taskHeader}>
            <View
              style={[
                styles.statusBadge,
                { backgroundColor: STATUS_COLORS[item.status] + "22" },
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  { color: STATUS_COLORS[item.status] },
                ]}
              >
                {item.status}
              </Text>
            </View>
            {item.deviceName ? (
              <View style={styles.deviceBadge}>
                <Text style={styles.deviceBadgeText}>{item.deviceName}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.taskTitle}>{item.title}</Text>
          {item.description && !lastOutput ? (
            <Text style={styles.taskDesc} numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
          {lastOutput ? (
            <Text style={styles.taskOutputPreview} numberOfLines={1}>
              {lastOutput}
            </Text>
          ) : null}
          <Text style={styles.taskTimestamp}>
            {formatRelativeTime(item.updatedAt)}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Main screen ──────────────────────────────────────────────────────

export default function TasksScreen() {
  const { connectionStatus, activeDevice } = useDevice();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quicState, setQuicState] = useState<ConnectionState>(
    quicClient.connectionState
  );

  // Track QUIC connection state independently for the banner
  useEffect(() => {
    const unsub = quicClient.on("connectionState", (state) => {
      setQuicState(state);
    });
    return unsub;
  }, []);

  // Fetch tasks (works offline via cache fallback)
  const fetchTasks = useCallback(async () => {
    try {
      const list = await quicClient.listTasks();
      setTasks(list);
    } catch {
      // Silently fail — stale data stays visible
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Listen for streaming output
  useEffect(() => {
    const unsub = quicClient.on("output", (taskId, line) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, output: [...t.output, line] } : t
        )
      );
      setSelectedTask((prev) =>
        prev && prev.id === taskId
          ? { ...prev, output: [...prev.output, line] }
          : prev
      );
    });
    return unsub;
  }, []);

  // Pull-to-refresh
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTasks();
    setRefreshing(false);
  }, [fetchTasks]);

  const handleCreateTask = async () => {
    if (!newTitle.trim()) return;
    setIsSubmitting(true);
    try {
      await quicClient.sendTask(newTitle.trim(), newDescription.trim());
      setNewTitle("");
      setNewDescription("");
      setShowNewTask(false);
      await fetchTasks();
    } catch {
      // Handle error
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStopTask = async (taskId: string) => {
    try {
      await quicClient.stopTask(taskId);
      await fetchTasks();
    } catch {
      // Handle error
    }
  };

  const handleContinueTask = async (taskId: string) => {
    try {
      await quicClient.continueTask(taskId);
      await fetchTasks();
    } catch {
      // Handle error
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    // Optimistic removal
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    try {
      await quicClient.deleteTask(taskId);
    } catch {
      // Refetch on failure to restore
      await fetchTasks();
    }
  };

  // Determine which banner state to show
  const effectiveState: ConnectionState =
    connectionStatus === "connected" ? quicState : connectionStatus;
  const banner = BANNER_CONFIG[effectiveState];

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <View style={styles.container}>
        {/* Connection status banner */}
        <View
          style={[
            styles.banner,
            { backgroundColor: banner.bg, borderBottomColor: banner.border },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: banner.dot }]} />
          <Text style={[styles.bannerText, { color: banner.text }]}>
            {banner.label}
            {activeDevice ? ` \u00b7 ${activeDevice.name}` : ""}
          </Text>
        </View>

        {/* Task list */}
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.listContent,
            tasks.length === 0 && styles.listContentEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#6366f1"
              colors={["#6366f1"]}
              progressBackgroundColor="#111"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyList}>
              <Text style={styles.emptyIcon}>{"[ ]"}</Text>
              <Text style={styles.emptyTitle}>
                {connectionStatus !== "connected"
                  ? "No Device Connected"
                  : "All Clear"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {connectionStatus !== "connected"
                  ? "Go to the Devices tab to connect to your desktop agent."
                  : "No tasks yet. Tap the + button to create your first task."}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <SwipeableTaskRow
              item={item}
              onPress={() => setSelectedTask(item)}
              onDelete={() => handleDeleteTask(item.id)}
            />
          )}
        />

        {/* FAB — only show when connected */}
        {connectionStatus === "connected" && (
          <Pressable
            style={({ pressed }) => [
              styles.fab,
              pressed && styles.fabPressed,
            ]}
            onPress={() => setShowNewTask(true)}
          >
            <Text style={styles.fabText}>+</Text>
          </Pressable>
        )}

        {/* New Task Modal */}
        <Modal visible={showNewTask} animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>New Task</Text>
              <TextInput
                style={styles.input}
                placeholder="Task title"
                placeholderTextColor="#52525b"
                value={newTitle}
                onChangeText={setNewTitle}
              />
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                placeholder="Description (optional)"
                placeholderTextColor="#52525b"
                value={newDescription}
                onChangeText={setNewDescription}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
              <View style={styles.modalButtons}>
                <Pressable
                  style={styles.cancelButton}
                  onPress={() => {
                    setShowNewTask(false);
                    setNewTitle("");
                    setNewDescription("");
                  }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.submitButton,
                    (!newTitle.trim() || isSubmitting) &&
                      styles.submitButtonDisabled,
                  ]}
                  onPress={handleCreateTask}
                  disabled={!newTitle.trim() || isSubmitting}
                >
                  <Text style={styles.submitButtonText}>
                    {isSubmitting ? "Creating..." : "Create"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Task Detail Modal */}
        <Modal visible={!!selectedTask} animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, styles.detailModal]}>
              {selectedTask && (
                <>
                  <View style={styles.detailHeader}>
                    <Text style={styles.modalTitle} numberOfLines={2}>
                      {selectedTask.title}
                    </Text>
                    <Pressable onPress={() => setSelectedTask(null)}>
                      <Text style={styles.closeButton}>X</Text>
                    </Pressable>
                  </View>
                  <View style={styles.detailMeta}>
                    <View
                      style={[
                        styles.statusBadge,
                        {
                          backgroundColor:
                            STATUS_COLORS[selectedTask.status] + "22",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusText,
                          { color: STATUS_COLORS[selectedTask.status] },
                        ]}
                      >
                        {selectedTask.status}
                      </Text>
                    </View>
                    {selectedTask.deviceName ? (
                      <View style={styles.deviceBadge}>
                        <Text style={styles.deviceBadgeText}>
                          {selectedTask.deviceName}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  {selectedTask.description ? (
                    <Text style={styles.detailDesc}>
                      {selectedTask.description}
                    </Text>
                  ) : null}

                  {/* Output */}
                  <View style={styles.outputContainer}>
                    <Text style={styles.outputLabel}>Output</Text>
                    <FlatList
                      data={selectedTask.output}
                      keyExtractor={(_, i) => String(i)}
                      style={styles.outputList}
                      renderItem={({ item: line }) => (
                        <Text style={styles.outputLine}>{line}</Text>
                      )}
                      ListEmptyComponent={
                        <Text style={styles.outputEmpty}>No output yet.</Text>
                      }
                    />
                  </View>

                  {/* Actions */}
                  <View style={styles.detailActions}>
                    {selectedTask.status === "running" && (
                      <Pressable
                        style={styles.stopButton}
                        onPress={() => handleStopTask(selectedTask.id)}
                      >
                        <Text style={styles.stopButtonText}>Stop</Text>
                      </Pressable>
                    )}
                    {(selectedTask.status === "stopped" ||
                      selectedTask.status === "queued") && (
                      <Pressable
                        style={styles.continueButton}
                        onPress={() => handleContinueTask(selectedTask.id)}
                      >
                        <Text style={styles.continueButtonText}>Continue</Text>
                      </Pressable>
                    )}
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#0a0a0a" },
  container: { flex: 1 },

  // Banner
  banner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  bannerText: { fontSize: 13, fontWeight: "500" },

  // List
  listContent: { padding: 16, paddingBottom: 100 },
  listContentEmpty: { flex: 1 },

  // Empty state
  emptyList: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#d0d0d0",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },

  // Swipe
  swipeContainer: { marginBottom: 12, position: "relative" },
  deleteBackground: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#ef4444",
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "flex-end",
    paddingRight: 24,
  },
  deleteBackgroundText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },

  // Task card
  taskCard: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  taskCardPressed: { opacity: 0.7 },
  taskHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 8,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  deviceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#1e1e2e",
  },
  deviceBadgeText: {
    fontSize: 11,
    fontWeight: "500",
    color: "#666",
  },
  taskTitle: { fontSize: 16, fontWeight: "600", color: "#d0d0d0" },
  taskDesc: { fontSize: 13, color: "#666", marginTop: 4 },
  taskOutputPreview: {
    fontSize: 12,
    color: "#6366f1",
    marginTop: 6,
    fontFamily: "monospace",
  },
  taskTimestamp: {
    fontSize: 11,
    color: "#444",
    marginTop: 8,
  },

  // FAB
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#6366f1",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  fabPressed: { opacity: 0.8, transform: [{ scale: 0.95 }] },
  fabText: { fontSize: 28, color: "#ffffff", fontWeight: "300" },

  // Modals
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#111",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  detailModal: { flex: 0.85 },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#d0d0d0",
    marginBottom: 20,
    flex: 1,
  },

  // Inputs
  input: {
    backgroundColor: "#0a0a0a",
    borderWidth: 1,
    borderColor: "#1e1e2e",
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: "#d0d0d0",
    marginBottom: 12,
  },
  inputMultiline: { minHeight: 100 },
  modalButtons: { flexDirection: "row", gap: 12, marginTop: 8 },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#1e1e2e",
    alignItems: "center",
  },
  cancelButtonText: { color: "#a1a1aa", fontWeight: "600", fontSize: 15 },
  submitButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#6366f1",
    alignItems: "center",
  },
  submitButtonDisabled: { opacity: 0.4 },
  submitButtonText: { color: "#ffffff", fontWeight: "600", fontSize: 15 },

  // Detail modal
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  detailMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  closeButton: {
    color: "#666",
    fontSize: 18,
    fontWeight: "700",
    padding: 4,
  },
  detailDesc: { color: "#a1a1aa", fontSize: 14, marginBottom: 16 },
  outputContainer: { flex: 1, marginTop: 8 },
  outputLabel: {
    color: "#666",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    marginBottom: 8,
  },
  outputList: {
    backgroundColor: "#050508",
    borderRadius: 8,
    padding: 12,
    flex: 1,
  },
  outputLine: {
    color: "#d0d0d0",
    fontSize: 12,
    fontFamily: "monospace",
    lineHeight: 18,
  },
  outputEmpty: { color: "#3f3f46", fontSize: 12, fontStyle: "italic" },
  detailActions: { flexDirection: "row", gap: 12, marginTop: 16 },
  stopButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#ef444422",
    alignItems: "center",
  },
  stopButtonText: { color: "#ef4444", fontWeight: "600" },
  continueButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#6366f122",
    alignItems: "center",
  },
  continueButtonText: { color: "#6366f1", fontWeight: "600" },
});
