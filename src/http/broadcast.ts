import { EventEmitter } from "node:events";
import type { SerializedEvent } from "../types.js";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(sessionId: string, event: SerializedEvent): void {
  emitter.emit(sessionId, event);
}

export function subscribe(
  sessionId: string,
  fn: (e: SerializedEvent) => void,
): () => void {
  emitter.on(sessionId, fn);
  return () => emitter.off(sessionId, fn);
}

// Wait for the next event on a session, or resolve to null after timeoutMs.
export function waitForEvent(
  sessionId: string,
  timeoutMs: number,
): Promise<SerializedEvent | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (e: SerializedEvent): void => {
      if (resolved) return;
      resolved = true;
      unsub();
      clearTimeout(timer);
      resolve(e);
    };
    const unsub = subscribe(sessionId, handler);
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsub();
      resolve(null);
    }, timeoutMs);
  });
}
