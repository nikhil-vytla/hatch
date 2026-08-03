import type { SessionEventEnvelope } from "../session/index.js";
import type { SessionId } from "../kernel/index.js";

/**
 * EventBus DO–shaped fan-out. SessionAgent persists; EventBus broadcasts.
 * Local adapter is an in-process pub/sub keyed by session id.
 */
export interface EventBus {
  publish(sessionId: SessionId, envelope: SessionEventEnvelope): void;
  subscribe(
    sessionId: SessionId,
    listener: (envelope: SessionEventEnvelope) => void,
  ): () => void;
}

export function createMemoryEventBus(): EventBus {
  const fans = new Map<string, Set<(e: SessionEventEnvelope) => void>>();
  return {
    publish(sessionId, envelope) {
      const set = fans.get(sessionId);
      if (!set) return;
      for (const listener of set) listener(envelope);
    },
    subscribe(sessionId, listener) {
      const key = sessionId;
      let set = fans.get(key);
      if (!set) {
        set = new Set();
        fans.set(key, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) fans.delete(key);
      };
    },
  };
}
