// Cross-process event pub/sub for the relay.
//
// Public interface — STABLE, call sites must not change:
//   publish(sessionId, event)            — fan an event out to subscribers
//   subscribe(sessionId, fn) -> unsub    — receive every future event
//   waitForEvent(sessionId, timeoutMs)   — resolve to the next event or null
//   openWaiter(sessionId) -> {wait,close}— buffering waiter (long-poll race)
//
// Two backends, selected at runtime by `redisEnabled()`:
//
//   REDIS OFF (single replica / self-host) — the original behaviour, byte for
//   byte: `publish()` emits straight into the in-process EventEmitter and
//   subscribers fire synchronously. No external dependency.
//
//   REDIS ON (multi-replica) — `publish()` does a Redis PUBLISH to a
//   per-session channel `pane:events:<sessionId>` and does NOT emit locally.
//   Each replica holds ONE Redis SUBSCRIBE connection (see redis.ts) listening
//   on a single pattern; messages it receives — including the publishing
//   replica's OWN messages, since Redis loops a PUBLISH back to every
//   subscriber including the sender — are re-emitted into the local
//   EventEmitter. subscribe / waitForEvent / openWaiter then work unchanged on
//   top of that emitter.
//
//   Double-delivery avoidance: when Redis is on, `publish()` deliberately does
//   NOT also emit locally. If it did, a same-replica subscriber would see the
//   event twice — once from the direct local emit, once from the Redis
//   loopback. By feeding the local emitter ONLY from the Redis subscription,
//   same-replica and cross-replica delivery take the identical path and every
//   subscriber sees each event exactly once. The trade-off is a Redis
//   round-trip of added latency even for same-replica delivery, which is
//   acceptable and keeps the two paths provably consistent.

import { EventEmitter } from "node:events";
import type { SerializedEvent } from "../types.js";
import { redisEnabled, redisPub, redisSub } from "../redis.js";
import { log } from "../log.js";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

// Redis pub/sub channel naming. We subscribe to one pattern and route by the
// channel suffix, so adding a session never needs a new SUBSCRIBE call.
const CHANNEL_PREFIX = "pane:events:";
const CHANNEL_PATTERN = CHANNEL_PREFIX + "*";

// Whether this process has already wired the Redis SUBSCRIBE -> emitter bridge.
let subscriptionWired = false;

/**
 * Idempotently wire the per-replica Redis SUBSCRIBE connection so that every
 * message Redis delivers is re-emitted into the local EventEmitter. Called
 * lazily on the first publish/subscribe while Redis is on. Safe to call when
 * Redis is off (no-op).
 */
function ensureRedisSubscription(): void {
  if (subscriptionWired || !redisEnabled()) return;
  subscriptionWired = true;
  const sub = redisSub();

  // Each session publishes to its own channel `pane:events:<sessionId>`, so we
  // PATTERN-subscribe to `pane:events:*` with a single PSUBSCRIBE. A plain
  // SUBSCRIBE would treat `*` as a literal channel name and receive nothing —
  // glob matching requires PSUBSCRIBE, whose payloads arrive on `pmessage`
  // (pattern, channel, payload). Routing by the channel suffix means adding a
  // session never needs another subscribe call.
  sub.on("pmessage", (_pattern: string, channel: string, payload: string) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const sessionId = channel.slice(CHANNEL_PREFIX.length);
    try {
      const event = JSON.parse(payload) as SerializedEvent;
      // Re-emit into the local emitter — this is the ONLY thing that feeds
      // subscribers when Redis is on, so each event arrives exactly once.
      emitter.emit(sessionId, event);
    } catch (err) {
      log.warn("broadcast: failed to parse redis message", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  void sub.psubscribe(CHANNEL_PATTERN).catch((err: unknown) => {
    log.error("broadcast: redis psubscribe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Publish an event to every subscriber of `sessionId`, on this replica and —
 * when Redis is on — every other replica too.
 *
 * REDIS OFF: emit straight into the local emitter (original behaviour).
 * REDIS ON:  PUBLISH to Redis only. The local emitter is fed exclusively by
 *            the Redis subscription (see ensureRedisSubscription), so the
 *            publishing replica still receives its own event — exactly once.
 */
export function publish(sessionId: string, event: SerializedEvent): void {
  if (!redisEnabled()) {
    emitter.emit(sessionId, event);
    return;
  }
  ensureRedisSubscription();
  const channel = CHANNEL_PREFIX + sessionId;
  void redisPub()
    .publish(channel, JSON.stringify(event))
    .catch((err: unknown) => {
      // A mid-flight Redis error must not crash the relay. Log and drop —
      // ioredis is reconnecting; the event is lost for remote replicas but
      // the persisted Event row is still the source of truth on replay.
      log.warn("broadcast: redis publish failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function subscribe(
  sessionId: string,
  fn: (e: SerializedEvent) => void,
): () => void {
  // When Redis is on, make sure the SUBSCRIBE bridge is live before the first
  // subscriber registers, so no event is missed between subscribe and publish.
  ensureRedisSubscription();
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

// Test-only: drop the cached "subscription wired" flag and listeners so a test
// that toggles Redis on/off can re-wire. Not part of the public API.
export function _resetBroadcastForTests(): void {
  subscriptionWired = false;
  emitter.removeAllListeners();
}
