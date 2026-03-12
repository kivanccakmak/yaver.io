/**
 * Local P2P task caching layer using AsyncStorage.
 *
 * Provides offline-first access to task lists and output so the mobile
 * app can display data even when the desktop agent is unreachable.
 *
 * Requires: @react-native-async-storage/async-storage
 *   npx expo install @react-native-async-storage/async-storage
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Task } from "./quic";

const KEYS = {
  TASK_LIST: "@yaver/task_list",
  TASK_OUTPUT_PREFIX: "@yaver/task_output/",
} as const;

/** Persist the current task list to local storage. */
export async function cacheTaskList(tasks: Task[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.TASK_LIST, JSON.stringify(tasks));
  } catch {
    // Storage write failures are non-fatal — the data is still in memory.
  }
}

/** Load the cached task list. Returns an empty array when nothing is cached. */
export async function getCachedTaskList(): Promise<Task[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.TASK_LIST);
    if (!raw) return [];
    return JSON.parse(raw) as Task[];
  } catch {
    return [];
  }
}

/** Append output lines for a single task to local storage. */
export async function cacheTaskOutput(
  taskId: string,
  output: string[]
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      KEYS.TASK_OUTPUT_PREFIX + taskId,
      JSON.stringify(output)
    );
  } catch {
    // Non-fatal.
  }
}

/** Retrieve cached output for a task. */
export async function getCachedTaskOutput(
  taskId: string
): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.TASK_OUTPUT_PREFIX + taskId);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/** Remove all Yaver-related cache entries from AsyncStorage. */
export async function clearCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const yaverKeys = allKeys.filter((k) => k.startsWith("@yaver/"));
    if (yaverKeys.length > 0) {
      await AsyncStorage.multiRemove(yaverKeys);
    }
  } catch {
    // Non-fatal.
  }
}
