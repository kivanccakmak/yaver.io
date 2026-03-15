import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useColors } from "../../src/context/ThemeContext";
import { useDevice } from "../../src/context/DeviceContext";
import { quicClient } from "../../src/lib/quic";
import {
  getTodoProjects,
  getTodos,
  saveTodoProjects,
  saveTodos,
  Todo,
  TodoProject,
} from "../../src/lib/storage";

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function TodosScreen() {
  const c = useColors();
  const { connectionStatus } = useDevice();
  const isConnected = connectionStatus === "connected";

  const [projects, setProjects] = useState<TodoProject[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Modals
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const [showAddTodo, setShowAddTodo] = useState(false);
  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [newTodoNotes, setNewTodoNotes] = useState("");

  // Load from storage on mount
  useEffect(() => {
    (async () => {
      const [p, t] = await Promise.all([getTodoProjects(), getTodos()]);
      setProjects(p);
      setTodos(t);
      if (p.length > 0) setSelectedProjectId(p[0].id);
    })();
  }, []);

  const persistProjects = useCallback(async (updated: TodoProject[]) => {
    setProjects(updated);
    await saveTodoProjects(updated);
  }, []);

  const persistTodos = useCallback(async (updated: Todo[]) => {
    setTodos(updated);
    await saveTodos(updated);
  }, []);

  // ── Project actions ──────────────────────────────────────────────

  const handleAddProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    const p: TodoProject = { id: uuid(), name, createdAt: Date.now() };
    const updated = [...projects, p];
    await persistProjects(updated);
    setSelectedProjectId(p.id);
    setNewProjectName("");
    setShowAddProject(false);
  }, [newProjectName, projects, persistProjects]);

  const handleDeleteProject = useCallback((projectId: string) => {
    Alert.alert("Delete Project", "Delete this project and all its todos?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const updatedProjects = projects.filter(p => p.id !== projectId);
          const updatedTodos = todos.filter(t => t.projectId !== projectId);
          await persistProjects(updatedProjects);
          await persistTodos(updatedTodos);
          if (selectedProjectId === projectId) {
            setSelectedProjectId(updatedProjects[0]?.id ?? null);
          }
        },
      },
    ]);
  }, [projects, todos, selectedProjectId, persistProjects, persistTodos]);

  // ── Todo actions ─────────────────────────────────────────────────

  const handleAddTodo = useCallback(async () => {
    const title = newTodoTitle.trim();
    if (!title || !selectedProjectId) return;
    const t: Todo = {
      id: uuid(),
      projectId: selectedProjectId,
      title,
      notes: newTodoNotes.trim() || undefined,
      done: false,
      createdAt: Date.now(),
    };
    await persistTodos([...todos, t]);
    setNewTodoTitle("");
    setNewTodoNotes("");
    setShowAddTodo(false);
  }, [newTodoTitle, newTodoNotes, selectedProjectId, todos, persistTodos]);

  const handleToggleTodo = useCallback(async (id: string) => {
    const updated = todos.map(t => t.id === id ? { ...t, done: !t.done } : t);
    await persistTodos(updated);
  }, [todos, persistTodos]);

  const handleDeleteTodo = useCallback(async (id: string) => {
    await persistTodos(todos.filter(t => t.id !== id));
  }, [todos, persistTodos]);

  const handleRunTodo = useCallback(async (todo: Todo) => {
    if (!isConnected) {
      Alert.alert("No Agent", "No agent is connected. Connect a device first to run this task.");
      return;
    }
    Alert.alert(
      "Run Task",
      `Send "${todo.title}" to the agent?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Run",
          onPress: async () => {
            try {
              const project = projects.find(p => p.id === todo.projectId);
              const prompt = project
                ? `[${project.name}] ${todo.title}${todo.notes ? `\n\n${todo.notes}` : ""}`
                : `${todo.title}${todo.notes ? `\n\n${todo.notes}` : ""}`;
              await quicClient.sendTask(prompt, prompt);
            } catch (e: any) {
              Alert.alert("Error", e?.message || "Failed to send task to agent.");
            }
          },
        },
      ]
    );
  }, [isConnected, projects]);

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const visibleTodos = todos.filter(t => t.projectId === selectedProjectId);
  const pendingTodos = visibleTodos.filter(t => !t.done);
  const doneTodos = visibleTodos.filter(t => t.done);

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: c.bg }]} edges={["bottom"]}>
      {/* Local badge */}
      <View style={[s.localBanner, { backgroundColor: "#1a1a2e", borderBottomColor: c.border }]}>
        <Text style={s.localBannerText}>⬡ Local — stored on this device only</Text>
      </View>

      <View style={s.container}>
        {/* Project tabs */}
        <View style={[s.projectBar, { borderBottomColor: c.border }]}>
          <FlatList
            horizontal
            data={projects}
            keyExtractor={p => p.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.projectList}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  s.projectTab,
                  { borderColor: item.id === selectedProjectId ? c.accent : c.border },
                  item.id === selectedProjectId && { backgroundColor: c.accent + "18" },
                ]}
                onPress={() => setSelectedProjectId(item.id)}
                onLongPress={() => handleDeleteProject(item.id)}
              >
                <Text style={[s.projectTabText, { color: item.id === selectedProjectId ? c.accent : c.textMuted }]}>
                  {item.name}
                </Text>
              </Pressable>
            )}
            ListFooterComponent={
              <Pressable
                style={[s.projectTab, s.addProjectTab, { borderColor: c.border }]}
                onPress={() => setShowAddProject(true)}
              >
                <Text style={[s.projectTabText, { color: c.textMuted }]}>+ Project</Text>
              </Pressable>
            }
          />
        </View>

        {/* Todo list */}
        {projects.length === 0 ? (
          <View style={s.empty}>
            <Text style={[s.emptyIcon, { color: c.textMuted }]}>☐</Text>
            <Text style={[s.emptyTitle, { color: c.textPrimary }]}>No projects yet</Text>
            <Text style={[s.emptySubtitle, { color: c.textSecondary }]}>
              Create a project to start organizing your tasks.
            </Text>
            <Pressable style={[s.emptyBtn, { backgroundColor: c.accent }]} onPress={() => setShowAddProject(true)}>
              <Text style={s.emptyBtnText}>New Project</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={[...pendingTodos, ...doneTodos]}
            keyExtractor={t => t.id}
            contentContainerStyle={s.listContent}
            ListEmptyComponent={
              <View style={s.emptyInner}>
                <Text style={[s.emptySubtitle, { color: c.textSecondary }]}>
                  No todos in {selectedProject?.name}. Tap + to add one.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <TodoRow
                todo={item}
                onToggle={() => handleToggleTodo(item.id)}
                onDelete={() => handleDeleteTodo(item.id)}
                onRun={() => handleRunTodo(item)}
                isConnected={isConnected}
                c={c}
              />
            )}
          />
        )}

        {/* FAB */}
        {selectedProjectId && (
          <Pressable
            style={[s.fab, { backgroundColor: c.accent }]}
            onPress={() => setShowAddTodo(true)}
          >
            <Text style={s.fabText}>+</Text>
          </Pressable>
        )}
      </View>

      {/* Add Project Modal */}
      <Modal visible={showAddProject} animationType="slide" transparent onRequestClose={() => setShowAddProject(false)}>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <Pressable style={{ flex: 1 }} onPress={() => { Keyboard.dismiss(); setShowAddProject(false); }} />
          <View style={[s.modalSheet, { backgroundColor: c.bgCard }]}>
            <Text style={[s.modalTitle, { color: c.textPrimary }]}>New Project</Text>
            <TextInput
              style={[s.input, { backgroundColor: c.bg, borderColor: c.border, color: c.textPrimary }]}
              placeholder="Project name..."
              placeholderTextColor={c.textMuted}
              value={newProjectName}
              onChangeText={setNewProjectName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleAddProject}
            />
            <View style={s.modalButtons}>
              <Pressable style={[s.btnCancel, { backgroundColor: c.bgCardElevated }]} onPress={() => { setNewProjectName(""); setShowAddProject(false); }}>
                <Text style={[s.btnCancelText, { color: c.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.btnCreate, { backgroundColor: c.accent }, !newProjectName.trim() && s.btnDisabled]}
                onPress={handleAddProject}
                disabled={!newProjectName.trim()}
              >
                <Text style={s.btnCreateText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Todo Modal */}
      <Modal visible={showAddTodo} animationType="slide" transparent onRequestClose={() => setShowAddTodo(false)}>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <Pressable style={{ flex: 1 }} onPress={() => { Keyboard.dismiss(); setShowAddTodo(false); }} />
          <View style={[s.modalSheet, { backgroundColor: c.bgCard }]}>
            <Text style={[s.modalTitle, { color: c.textPrimary }]}>New Todo</Text>
            {selectedProject && (
              <Text style={[s.modalProject, { color: c.accent }]}>{selectedProject.name}</Text>
            )}
            <TextInput
              style={[s.input, { backgroundColor: c.bg, borderColor: c.border, color: c.textPrimary }]}
              placeholder="What needs to be done?"
              placeholderTextColor={c.textMuted}
              value={newTodoTitle}
              onChangeText={setNewTodoTitle}
              autoFocus
            />
            <TextInput
              style={[s.input, s.inputNotes, { backgroundColor: c.bg, borderColor: c.border, color: c.textPrimary }]}
              placeholder="Notes (optional)..."
              placeholderTextColor={c.textMuted}
              value={newTodoNotes}
              onChangeText={setNewTodoNotes}
              multiline
            />
            <View style={s.modalButtons}>
              <Pressable style={[s.btnCancel, { backgroundColor: c.bgCardElevated }]} onPress={() => { setNewTodoTitle(""); setNewTodoNotes(""); setShowAddTodo(false); }}>
                <Text style={[s.btnCancelText, { color: c.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.btnCreate, { backgroundColor: c.accent }, !newTodoTitle.trim() && s.btnDisabled]}
                onPress={handleAddTodo}
                disabled={!newTodoTitle.trim()}
              >
                <Text style={s.btnCreateText}>Add</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function TodoRow({
  todo,
  onToggle,
  onDelete,
  onRun,
  isConnected,
  c,
}: {
  todo: Todo;
  onToggle: () => void;
  onDelete: () => void;
  onRun: () => void;
  isConnected: boolean;
  c: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[s.todoRow, { backgroundColor: c.bgCard, borderColor: c.border }]}>
      <Pressable style={s.todoCheck} onPress={onToggle}>
        <View style={[s.checkbox, { borderColor: todo.done ? c.success || "#22c55e" : c.border }, todo.done && { backgroundColor: c.success || "#22c55e" }]}>
          {todo.done && <Text style={s.checkmark}>✓</Text>}
        </View>
      </Pressable>
      <Pressable style={s.todoBody} onLongPress={onDelete}>
        <Text style={[s.todoTitle, { color: todo.done ? c.textMuted : c.textPrimary }, todo.done && s.todoTitleDone]}>
          {todo.title}
        </Text>
        {todo.notes ? (
          <Text style={[s.todoNotes, { color: c.textMuted }]} numberOfLines={2}>{todo.notes}</Text>
        ) : null}
      </Pressable>
      {!todo.done && (
        <Pressable
          style={[s.runBtn, { backgroundColor: isConnected ? c.accent + "22" : c.bgCardElevated }]}
          onPress={onRun}
        >
          <Text style={[s.runBtnText, { color: isConnected ? c.accent : c.textMuted }]}>▶</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  container: { flex: 1 },
  localBanner: { paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1 },
  localBannerText: { fontSize: 11, color: "#818cf8", fontWeight: "500" },

  projectBar: { borderBottomWidth: 1 },
  projectList: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  projectTab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  addProjectTab: {},
  projectTabText: { fontSize: 13, fontWeight: "500" },

  listContent: { padding: 16, paddingBottom: 100 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  emptyInner: { paddingTop: 60, alignItems: "center" },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  emptySubtitle: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  emptyBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  emptyBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  fab: { position: "absolute", bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#6366f1", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  fabText: { fontSize: 28, color: "#fff", fontWeight: "300" },

  todoRow: { flexDirection: "row", alignItems: "center", borderRadius: 12, borderWidth: 1, marginBottom: 10, padding: 12 },
  todoCheck: { padding: 4, marginRight: 10 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  checkmark: { color: "#fff", fontSize: 13, fontWeight: "700" },
  todoBody: { flex: 1, marginRight: 8 },
  todoTitle: { fontSize: 15, fontWeight: "500" },
  todoTitleDone: { textDecorationLine: "line-through", opacity: 0.5 },
  todoNotes: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  runBtn: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  runBtnText: { fontSize: 13, fontWeight: "700" },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 },
  modalTitle: { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  modalProject: { fontSize: 13, fontWeight: "500", marginBottom: 16 },
  input: { borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 15, marginBottom: 12, marginTop: 8 },
  inputNotes: { minHeight: 72, textAlignVertical: "top" },
  modalButtons: { flexDirection: "row", gap: 12, marginTop: 4 },
  btnCancel: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnCancelText: { fontWeight: "600", fontSize: 15 },
  btnCreate: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnDisabled: { opacity: 0.4 },
  btnCreateText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
