import type { Actor } from "../identity/index.js";
import type { SessionId, TurnId } from "../kernel/index.js";

export type IngressPrompt = {
  readonly sessionId: SessionId;
  readonly author: Actor;
  readonly text: string;
  readonly clientToken?: string;
  readonly turnId: TurnId;
};

/**
 * Modal Queue–shaped prompt ingress. Clients enqueue here even if the sandbox
 * is cold; the Runner drains when ready.
 */
export interface PromptIngress {
  enqueue(prompt: IngressPrompt): void;
  /** Non-blocking; returns undefined when empty. */
  tryDequeue(sessionId: SessionId): IngressPrompt | undefined;
  pending(sessionId: SessionId): number;
}

export function createMemoryPromptIngress(): PromptIngress {
  const queues = new Map<string, IngressPrompt[]>();
  return {
    enqueue(prompt) {
      const q = queues.get(prompt.sessionId) ?? [];
      if (prompt.clientToken) {
        const dup = q.find((p) => p.clientToken === prompt.clientToken);
        if (dup) return;
      }
      q.push(prompt);
      queues.set(prompt.sessionId, q);
    },
    tryDequeue(sessionId) {
      const q = queues.get(sessionId);
      if (!q || q.length === 0) return undefined;
      const next = q.shift()!;
      if (q.length === 0) queues.delete(sessionId);
      else queues.set(sessionId, q);
      return next;
    },
    pending(sessionId) {
      return queues.get(sessionId)?.length ?? 0;
    },
  };
}
