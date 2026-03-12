import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDevice } from "../../src/context/DeviceContext";
import { quicClient, Task, TaskStatus } from "../../src/lib/quic";

const STATUS_COLORS: Record<TaskStatus, string> = {
  queued: "#eab308",
  running: "#6366f1",
  completed: "#22c55e",
  failed: "#ef4444",
  stopped: "#a1a1aa",
};

export default function TasksScreen() {
  const { connectionStatus, activeDevice } = useDevice();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch tasks when connected
  const fetchTasks = useCallback(async () => {
    if (connectionStatus !== "connected") return;
    try {
      const list = await quicClient.listTasks();
      setTasks(list);
    } catch {
      // Silently fail
    }
  }, [connectionStatus]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Listen for streaming output
  useEffect(() => {
    const unsub = quicClient.onOutput((taskId, line) => {
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

  if (connectionStatus !== "connected") {
    return (
      <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>No Device Connected</Text>
          <Text style={styles.emptySubtitle}>
            Go to the Devices tab to connect to your desktop agent.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <View style={styles.container}>
        {/* Connection banner */}
        <View style={styles.banner}>
          <View style={styles.dot} />
          <Text style={styles.bannerText}>
            Connected to {activeDevice?.name ?? "agent"}
          </Text>
        </View>

        {/* Task list */}
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyList}>
              <Text style={styles.emptyListText}>
                No tasks yet. Tap + to create one.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.taskCard,
                pressed && styles.taskCardPressed,
              ]}
              onPress={() => setSelectedTask(item)}
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
              </View>
              <Text style={styles.taskTitle}>{item.title}</Text>
              {item.description ? (
                <Text style={styles.taskDesc} numberOfLines={2}>
                  {item.description}
                </Text>
              ) : null}
            </Pressable>
          )}
        />

        {/* FAB */}
        <Pressable
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => setShowNewTask(true)}
        >
          <Text style={styles.fabText}>+</Text>
        </Pressable>

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
                    (!newTitle.trim() || isSubmitting) && styles.submitButtonDisabled,
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
                    <Text style={styles.modalTitle}>{selectedTask.title}</Text>
                    <Pressable onPress={() => setSelectedTask(null)}>
                      <Text style={styles.closeButton}>X</Text>
                    </Pressable>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      {
                        backgroundColor:
                          STATUS_COLORS[selectedTask.status] + "22",
                        alignSelf: "flex-start",
                        marginBottom: 12,
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
                      renderItem={({ item }) => (
                        <Text style={styles.outputLine}>{item}</Text>
                      )}
                      ListEmptyComponent={
                        <Text style={styles.outputEmpty}>
                          No output yet.
                        </Text>
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

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#0a0a0a" },
  container: { flex: 1 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#0d1a0d",
    borderBottomWidth: 1,
    borderBottomColor: "#1a2e1a",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#22c55e",
    marginRight: 8,
  },
  bannerText: { color: "#4ade80", fontSize: 13, fontWeight: "500" },
  listContent: { padding: 16, paddingBottom: 100 },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#e4e4e7" },
  emptySubtitle: {
    fontSize: 14,
    color: "#71717a",
    textAlign: "center",
    marginTop: 8,
  },
  emptyList: { paddingTop: 64, alignItems: "center" },
  emptyListText: { color: "#71717a", fontSize: 14 },
  taskCard: {
    backgroundColor: "#111118",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  taskCardPressed: { opacity: 0.7 },
  taskHeader: { flexDirection: "row", marginBottom: 8 },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: { fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  taskTitle: { fontSize: 16, fontWeight: "600", color: "#e4e4e7" },
  taskDesc: { fontSize: 13, color: "#71717a", marginTop: 4 },
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
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#111118",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  detailModal: { flex: 0.85 },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#e4e4e7",
    marginBottom: 20,
  },
  input: {
    backgroundColor: "#0a0a0a",
    borderWidth: 1,
    borderColor: "#1e1e2e",
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: "#e4e4e7",
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
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  closeButton: { color: "#71717a", fontSize: 18, fontWeight: "700", padding: 4 },
  detailDesc: { color: "#a1a1aa", fontSize: 14, marginBottom: 16 },
  outputContainer: { flex: 1, marginTop: 8 },
  outputLabel: {
    color: "#71717a",
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
  outputLine: { color: "#d4d4d8", fontSize: 12, fontFamily: "monospace", lineHeight: 18 },
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
