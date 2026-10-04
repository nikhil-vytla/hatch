import { createHash } from "node:crypto";
import { questions, type Pair } from "./wire";
export { encodedQuestion, encodedQuestions, payload, POLICY_STATE, questions, type Pair, type Task } from "./wire";
export const SOURCE_COMMIT = "e2c52c284e735e139b3daa61c206ee208f36c461";
export const MODELS = ["gpt-4o-2024-05-13", "claude-3-5-sonnet-20240620"];
export const REPEATS = [0, 1, 2];
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function tasks(pairs: Pair[]) {
  return REPEATS.flatMap(repeat => pairs.flatMap(pair => [
    ...[false, true].map(swap => ({ id: `${pair.pair_id}/r${repeat}/shared/${swap ? "BA" : "AB"}`, pair_id: pair.pair_id, repeat, condition: "shared" as const, swap })),
    ...["A", "B"].map(candidate => ({ id: `${pair.pair_id}/r${repeat}/isolated/${candidate}`, pair_id: pair.pair_id, repeat, condition: "isolated" as const, candidate: candidate as "A" | "B" })),
  ]));
}
export function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function shuffled<T>(input: T[], seed: number) { const out = [...input], random = rng(seed); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
export const PROTOCOL = {
  version: "judge-reliability-v2", model: "typesafe-ai/jev", repeats: 3, schedule_seeds: [42, 43, 44],
  pairs: 620, source_questions: 268, response_models: { [MODELS[0]]: 350, [MODELS[1]]: 270 },
  logical_evaluations: 7440, question_decisions: 14880, max_batch_bytes: 64000, max_batch_questions: 24, questions,
  shared: "Every pairwise and whole-answer question contains the complete pair evidence in its own instructions. Both candidate orientations. Constant shared policy state. Independent questions batch by byte budget; each question carries only its own exact input information. This is a new protocol, separate from the state-encoded historical/pilot run.",
  isolated: "Each canonical candidate alone as evidence A inside its own a_correct question. No opponent, source label, response model, correct label, or previous output in its independent question context.",
  repeats_control: "Three independently recorded passes with unchanged per-question hashes. Seeds shuffle scheduling only, not model sampling. Conditions interleaved within each pass; passes run sequentially.",
  scoring: "Official scorer reverses the second displayed vote, adds +1 for gold, -1 for its opposite and 0 for explicit tie/null, then credits positive sum. Availability is reported separately. Shared pointwise equal scores remain ties. Isolated scoring ranks two separately scored candidates once per repeat and has no two-order score.",
  uncertainty: "10000 paired bootstrap draws over source plus original_id question clusters. Both response models, pairs, repeats and orientations stay in a cluster. Intervals address broader question variation, not uncertainty in the finite benchmark tally.",
  baseline: "Fixed displayed A, independent fair votes, canonical fair vote held across swaps, longer and shorter canonical response character count with exact length ties.",
  retry: "Append-only attempt and result events. Retry only transient transport/status failures; never retry wrong model answers or malformed successful responses. Resume verifies source, protocol and request hashes and preserves first successful result.",
};

