import { makeBatches, readScores, type Artwork, type SearchMode, type SearchScores, type SearchBatch } from "./protocol";
/** A changed query or unmount invalidates every callback from the previous request. */
export class SearchSession {
  private generation = 0;
  private controller: AbortController | null = null;
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
  begin() { this.cancel(); const generation = this.generation, controller = new AbortController(); this.controller = controller; return { signal: controller.signal, active: () => generation === this.generation && !controller.signal.aborted }; }
}
export type SearchRun = { query: string; scores: Record<SearchMode, SearchScores>; completed: number; total: number; batches: number; elapsed_ms: number; source: "live"; errors: string[] };
export async function runSearch(options: { works: Artwork[]; query: string; session: SearchSession; evaluate: (batch: SearchBatch, signal: AbortSignal) => Promise<any>; initial?: Record<SearchMode, SearchScores>; onProgress: (run: SearchRun) => void }) {
  const token = options.session.begin(), started = Date.now();
  const scores = { metadata: { ...options.initial?.metadata }, caption: { ...options.initial?.caption } };
  let batches = 0;
  const snapshot = (errors: string[] = []): SearchRun => ({ query: options.query, scores: { metadata: { ...scores.metadata }, caption: { ...scores.caption } }, completed: Object.values(scores).reduce((n, values) => n + Object.values(values).filter(v => typeof v === "number" && Number.isFinite(v)).length, 0), total: options.works.length * 2, batches, elapsed_ms: Date.now() - started, source: "live", errors });
  // Alternate modes at each batch position to keep acquisition windows close.
  const queues = ["metadata", "caption"].map(mode => makeBatches(options.works, options.query, mode as SearchMode, scores[mode as SearchMode]));
  for (let i = 0; i < Math.max(...queues.map(q => q.length)); i++) for (const queue of queues) {
    const batch = queue[i]; if (!batch || !token.active()) continue;
    try {
      const response = await options.evaluate(batch, token.signal);
      if (!token.active()) return null;
      Object.assign(scores[batch.mode], readScores(batch, response)); batches++; options.onProgress(snapshot());
    } catch (e) { if (!token.active()) return null; const result = snapshot([e instanceof Error ? e.message : String(e)]); options.onProgress(result); return result; }
  }
  return token.active() ? snapshot() : null;
}
