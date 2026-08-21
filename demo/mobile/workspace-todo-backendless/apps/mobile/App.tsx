import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useReducer, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Filter = "all" | "open" | "done";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
};

type State = { todos: Todo[]; hydrated: boolean; storageError: string | null };
type Action =
  | { type: "hydrate"; todos: Todo[] }
  | { type: "storage-error"; message: string }
  | { type: "add"; title: string }
  | { type: "toggle"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear-completed" };

const STORAGE_KEY = "pocket-tasks-offline.todos.v1";
const initialState: State = { todos: [], hydrated: false, storageError: null };

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "hydrate":
      return { todos: action.todos, hydrated: true, storageError: null };
    case "storage-error":
      return { ...state, hydrated: true, storageError: action.message };
    case "add":
      return {
        ...state,
        storageError: null,
        todos: [{ id: makeId(), title: action.title, completed: false, createdAt: Date.now() }, ...state.todos],
      };
    case "toggle":
      return {
        ...state,
        storageError: null,
        todos: state.todos.map((todo) => todo.id === action.id ? { ...todo, completed: !todo.completed } : todo),
      };
    case "remove":
      return { ...state, storageError: null, todos: state.todos.filter((todo) => todo.id !== action.id) };
    case "clear-completed":
      return { ...state, storageError: null, todos: state.todos.filter((todo) => !todo.completed) };
    default:
      return state;
  }
}

function isTodo(value: unknown): value is Todo {
  if (!value || typeof value !== "object") return false;
  const todo = value as Partial<Todo>;
  return typeof todo.id === "string" && typeof todo.title === "string" &&
    typeof todo.completed === "boolean" && typeof todo.createdAt === "number";
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted) return;
        if (!raw) return dispatch({ type: "hydrate", todos: [] });
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every(isTodo)) throw new Error("Saved tasks are not readable.");
        dispatch({ type: "hydrate", todos: parsed });
      })
      .catch(() => mounted && dispatch({ type: "storage-error", message: "Saved tasks could not be loaded." }));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state.todos)).catch(() => {
      dispatch({ type: "storage-error", message: "Changes are visible, but this device could not save them." });
    });
  }, [state.hydrated, state.todos]);

  const visibleTodos = useMemo(() => state.todos.filter((todo) => {
    if (filter === "open") return !todo.completed;
    if (filter === "done") return todo.completed;
    return true;
  }), [filter, state.todos]);
  const openCount = state.todos.filter((todo) => !todo.completed).length;
  const doneCount = state.todos.length - openCount;

  const addTodo = () => {
    const title = draft.trim();
    if (!title) return;
    dispatch({ type: "add", title });
    setDraft("");
  };

  if (!state.hydrated) {
    return (
      <SafeAreaView style={styles.loading}>
        <ActivityIndicator color="#0f766e" accessibilityLabel="Loading saved tasks" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>PRIVATE · ON THIS DEVICE</Text>
            <Text style={styles.title}>Pocket Tasks</Text>
          </View>
          <View style={styles.countBadge} accessibilityLabel={`${openCount} open tasks`}>
            <Text style={styles.countNumber}>{openCount}</Text>
            <Text style={styles.countLabel}>open</Text>
          </View>
        </View>

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addTodo}
            placeholder="What needs doing?"
            placeholderTextColor="#94a3b8"
            returnKeyType="done"
            accessibilityLabel="New task"
            style={styles.input}
          />
          <Pressable
            onPress={addTodo}
            disabled={!draft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Add task"
            style={({ pressed }) => [styles.addButton, !draft.trim() && styles.disabled, pressed && styles.pressed]}
          >
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>

        {state.storageError ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{state.storageError}</Text>
          </View>
        ) : null}

        <View style={styles.filters} accessibilityRole="tablist">
          {(["all", "open", "done"] as Filter[]).map((item) => (
            <Pressable
              key={item}
              onPress={() => setFilter(item)}
              accessibilityRole="tab"
              accessibilityState={{ selected: filter === item }}
              style={[styles.filter, filter === item && styles.filterActive]}
            >
              <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>{item}</Text>
            </Pressable>
          ))}
        </View>

        <FlatList
          data={visibleTodos}
          keyExtractor={(todo) => todo.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={visibleTodos.length ? styles.list : styles.emptyList}
          ListEmptyComponent={
            <View style={styles.empty} accessibilityLiveRegion="polite">
              <Text style={styles.emptyIcon}>✓</Text>
              <Text style={styles.emptyTitle}>{filter === "all" ? "A clear list" : `No ${filter} tasks`}</Text>
              <Text style={styles.emptyBody}>Add one small thing above. It stays private on this device.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.todoRow}>
              <Pressable
                onPress={() => dispatch({ type: "toggle", id: item.id })}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.completed }}
                accessibilityLabel={item.title}
                accessibilityHint={item.completed ? "Marks task as open" : "Marks task as complete"}
                style={[styles.checkbox, item.completed && styles.checkboxChecked]}
              >
                <Text style={styles.checkmark}>{item.completed ? "✓" : ""}</Text>
              </Pressable>
              <Text style={[styles.todoTitle, item.completed && styles.todoDone]} numberOfLines={3}>{item.title}</Text>
              <Pressable
                onPress={() => dispatch({ type: "remove", id: item.id })}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${item.title}`}
                style={styles.deleteButton}
              >
                <Text style={styles.deleteText}>×</Text>
              </Pressable>
            </View>
          )}
        />

        <View style={styles.footer}>
          <Text style={styles.footerText}>{state.todos.length} total · {doneCount} finished</Text>
          {doneCount > 0 ? (
            <Pressable onPress={() => dispatch({ type: "clear-completed" })} accessibilityRole="button">
              <Text style={styles.clearText}>Clear finished</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: "#f8fafc" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f8fafc" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 16 },
  eyebrow: { color: "#0f766e", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#0f172a", fontSize: 34, lineHeight: 40, fontWeight: "900", marginTop: 3 },
  countBadge: { minWidth: 62, minHeight: 62, borderRadius: 20, backgroundColor: "#ccfbf1", alignItems: "center", justifyContent: "center" },
  countNumber: { color: "#115e59", fontSize: 22, fontWeight: "900" },
  countLabel: { color: "#0f766e", fontSize: 11, fontWeight: "700" },
  composer: { flexDirection: "row", gap: 10, paddingHorizontal: 20, marginBottom: 12 },
  input: { flex: 1, minHeight: 54, borderRadius: 18, paddingHorizontal: 16, color: "#0f172a", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#dbe4ee", fontSize: 16 },
  addButton: { minWidth: 68, minHeight: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#0f766e" },
  addButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  disabled: { opacity: 0.4 },
  pressed: { transform: [{ scale: 0.98 }] },
  errorBanner: { marginHorizontal: 20, marginBottom: 12, borderRadius: 14, padding: 12, backgroundColor: "#fef2f2" },
  errorText: { color: "#b91c1c", fontSize: 13, lineHeight: 18 },
  filters: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingVertical: 6 },
  filter: { minHeight: 44, paddingHorizontal: 16, borderRadius: 999, justifyContent: "center", backgroundColor: "#e2e8f0" },
  filterActive: { backgroundColor: "#134e4a" },
  filterText: { color: "#475569", textTransform: "capitalize", fontSize: 13, fontWeight: "800" },
  filterTextActive: { color: "#ffffff" },
  list: { padding: 20, gap: 10, paddingBottom: 30 },
  emptyList: { flexGrow: 1, justifyContent: "center", padding: 28 },
  empty: { alignItems: "center", paddingBottom: 40 },
  emptyIcon: { width: 58, height: 58, borderRadius: 20, textAlign: "center", paddingTop: 12, overflow: "hidden", color: "#0f766e", backgroundColor: "#ccfbf1", fontSize: 24, fontWeight: "900" },
  emptyTitle: { color: "#0f172a", fontSize: 20, fontWeight: "900", marginTop: 16 },
  emptyBody: { color: "#64748b", fontSize: 14, lineHeight: 20, textAlign: "center", maxWidth: 280, marginTop: 6 },
  todoRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 20, padding: 12, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e2e8f0" },
  checkbox: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#94a3b8" },
  checkboxChecked: { backgroundColor: "#14b8a6", borderColor: "#14b8a6" },
  checkmark: { color: "#ffffff", fontSize: 20, fontWeight: "900" },
  todoTitle: { flex: 1, color: "#1e293b", fontSize: 16, lineHeight: 22, fontWeight: "650" },
  todoDone: { color: "#94a3b8", textDecorationLine: "line-through" },
  deleteButton: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  deleteText: { color: "#94a3b8", fontSize: 28, lineHeight: 30 },
  footer: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: "#e2e8f0" },
  footerText: { color: "#64748b", fontSize: 12, fontWeight: "700" },
  clearText: { color: "#0f766e", fontSize: 13, fontWeight: "800", paddingVertical: 12 },
});
