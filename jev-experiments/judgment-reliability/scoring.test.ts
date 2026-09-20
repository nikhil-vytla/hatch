import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonical, rank, official, transitions, compareVotes, range } from "./scoring";
import { payload, tasks, hash, PROTOCOL, POLICY_STATE, encodedQuestions, type Pair } from "./protocol";
import { buildCases } from "./analyze";
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
test("full released coverage, two splits and question clusters", () => {
  expect(pairs.length).toBe(620); expect(new Set(pairs.map(p => p.pair_id)).size).toBe(620);
  expect(pairs.filter(p => p.response_model.startsWith("gpt")).length).toBe(350);
  expect(pairs.filter(p => p.response_model.startsWith("claude")).length).toBe(270);
  expect(new Set(pairs.map(p => `${p.source}/${p.original_id}`)).size).toBe(268);
  expect(tasks(pairs).length).toBe(7440);
  expect(new Set(tasks(pairs).map(t => t.id)).size).toBe(7440);
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
