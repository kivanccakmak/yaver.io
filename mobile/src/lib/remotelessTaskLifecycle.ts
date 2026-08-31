// Cross-platform lifetime for finite, user-started phone-local work.
// Android owns a foreground service + partial wake lock. iOS has no FGS: it
// grants only a bounded UIApplication background task. We checkpoint status
// locally and surface an interrupted run as FAILED on the next launch; we never
// pretend iOS can run an unlimited daemon or replay file mutations blindly.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import {
  advanceRemotelessRecord,
  finishRemotelessRecord,
  recoverInterruptedRecords,
  startRemotelessRecord,
  type RemotelessTaskKind,
  type RemotelessTaskRecord,
  type RemotelessTaskState,
} from "./remotelessTaskLifecycleCore";

const STORAGE_KEY = "@yaver/remoteless_tasks/v1";
const MAX_RECORDS = 30;
const activeIds = new Set<string>();
let records: RemotelessTaskRecord[] | null = null;
let storageQueue: Promise<void> = Promise.resolve();

type StartInput = {
  id: string;
  title: string;
  projectSlug: string;
  kind: RemotelessTaskKind;
  phase?: string;
};

const AndroidNative = (NativeModules as any).YaverSandbox as undefined | {
  beginRemotelessTask(id: string, title: string, phase: string): Promise<boolean>;
  updateRemotelessTask(id: string, phase: string): Promise<boolean>;
  endRemotelessTask(id: string, status: string): Promise<boolean>;
};
const IOSNative = (NativeModules as any).YaverInfo as undefined | {
  beginRemotelessTask(id: string, title: string): Promise<{ active?: boolean }>;
  endRemotelessTask(id: string, status: string): Promise<boolean>;
};

async function loadRecords(): Promise<RemotelessTaskRecord[]> {
  if (records) return records;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = [];
  }
  return records;
}

function persist(next: RemotelessTaskRecord[]): Promise<void> {
  records = [...next]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS);
  storageQueue = storageQueue
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records)));
  return storageQueue;
}

async function replaceRecord(next: RemotelessTaskRecord): Promise<void> {
  const all = await loadRecords();
  await persist([next, ...all.filter((record) => record.id !== next.id)]);
}

export async function beginRemotelessTask(input: StartInput): Promise<RemotelessTaskRecord> {
  let record = startRemotelessRecord(input, Date.now());
  activeIds.add(record.id);
  await replaceRecord(record).catch(() => undefined);
  try {
    if (Platform.OS === "android" && AndroidNative?.beginRemotelessTask) {
      await AndroidNative.beginRemotelessTask(record.id, record.title, record.phase);
      record = advanceRemotelessRecord(record, { backgroundProtection: "active" }, Date.now());
    } else if (Platform.OS === "ios" && IOSNative?.beginRemotelessTask) {
      const result = await IOSNative.beginRemotelessTask(record.id, record.title);
      record = advanceRemotelessRecord(
        record,
        { backgroundProtection: result?.active === false ? "unavailable" : "bounded" },
        Date.now(),
      );
    } else {
      record = advanceRemotelessRecord(record, { backgroundProtection: "unavailable" }, Date.now());
    }
  } catch (error) {
    record = advanceRemotelessRecord(record, {
      backgroundProtection: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    }, Date.now());
  }
  await replaceRecord(record).catch(() => undefined);
  return record;
}

export async function updateRemotelessTask(id: string, phase: string): Promise<void> {
  const all = await loadRecords();
  const current = all.find((record) => record.id === id);
  if (!current || current.state !== "running") return;
  await replaceRecord(advanceRemotelessRecord(current, { phase }, Date.now())).catch(() => undefined);
  if (Platform.OS === "android" && activeIds.has(id)) {
    await AndroidNative?.updateRemotelessTask?.(id, phase).catch(() => undefined);
  }
}

export async function endRemotelessTask(
  id: string,
  state: Extract<RemotelessTaskState, "ready" | "completed" | "failed" | "stopped" | "review">,
  detail?: string,
): Promise<void> {
  const all = await loadRecords();
  const current = all.find((record) => record.id === id);
  activeIds.delete(id);
  if (current) await replaceRecord(finishRemotelessRecord(current, state, Date.now(), detail)).catch(() => undefined);
  if (Platform.OS === "android") {
    await AndroidNative?.endRemotelessTask?.(id, state).catch(() => undefined);
  } else if (Platform.OS === "ios") {
    await IOSNative?.endRemotelessTask?.(id, state).catch(() => undefined);
  }
}

export async function withRemotelessTask<T>(input: StartInput, run: () => Promise<T>): Promise<T> {
  await beginRemotelessTask(input).catch(() => undefined);
  try {
    const value = await run();
    await endRemotelessTask(input.id, "completed").catch(() => undefined);
    return value;
  } catch (error) {
    const stopped = error instanceof Error && error.name === "AbortError";
    await endRemotelessTask(
      input.id,
      stopped ? "stopped" : "failed",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

export async function listRemotelessTasks(): Promise<RemotelessTaskRecord[]> {
  return [...(await loadRecords())];
}

/** Call once on cold launch. Returns the records that changed to REVIEW so a
 * consuming surface can replace a stale spinner with a route to inspect Git. */
export async function recoverInterruptedRemotelessTasks(): Promise<RemotelessTaskRecord[]> {
  const before = await loadRecords();
  const next = recoverInterruptedRecords(before, activeIds, Date.now());
  const changed = next.filter((record, index) => record !== before[index]);
  if (changed.length) await persist(next);
  return changed;
}
