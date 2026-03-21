/**
 * Simple event emitter for passing shared images from _layout.tsx to tasks.tsx.
 * When images are shared via iOS Share Extension, they are decoded in _layout
 * and emitted here so the tasks screen can pick them up and open the new task modal.
 */
import type { ImageAttachment } from "./quic";

type Listener = (images: ImageAttachment[]) => void;

class ShareIntentEmitter {
  private listeners: Listener[] = [];

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(images: ImageAttachment[]) {
    for (const listener of this.listeners) {
      listener(images);
    }
  }
}

export const shareIntentEmitter = new ShareIntentEmitter();
