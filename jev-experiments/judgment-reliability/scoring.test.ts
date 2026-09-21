import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonical, rank, official, transitions, compareVotes, range } from "./scoring";
import { payload, tasks, hash, PROTOCOL, POLICY_STATE, encodedQuestions, type Pair } from "./protocol";
import { buildCases, summarize } from "./analyze";
import { sourceClusterKey, analysisMetadata } from "./clustering";
const pairs: Pair[] = readFileSync(new URL("cases.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
test("official upstream signed two-order rule including null and tie votes", () => {
  expect(official("A", "B", "A").outcome).toBe("correct");
  expect(official("A", "A", "A").outcome).toBe("tie");
  expect(official("B", "A", "A").outcome).toBe("incorrect");
  expect(official("B", "A", "B").outcome).toBe("correct");
  expect(official("A", null, "A")).toMatchObject({ outcome: "correct", nulls: true });
  expect(official(null, "B", "A")).toMatchObject({ outcome: "correct", nulls: true });
  expect(official("tie", "B", "A").outcome).toBe("correct");
  expect(official("tie", "tie", "A").outcome).toBe("tie");
  expect(official(null, null, "A").outcome).toBe("tie");
  for (const gold of ["A", "B"] as const) for (const a of ["A", "B", "tie", null] as const) for (const b of ["A", "B", "tie", null] as const) {
    const reverse = b === "A" ? "B" : b === "B" ? "A" : b;
    const score = [a, reverse].reduce((s, v) => s + (v === gold ? 1 : v && v !== "tie" ? -1 : 0), 0);
    expect(official(a, b, gold).correct).toBe(Number(score > 0));
  }
});
test("identity remapping, ties and score drift are distinct", () => {
  for (const v of ["A", "B", "tie", null] as const) expect(canonical(canonical(v, true), true)).toBe(v);
  expect(rank(.4, .4)).toBe("tie"); expect(rank(.4, null)).toBeNull();
  expect(transitions(["A", "A", "A"]).identity_flip).toBe(false);
  expect(transitions(["A", "tie", "A"])).toMatchObject({ identity_flip: false, tie_transition: true });
  expect(transitions(["A", "B", "A"]).identity_flip).toBe(true);
  expect(compareVotes("A", null).complete).toBe(false);
  expect(range([.7, .8, .7])).toBeCloseTo(.1);
});
test("full released coverage, two splits and corrected source clusters", () => {
  expect(pairs.length).toBe(620); expect(new Set(pairs.map(p => p.pair_id)).size).toBe(620);
  expect(pairs.filter(p => p.response_model.startsWith("gpt")).length).toBe(350);
  expect(pairs.filter(p => p.response_model.startsWith("claude")).length).toBe(270);
  expect(new Set(pairs.map(sourceClusterKey)).size).toBe(528);
  // The historical value is preserved in the immutable request protocol, not
  // reused as the number of independent source questions in current analysis.
  expect(PROTOCOL.source_questions).toBe(268);
  expect(tasks(pairs).length).toBe(7440);
  expect(new Set(tasks(pairs).map(t => t.id)).size).toBe(7440);
});

test("missing IDs group exact repeated questions without merging an entire source", () => {
  const pair = { source: "livebench-math", original_id: null, question: "First question" };
  expect(sourceClusterKey(pair)).toBe(sourceClusterKey({ ...pair }));
  expect(sourceClusterKey(pair)).toBe(sourceClusterKey({ ...pair, original_id: undefined }));
  expect(sourceClusterKey(pair)).not.toBe(sourceClusterKey({ ...pair, question: "Other question" }));
  expect(sourceClusterKey(pair)).not.toBe(sourceClusterKey({ ...pair, question: "First question " }));
  expect(sourceClusterKey(pair)).not.toBe(sourceClusterKey({ ...pair, source: "another-source" }));
  expect(sourceClusterKey(pair)).toBe(sourceClusterKey({ ...pair, original_id: hash(pair.question) }));
  expect(sourceClusterKey({ ...pair, original_id: 1 })).toBe(sourceClusterKey({ ...pair, original_id: 2 }));
  expect(() => analysisMetadata([{ ...pair, original_id: 0 }, { ...pair, original_id: 0, question: "Different rendering" }], 1)).toThrow("connected-component");
});

test("analysis amendment reports fallback coverage and the identical-text source-ID exception", () => {
  expect(analysisMetadata(pairs, PROTOCOL.source_questions)).toMatchObject({
    version: "judge-reliability-analysis-v2.1", source_clusters: 528,
    frozen_protocol_source_questions: 268,
    pairs_with_source_id: 308, pairs_without_source_id: 312,
    nonnull_source_id_groups: 265, null_id_question_groups: 264,
    distinct_question_texts: 528, same_text_distinct_id_groups: 1,
    source_id_multiple_text_groups: 0,
    bootstrap: { draws: 10000, seed: 73421 },
  });
  const duplicateText = pairs.filter(p => p.source === "mmlu-pro-health" && [6274, 6275].includes(Number(p.original_id)));
  expect(duplicateText).toHaveLength(2);
  expect(new Set(duplicateText.map(sourceClusterKey)).size).toBe(1);
});

test("analysis correction preserves complete decisions and headline scores while updating intervals", () => {
  const { result } = summarize();
  expect(result.availability.completed).toBe(7440);
  expect(result.availability.completed_decisions).toBe(14880);
  expect(result.metrics.per_repeat.map(r => [r.pairwise.official_correct, r.pairwise.ordered_correct, r.pairwise.position_identity_flips])).toEqual([[411, 926, 104], [404, 922, 114], [409, 924, 106]]);
  expect(result.metrics.stability.pairwise).toMatchObject({ complete_sets: 1240, identity_flips: 53, nonzero_score_drift: 1079 });
  expect(result.analysis.evidence_coverage).toEqual({ normalized_questions: 14880, raw_matched_questions: 14614, normalized_only_questions: 266, normalized_only_batches: 21 });
  for (const interval of result.metrics.confidence_intervals) expect(interval).toMatchObject({ cases: 620, clusters: 528 });
  const officialInterval = result.metrics.confidence_intervals.find(x => x.name === "pairwise_official")!;
  expect(officialInterval.estimate).toBeCloseTo(1224 / 1860, 14);
  expect(officialInterval.low).toBeCloseTo(0.6211878009630817, 14);
  expect(officialInterval.high).toBeCloseTo(0.6945786366076222, 14);
});
test("swap preserves byte-exact candidates, no label leakage, repeat bodies unchanged", () => {
  for (const pair of pairs) {
    const ts = tasks([pair]), ab = payload(pair, ts[0]), ba = payload(pair, ts[1]);
    expect(ab.state.A).toBe(pair.response_A); expect(ba.state.A).toBe(pair.response_B);
    expect(ab.state.B).toBe(pair.response_B); expect(ba.state.B).toBe(pair.response_A);
    for (const t of ts) { const p = payload(pair, t); expect(Object.keys(p.state).sort()).toEqual(t.condition === "shared" ? ["A", "B", "question"] : ["A", "question"]); }
    expect(hash(JSON.stringify(ab))).toBe(hash(JSON.stringify(payload(pair, ts[4]))));
    expect(hash(JSON.stringify(ab))).toBe(hash(JSON.stringify(payload(pair, ts[8]))));
    expect(Object.keys(payload(pair, ts[2]).questions)).toEqual(["a_correct"]);
    expect(payload(pair, ts[2]).questions.a_correct).toEqual(PROTOCOL.questions.a_correct);
  }
});
test("prior human content gates matched exactly remain gated", () => {
  expect(pairs.filter(p => p.gate.origin.startsWith("prior")).length).toBe(10);
  expect(pairs.filter(p => p.gate.required).length).toBe(21);
  for (const p of pairs) expect(p.content_hash).toBe(hash(JSON.stringify([p.question, p.response_A, p.response_B])));
});
test("canonical repeated observation matrix retains wrong answers and full pairs", () => {
  const p = pairs[0], ids = tasks([p]), records = new Map();
  for (const t of ids) records.set(t.id, { answers: t.condition === "shared" ? { winner: { value: "A", probabilities: { A: .7, B: .3 }, confidence: .7 }, a_correct: { value: .8 }, b_correct: { value: .2 } } : { a_correct: { value: t.candidate === "A" ? .4 : .4 } } });
  const c = buildCases([p], records)[0];
  expect(c.runs).toHaveLength(3); expect(c.runs[0].AB.pairwise).toBe("A"); expect(c.runs[0].BA.pairwise).toBe("B");
  expect(c.runs[0].BA.scoreA).toBe(.2); expect(c.runs[0].BA.scoreB).toBe(.8);
  expect(c.runs[0].isolated.winner).toBe("tie"); expect(c.diagnostics.position_flip).toBe(true);
  expect(c.diagnostics.pairwise_repeat_flip).toBe(false);
});

test("native batching preserves exact per-question evidence and repeat hashes", () => {
  expect(POLICY_STATE).not.toContain("label");
  for (const pair of pairs) {
    const ts = tasks([pair]);
    for (let i=0;i<4;i++) {
      const qs = encodedQuestions(pair, ts[i]);
      expect(qs).toEqual(encodedQuestions(pair, ts[i+4]));
      expect(qs).toEqual(encodedQuestions(pair, ts[i+8]));
      for (const q of Object.values(qs) as any[]) {
        const evidence=JSON.parse(q.instructions.split("<evidence>\n")[1].split("\n</evidence>")[0]);
        expect(evidence).toEqual(payload(pair,ts[i]).state);
        expect(q.instructions.length).toBeLessThan(12000);
      }
    }
  }
});
