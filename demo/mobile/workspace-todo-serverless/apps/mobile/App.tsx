import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
  updated_at: string;
};

type PendingChange =
  | { kind: "upsert"; todo: Todo; insert: boolean }
  | { kind: "delete"; id: string };

type Filter = "all" | "open" | "done";

const CACHE_KEY = "workspace-todo-serverless.todos.v1";
const QUEUE_KEY = "workspace-todo-serverless.queue.v1";
const TOKEN_KEY = "workspace-todo-serverless.yaver-project-token";
const SERVERLESS_URL = (process.env.EXPO_PUBLIC_YAVER_SERVERLESS_URL || "").replace(/\/$/, "");
const PROJECT_SLUG = process.env.EXPO_PUBLIC_YAVER_PROJECT_SLUG || "workspace-todo-serverless";

function makeId(): string {
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function todoUrl(id?: string): string {
  const base = `${SERVERLESS_URL}/data/${encodeURIComponent(PROJECT_SLUG)}/todos`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

function requestHeaders(projectToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(projectToken ? { Authorization: `Bearer ${projectToken}` } : {}),
  };
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [queue, setQueue] = useState<PendingChange[]>([]);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(false);
  const [message, setMessage] = useState("Opening local cache…");
  const [projectToken, setProjectToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");

  useEffect(() => {
    void Promise.all([
      readJSON<Todo[]>(CACHE_KEY, []),
      readJSON<PendingChange[]>(QUEUE_KEY, []),
      SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
    ]).then(([cached, pending, savedToken]) => {
      setTodos(cached);
      setQueue(pending);
      setProjectToken(savedToken || "");
      setReady(true);
      setMessage(SERVERLESS_URL ? "Ready to sync" : "Local cache · add a Yaver Serverless URL to sync");
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    void AsyncStorage.setItem(CACHE_KEY, JSON.stringify(todos));
  }, [ready, todos]);

  useEffect(() => {
    if (!ready) return;
    void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }, [ready, queue]);

  const sync = useCallback(async () => {
    if (!SERVERLESS_URL || syncing) return;
    setSyncing(true);
    setMessage("Syncing with Yaver Serverless…");
    try {
      for (const change of queue) {
        if (change.kind === "delete") {
          const response = await fetch(todoUrl(change.id), {
            method: "DELETE",
            headers: requestHeaders(projectToken),
          });
          if (!response.ok && response.status !== 404) throw new Error(`delete returned ${response.status}`);
        } else if (change.insert) {
          const insert = await fetch(todoUrl(), {
            method: "POST",
            headers: requestHeaders(projectToken),
            body: JSON.stringify(change.todo),
          });
          if (!insert.ok) throw new Error(`insert returned ${insert.status}`);
        } else {
          const update = await fetch(todoUrl(change.todo.id), {
            method: "PATCH",
            headers: requestHeaders(projectToken),
            body: JSON.stringify(change.todo),
          });
          if (!update.ok) throw new Error(`update returned ${update.status}`);
        }
      }

      const response = await fetch(`${todoUrl()}?limit=500`, { headers: requestHeaders(projectToken) });
      if (!response.ok) throw new Error(`list returned ${response.status}`);
      const body = (await response.json()) as { rows?: Todo[] };
      const remote = Array.isArray(body.rows) ? body.rows : [];
      setTodos(remote.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setQueue([]);
      setOnline(true);
      setMessage("Synced · SQLite-first Yaver Serverless");
    } catch (error) {
      setOnline(false);
      setMessage(`Offline · ${queue.length} change${queue.length === 1 ? "" : "s"} queued`);
      console.warn("[pocket-tasks] sync failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      setSyncing(false);
    }
  }, [projectToken, queue, syncing]);

  useEffect(() => {
    if (ready && SERVERLESS_URL && projectToken) void sync();
  }, [ready]); // Initial reconciliation only; user changes sync explicitly or optimistically below.

  const enqueue = useCallback((change: PendingChange) => {
    setQueue((current) => {
      const previous = change.kind === "upsert"
        ? current.find((item) => item.kind === "upsert" && item.todo.id === change.todo.id)
        : undefined;
      const withoutSame = current.filter((item) =>
        change.kind === "delete"
          ? !(item.kind === "upsert" && item.todo.id === change.id) && !(item.kind === "delete" && item.id === change.id)
          : !(item.kind === "upsert" && item.todo.id === change.todo.id),
      );
      const merged = change.kind === "upsert" && previous?.kind === "upsert"
        ? { ...change, insert: change.insert || previous.insert }
        : change;
      return [...withoutSame, merged];
    });
    setOnline(false);
    setMessage("Saved locally · sync pending");
  }, []);

  const addTodo = useCallback(() => {
    const title = draft.trim();
    if (!title) return;
    const now = new Date().toISOString();
    const todo: Todo = { id: makeId(), title, completed: false, created_at: now, updated_at: now };
    setTodos((current) => [todo, ...current]);
    enqueue({ kind: "upsert", todo, insert: true });
    setDraft("");
  }, [draft, enqueue]);

  const toggleTodo = useCallback((id: string) => {
    setTodos((current) => current.map((todo) => {
      if (todo.id !== id) return todo;
      const next = { ...todo, completed: !todo.completed, updated_at: new Date().toISOString() };
      enqueue({ kind: "upsert", todo: next, insert: false });
      return next;
    }));
  }, [enqueue]);

  const removeTodo = useCallback((id: string) => {
    setTodos((current) => current.filter((todo) => todo.id !== id));
    enqueue({ kind: "delete", id });
  }, [enqueue]);

  const visible = useMemo(
    () => todos.filter((todo) => filter === "all" || (filter === "done" ? todo.completed : !todo.completed)),
    [filter, todos],
  );
  const openCount = todos.filter((todo) => !todo.completed).length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <Text style={styles.eyebrow}>YAVER SERVERLESS</Text>
            <View style={[styles.statusDot, { backgroundColor: online ? "#34d399" : "#fbbf24" }]} />
          </View>
          <Text style={styles.title}>Pocket Tasks</Text>
          <Text style={styles.subtitle}>{openCount} open · {todos.length - openCount} complete</Text>
          <Text style={styles.syncText}>{message}</Text>
        </View>

        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="New task title"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addTodo}
            placeholder="What needs doing?"
            placeholderTextColor="#64748b"
            returnKeyType="done"
            style={styles.input}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Add task" onPress={addTodo} style={styles.addButton}>
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>

        {!projectToken ? (
          <View style={styles.tokenCard}>
            <Text style={styles.tokenTitle}>Connect this app</Text>
            <Text style={styles.tokenHelp}>Paste the project-scoped Yaver Serverless token. It is stored in the device keychain and never bundled in source or placed in a URL.</Text>
            <TextInput
              accessibilityLabel="Yaver Serverless project token"
              value={tokenDraft}
              onChangeText={setTokenDraft}
              placeholder="pp_…"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const next = tokenDraft.trim();
                if (!next.startsWith("pp_")) {
                  Alert.alert("Project token required", "Use the project-scoped pp_… token from your Yaver Serverless workspace.");
                  return;
                }
                void SecureStore.setItemAsync(TOKEN_KEY, next).then(() => {
                  setProjectToken(next);
                  setTokenDraft("");
                  setMessage("Connected securely · ready to sync");
                });
              }}
              style={[styles.addButton, { marginTop: 10 }]}
            >
              <Text style={styles.addText}>Save securely</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.toolbar}>
          <View style={styles.filters}>
            {(["all", "open", "done"] as Filter[]).map((item) => (
              <Pressable key={item} onPress={() => setFilter(item)} style={[styles.filter, filter === item && styles.filterActive]}>
                <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>{item}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={() => void sync()} disabled={!SERVERLESS_URL || !projectToken || syncing} style={styles.syncButton}>
            {syncing ? <ActivityIndicator color="#e0e7ff" /> : <Text style={styles.syncButtonText}>Sync</Text>}
          </Pressable>
        </View>

        {!ready ? <ActivityIndicator color="#818cf8" style={{ marginTop: 48 }} /> : null}
        {ready && visible.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{todos.length ? "Nothing in this view" : "A calm list starts here"}</Text>
            <Text style={styles.emptyText}>Tasks save locally first, then reconcile with your portable Yaver Serverless workspace.</Text>
          </View>
        ) : null}

        <View style={styles.list}>
          {visible.map((todo) => (
            <View key={todo.id} style={styles.todoRow}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: todo.completed }}
                accessibilityLabel={`${todo.completed ? "Mark open" : "Complete"}: ${todo.title}`}
                onPress={() => toggleTodo(todo.id)}
                style={[styles.checkbox, todo.completed && styles.checkboxDone]}
              >
                <Text style={styles.checkmark}>{todo.completed ? "✓" : ""}</Text>
              </Pressable>
              <Text style={[styles.todoTitle, todo.completed && styles.todoDone]}>{todo.title}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${todo.title}`} onPress={() => removeTodo(todo.id)} style={styles.deleteButton}>
                <Text style={styles.deleteText}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#070a17" },
  page: { padding: 20, paddingBottom: 56 },
  hero: { backgroundColor: "#312e81", borderRadius: 28, padding: 22, marginBottom: 18 },
  heroTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { color: "#c7d2fe", fontSize: 12, fontWeight: "800", letterSpacing: 1.4 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  title: { color: "#fff", fontSize: 36, fontWeight: "900", marginTop: 14 },
  subtitle: { color: "#e0e7ff", fontSize: 16, marginTop: 5 },
  syncText: { color: "#a5b4fc", fontSize: 13, marginTop: 15 },
  composer: { flexDirection: "row", gap: 10 },
  tokenCard: { backgroundColor: "#11162b", borderRadius: 18, padding: 16, marginTop: 14, borderWidth: 1, borderColor: "#312e81" },
  tokenTitle: { color: "#e0e7ff", fontSize: 16, fontWeight: "800", marginBottom: 5 },
  tokenHelp: { color: "#94a3b8", fontSize: 13, lineHeight: 19, marginBottom: 10 },
  input: { flex: 1, minHeight: 52, backgroundColor: "#11162b", color: "#f8fafc", borderRadius: 16, paddingHorizontal: 16, borderWidth: 1, borderColor: "#252d4f", fontSize: 16 },
  addButton: { minWidth: 70, minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: "#818cf8" },
  addText: { color: "#11162b", fontWeight: "900", fontSize: 15 },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 },
  filters: { flexDirection: "row", gap: 6 },
  filter: { paddingHorizontal: 12, minHeight: 44, justifyContent: "center", borderRadius: 14 },
  filterActive: { backgroundColor: "#1e2550" },
  filterText: { color: "#64748b", textTransform: "capitalize", fontWeight: "700" },
  filterTextActive: { color: "#c7d2fe" },
  syncButton: { minWidth: 64, minHeight: 44, alignItems: "center", justifyContent: "center" },
  syncButtonText: { color: "#a5b4fc", fontWeight: "800" },
  empty: { alignItems: "center", paddingVertical: 58, paddingHorizontal: 24 },
  emptyTitle: { color: "#e2e8f0", fontSize: 20, fontWeight: "800" },
  emptyText: { color: "#64748b", textAlign: "center", lineHeight: 20, marginTop: 8 },
  list: { marginTop: 14, gap: 10 },
  todoRow: { minHeight: 66, flexDirection: "row", alignItems: "center", backgroundColor: "#11162b", borderRadius: 18, paddingHorizontal: 14, borderWidth: 1, borderColor: "#202846" },
  checkbox: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 2, borderColor: "#4f5b86" },
  checkboxDone: { backgroundColor: "#34d399", borderColor: "#34d399" },
  checkmark: { color: "#052e2b", fontWeight: "900", fontSize: 20 },
  todoTitle: { flex: 1, color: "#f8fafc", fontSize: 16, fontWeight: "650", marginHorizontal: 12 },
  todoDone: { color: "#64748b", textDecorationLine: "line-through" },
  deleteButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  deleteText: { color: "#64748b", fontSize: 26 },
});
