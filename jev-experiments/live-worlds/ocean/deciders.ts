/**
 * The reef's deciders, as adapters at the session's one seam (session.ts `Decider`): the
 * hand-written rule, the evolved policy, MobileBERT, Jev, and a recorded run. How often each is
 * asked, and whether the world waits for it, is the session's timing, not the adapter's.
 */
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import { JEV_USD_PER_INPUT_TOKEN } from "../../packages/jev-client/src/price";
import { view, type Decision, type View } from "./engine";
import { BROWSER_MODEL, decideWithNli, fromJev, JEV_MODEL, jevRequest } from "./models";
import { decideAll, POLICY_NAME, type Policy } from "./policy";
import type { Recording } from "./replay";
import { RULE_NAME, ruleDecisions } from "./rule";
import type { Asked, Played } from "./session";

export const rule: Asked = { name: RULE_NAME, decide: (w, fish) => ruleDecisions(w, fish) };

export const evolved = (p: Policy): Asked => ({ name: POLICY_NAME, decide: (w, fish) => decideAll(w, p, fish) });

/**
 * MobileBERT, one fish at a time, with whatever runs the classifier: in-process (the held-out
 * table) or a worker (the page). Null from `decideOne` means no answer for that fish.
 */
export const nli = (decideOne: (v: View) => Promise<Decision | null>): Asked => ({
  name: BROWSER_MODEL,
  async decide(w, fish) {
    const ds = (await Promise.all(fish.map((f) => decideOne(view(w, f))))).filter((d): d is Decision => d !== null);

    return ds.length ? { decisions: ds, latencyMs: ds[0].latencyMs } : null;
  },
});

/** MobileBERT in this process. */
export const nliInProcess = (clf: ZeroShot) => nli((v) => decideWithNli(clf, v));

/** What a Jev transport returns: the /api/evaluate body, or null for no answer this time. */
export type JevWire = { answers?: Record<string, { value?: unknown; probabilities?: unknown }>; latency_ms?: number | null; usage?: { input_tokens?: number } | null; served_by?: string | null };

/**
 * Jev, one batch of fish per request, over any transport: the jev-client gateway call in Node
 * (record.ts), the live-ask module in the browser (the page). The transport may throw to stop
 * the run, or return null to skip this batch.
 */
export const jev = (send: (request: ReturnType<typeof jevRequest>) => Promise<JevWire | null | undefined>): Asked => ({
  name: JEV_MODEL,
  async decide(w, fish) {
    const views = fish.map((f) => view(w, f));
    const r = await send(jevRequest(views));

    if (!r) return null;

    const tokens = r.usage?.input_tokens ?? null;

    return {
      decisions: fromJev(views, r.answers ?? {}, r.latency_ms ?? null),
      latencyMs: r.latency_ms ?? null,
      inputTokens: tokens,
      costUsd: tokens === null ? null : tokens * JEV_USD_PER_INPUT_TOKEN,
      servedBy: r.served_by ?? null,
    };
  },
});

export const recorded = (recording: Recording): Played => ({ name: recording.model, recording });
