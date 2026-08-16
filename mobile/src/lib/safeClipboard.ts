import { Platform } from "react-native";

type ClipboardLike = {
  setStringAsync?: (text: string) => Promise<void>;
};

let clipboard: ClipboardLike | null = null;
if ((Platform as any).isTV !== true) {
  try {
    // expo-clipboard's native module is not linked into the tvOS build, so a
    // static import would throw "Cannot find native module" on tvOS. Require it
    // defensively and degrade to a no-op when unavailable.
    clipboard = require("expo-clipboard");
  } catch {
    clipboard = null;
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await clipboard?.setStringAsync?.(text);
  } catch {
    // No-op on platforms without the native module
  }
}
