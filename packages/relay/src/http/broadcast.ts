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

// A subscription that starts buffering events immediately on creation, before
// any DB query runs. This closes the long-poll race window: an event published
// between an initial query() returning and a waiter being registered would
// otherwise be missed by both. Call wait() to either drain a buffered event or
// block for the next one (resolving to null after timeoutMs). Always call
// close() to release the underlying listener.
export function openWaiter(sessionId: string): {
  wait: (timeoutMs: number) => Promise<SerializedEvent | null>;
  close: () => void;
} {
  const buffer: SerializedEvent[] = [];
  let pending: ((e: SerializedEvent) => void) | null = null;
  const handler = (e: SerializedEvent): void => {
    if (pending) {
      const fn = pending;
      pending = null;
      fn(e);
    } else {
      buffer.push(e);
    }
  };
  const unsub = subscribe(sessionId, handler);

  return {
    wait(timeoutMs: number): Promise<SerializedEvent | null> {
      const buffered = buffer.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve) => {
        let resolved = false;
        pending = (e: SerializedEvent): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(e);
        };
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          pending = null;
          resolve(null);
        }, timeoutMs);
      });
    },
    close: unsub,
  };
}
