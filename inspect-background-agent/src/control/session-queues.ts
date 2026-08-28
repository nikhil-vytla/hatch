/**
 * Per-session serial prompt queue.
 * One OpenCode process per sandbox at a time; later prompts wait.
 */
export class SessionQueues {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prev.then(work, work).then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, next);
    return next;
  }

  pending(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }

  /** Drop the tail pointer after idle so the map does not grow forever. */
  async drain(sessionId: string): Promise<void> {
    const tail = this.tails.get(sessionId);
    if (tail) await tail;
    this.tails.delete(sessionId);
  }
}
