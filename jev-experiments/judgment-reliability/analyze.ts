import { writeRecord } from "../experience-prototypes/scripts/records";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, rng, type Pair } from "./protocol";
import { canonical, rank, official, transitions, range, compareVotes, type Vote } from "./scoring";
const here = dirname(fileURLToPath(import.meta.url));
export function loadEvidence() {
  const manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
  const raw = readFileSync(resolve(here, "cases.jsonl"), "utf8");
  if (hash(raw) !== manifest.cases_sha256) throw new Error("Case archive checksum mismatch");
  const pairs: Pair[] = raw.trim().split("\n").map(line => JSON.parse(line));
  const events = readFileSync(resolve(here, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const records = new Map<string, any>();
  for (const event of events) if (event.status === "completed") { if (records.has(event.id)) throw new Error(`Duplicate success ${event.id}`); if (event.protocol_sha256 !== manifest.protocol_sha256) throw new Error("Protocol drift"); records.set(event.id, event); }
  return { manifest, pairs, events, records };
}
function oriented(record: any, swap: boolean) {
  if (!record) return { pairwise: null as Vote, shared: null as Vote, displayed_pairwise: null as Vote, displayed_shared: null as Vote, pA: null, pB: null, scoreA: null, scoreB: null, confidence: null, record: null };
  const q = record.answers, scoreA = q[swap ? "b_correct" : "a_correct"].value, scoreB = q[swap ? "a_correct" : "b_correct"].value;
  return { pairwise: canonical(q.winner.value, swap), shared: rank(scoreA, scoreB), displayed_pairwise: q.winner.value as Vote, displayed_shared: rank(q.a_correct.value, q.b_correct.value), pA: q.winner.probabilities?.[swap ? "B" : "A"] ?? null, pB: q.winner.probabilities?.[swap ? "A" : "B"] ?? null, scoreA, scoreB, confidence: q.winner.confidence, record };
}
export function buildCases(pairs: Pair[], records: Map<string, any>) {
  return pairs.map(pair => {
    const runs = [0, 1, 2].map(repeat => {
      const AB = oriented(records.get(`${pair.pair_id}/r${repeat}/shared/AB`), false), BA = oriented(records.get(`${pair.pair_id}/r${repeat}/shared/BA`), true);
      const A = records.get(`${pair.pair_id}/r${repeat}/isolated/A`), B = records.get(`${pair.pair_id}/r${repeat}/isolated/B`);
      const scoreA = A?.answers.a_correct.value ?? null, scoreB = B?.answers.a_correct.value ?? null;
      const gold = pair.label[0] as "A" | "B";
      return { repeat, AB, BA, isolated: { scoreA, scoreB, winner: rank(scoreA, scoreB), records: [A ?? null, B ?? null] }, pairwise_official: official(AB.displayed_pairwise, BA.displayed_pairwise, gold), shared_official: official(AB.displayed_shared, BA.displayed_shared, gold) };
    });
    const repeatStability = (method: "pairwise" | "shared" | "isolated", orientation: "AB" | "BA" = "AB") => transitions(runs.map(r => method === "isolated" ? r.isolated.winner : r[orientation][method]));
    return { ...pair, runs, diagnostics: { position_flip: runs.some(r => compareVotes(r.AB.pairwise, r.BA.pairwise).identity_flip), pairwise_repeat_flip: repeatStability("pairwise", "AB").identity_flip || repeatStability("pairwise", "BA").identity_flip, shared_repeat_flip: repeatStability("shared", "AB").identity_flip || repeatStability("shared", "BA").identity_flip, isolated_repeat_flip: repeatStability("isolated").identity_flip, method_flip: runs.some(r => [r.AB, r.BA].some(o => compareVotes(o.pairwise, o.shared).identity_flip || compareVotes(o.pairwise, r.isolated.winner).identity_flip)), pointwise_tie: runs.some(r => r.AB.shared === "tie" || r.BA.shared === "tie" || r.isolated.winner === "tie") } };
  });
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function methodMetrics(cases: any[], repeat?: number) {
  const runs = cases.flatMap(c => c.runs.filter((r: any) => repeat == null || r.repeat === repeat).map((r: any) => ({ ...r, gold: c.label[0] })));
  const metrics: any = {};
  for (const method of ["pairwise", "shared"]) {
    const ordered = runs.flatMap(r => [r.AB, r.BA].map(o => ({ vote: o[method], gold: r.gold, pA: o.pA })));
    const answered = ordered.filter(o => o.vote != null), valid = runs.filter(r => r.AB[method] != null && r.BA[method] != null);
    const scores = runs.map(r => r[`${method}_official`]);
    metrics[method] = { planned_pairs: runs.length, completed_pairs: valid.length, official_correct: scores.filter(s => s.outcome === "correct").length, official_incorrect: scores.filter(s => s.outcome === "incorrect").length, official_ties: scores.filter(s => s.outcome === "tie").length, null_pairs: scores.filter(s => s.nulls).length, official_accuracy: mean(scores.map(s => s.correct)), ordered_completed: answered.length, ordered_planned: ordered.length, ordered_correct: answered.filter(o => o.vote === o.gold).length, ordered_accuracy: mean(answered.map(o => o.vote === o.gold ? 1 : 0)), exact_ties: answered.filter(o => o.vote === "tie").length, position_identity_flips: valid.filter(r => compareVotes(r.AB[method], r.BA[method]).identity_flip).length, position_tie_transitions: valid.filter(r => compareVotes(r.AB[method], r.BA[method]).tie_transition).length, position_flip_rate: mean(valid.map(r => compareVotes(r.AB[method], r.BA[method]).identity_flip ? 1 : 0)), ...(method === "pairwise" ? { brier: mean(answered.filter(o => o.pA != null).map(o => (o.pA - (o.gold === "A" ? 1 : 0)) ** 2)) } : {}) };
  }
  const validIsolated = runs.filter(r => r.isolated.winner != null);
  metrics.isolated = { planned_pairs: runs.length, completed_pairs: validIsolated.length, correct: validIsolated.filter(r => r.isolated.winner === r.gold).length, accuracy: mean(validIsolated.map(r => r.isolated.winner === r.gold ? 1 : 0)), ties: validIsolated.filter(r => r.isolated.winner === "tie").length };
  return metrics;
}
function stability(cases: any[]) {
  const out: any = {};
  for (const method of ["pairwise", "shared", "isolated"]) {
    const rows = cases.flatMap(c => (method === "isolated" ? ["AB"] : ["AB", "BA"]).map(orientation => {
      const votes = c.runs.map((r: any) => method === "isolated" ? r.isolated.winner : r[orientation][method]);
      const rs = c.runs.map((r: any) => method === "isolated" ? r.isolated : r[orientation]);
      return { ...transitions(votes), drift: method === "pairwise" ? range(rs.map((r: any) => r.pA)) : Math.max(range(rs.map((r: any) => r.scoreA)) ?? 0, range(rs.map((r: any) => r.scoreB)) ?? 0) };
    })).filter(r => r.complete);
    out[method] = { complete_sets: rows.length, planned_sets: cases.length * (method === "isolated" ? 1 : 2), identity_flips: rows.filter(r => r.identity_flip).length, identity_flip_rate: mean(rows.map(r => r.identity_flip ? 1 : 0)), tie_transitions: rows.filter(r => r.tie_transition).length, any_decision_changes: rows.filter(r => r.decision_changed).length, nonzero_score_drift: rows.filter(r => r.drift > 0).length, mean_score_range: mean(rows.map(r => r.drift)), max_score_range: rows.length ? Math.max(...rows.map(r => r.drift)) : null };
  }
  return out;
}
function methodComparisons(cases: any[]) {
  const rows = cases.flatMap(c => c.runs.flatMap((r: any) => [r.AB, r.BA].map(o => ({ gold: c.label[0], pairwise: o.pairwise, shared: o.shared, isolated: r.isolated.winner }))));
  return [["pairwise", "shared"], ["pairwise", "isolated"], ["shared", "isolated"]].map(([a, b]) => {
    const complete = rows.filter(r => r[a] != null && r[b] != null);
    return { methods: [a, b], matched_ordered_decisions: complete.length, planned: rows.length, identity_flips: complete.filter(r => compareVotes(r[a], r[b]).identity_flip).length, tie_transitions: complete.filter(r => compareVotes(r[a], r[b]).tie_transition).length, a_correct_b_wrong: complete.filter(r => r[a] === r.gold && r[b] !== r.gold).length, a_wrong_b_correct: complete.filter(r => r[a] !== r.gold && r[b] === r.gold).length };
  });
}
function distributions(cases: any[]) {
  return ["pairwise", "shared", "isolated"].map(method => {
    const values: number[] = cases.flatMap(c => c.runs.flatMap((r: any) => method === "isolated" ? r.isolated.scoreA == null || r.isolated.scoreB == null ? [] : [r.isolated.scoreA - r.isolated.scoreB] : [r.AB, r.BA].filter(o => method === "pairwise" ? o.pA != null && o.pB != null : o.scoreA != null && o.scoreB != null).map(o => method === "pairwise" ? o.pA - o.pB : o.scoreA - o.scoreB)));
    const bins = Array.from({ length: 20 }, (_, i) => ({ low: (i - 10) / 10, high: (i - 9) / 10, count: 0 }));
    for (const v of values) bins[Math.max(0, Math.min(19, Math.floor((v + 1) * 10)))].count++;
    return { method, n: values.length, bins, exact_zero: values.filter(v => v === 0).length };
  });
}
function bootstrap(cases: any[]) {
  const grouped = new Map<string, any[]>();
  for (const c of cases) { const key = `${c.source}/${c.original_id}`; grouped.set(key, [...(grouped.get(key) ?? []), c]); }
  const measures: Record<string, (c: any) => number | null> = {
    pairwise_official: c => c.runs.every((r: any) => !r.pairwise_official.nulls) ? mean(c.runs.map((r: any) => r.pairwise_official.correct)) : null,
    shared_official: c => c.runs.every((r: any) => !r.shared_official.nulls) ? mean(c.runs.map((r: any) => r.shared_official.correct)) : null,
    isolated_accuracy: c => c.runs.every((r: any) => r.isolated.winner != null) ? mean(c.runs.map((r: any) => r.isolated.winner === c.label[0] ? 1 : 0)) : null,
    pairwise_minus_shared_official: c => c.runs.every((r: any) => !r.shared_official.nulls && !r.pairwise_official.nulls) ? mean(c.runs.map((r: any) => r.pairwise_official.correct - r.shared_official.correct)) : null,
    pairwise_minus_isolated_ordered: c => c.runs.every((r: any) => r.isolated.winner != null && !r.pairwise_official.nulls) ? mean(c.runs.map((r: any) => ((r.AB.pairwise === c.label[0] ? 1 : 0) + (r.BA.pairwise === c.label[0] ? 1 : 0)) / 2 - (r.isolated.winner === c.label[0] ? 1 : 0))) : null,
  };
  return Object.entries(measures).map(([name, measure]) => {
    const clusters = [...grouped.values()].map(cs => cs.map(measure).filter((v): v is number => v != null)).filter(cs => cs.length);
    if (!clusters.length) return { name, clusters: 0, cases: 0, estimate: null, low: null, high: null };
    const sums = clusters.map(cs => cs.reduce((s, v) => s + v, 0)), sizes = clusters.map(cs => cs.length), random = rng(73421), draws: number[] = [];
    for (let b = 0; b < 10000; b++) { let total = 0, size = 0; for (let n = 0; n < clusters.length; n++) { const i = Math.floor(random() * clusters.length); total += sums[i]; size += sizes[i]; } draws.push(total / size); }
    draws.sort((a, b) => a - b); return { name, clusters: clusters.length, cases: sizes.reduce((a, b) => a + b, 0), estimate: sums.reduce((a, b) => a + b, 0) / sizes.reduce((a, b) => a + b, 0), low: draws[249], high: draws[9749] };
  });
}
export function summarize(evidence = loadEvidence()) {
  const { manifest, pairs, events, records } = evidence, cases = buildCases(pairs, records);
  const attempts = events.filter(e => e.event === "attempt"), completed = [...records.values()], batchResults = events.filter(e => e.event === "batch_completed"), latencies = batchResults.map(r => r.latency_ms).sort((a, b) => a - b);
  const bases = ["longer", "shorter"].map(method => ({ method, accuracy: mean(pairs.map(p => { const v = method === "longer" ? rank(p.response_A.length, p.response_B.length) : rank(p.response_B.length, p.response_A.length); return v === p.label[0] ? 1 : 0; })), ties: pairs.filter(p => p.response_A.length === p.response_B.length).length }));
  const result = { version: "judgment-reliability-v2", manifest, chunk_base: "/judgment-reliability/cases", archive: "/judgment-reliability/evidence.jsonl", source_archive: "/judgment-reliability/cases.jsonl", availability: { planned: 7440, completed: records.size, unavailable: 7440 - records.size, planned_decisions: 14880, completed_decisions: completed.reduce((n, r) => n + Object.keys(r.answers).length, 0), completed_batches: batchResults.length, transient_failed_invocations: events.filter(e => e.status === "failed" && e.transient).length, blocked_invocations: events.filter(e => e.status === "failed" && !e.transient).length, attempts: attempts.length, unsuccessful_attempts: attempts.filter(e => e.status !== 200).length, median_latency_ms: latencies[Math.floor(latencies.length / 2)] ?? null, p95_latency_ms: latencies[Math.floor(latencies.length * .95)] ?? null, returned_models: [...new Set(completed.map(r => r.model))], reported_cost_usd: batchResults.every(r => r.cost_usd != null) ? batchResults.reduce((n, r) => n + r.cost_usd, 0) : null, first_at: completed.map(r => r.started_at).sort()[0], last_at: completed.map(r => r.finished_at).sort().at(-1) }, metrics: { primary: methodMetrics(cases, 0), per_repeat: [0, 1, 2].map(r => ({ repeat: r, ...methodMetrics(cases, r) })), pooled: methodMetrics(cases), by_response_model: [...new Set(pairs.map(p => p.response_model))].map(model => ({ model, pairs: cases.filter(c => c.response_model === model).length, ...methodMetrics(cases.filter(c => c.response_model === model)) })), by_source: [...new Set(pairs.map(p => p.source.split("-")[0]))].map(source => ({ source, pairs: cases.filter(c => c.source.split("-")[0] === source).length, ...methodMetrics(cases.filter(c => c.source.split("-")[0] === source)) })), stability: stability(cases), comparisons: methodComparisons(cases), distributions: distributions(cases), confidence_intervals: bootstrap(cases), baselines: [{ method: "fixed displayed A", official_accuracy: 0, ordered_accuracy: .5 }, { method: "independent fair votes, expectation", official_accuracy: .25, ordered_accuracy: .5 }, { method: "canonical fair vote held across swaps, expectation", official_accuracy: .5, ordered_accuracy: .5 }, ...bases.map(b => ({ ...b, official_accuracy: b.accuracy, ordered_accuracy: b.accuracy }))] }, case_index: cases.map(c => ({ pair_id: c.pair_id, source: c.source, response_model: c.response_model, original_id: c.original_id, gate: c.gate.required, diagnostics: c.diagnostics, content_hash: c.content_hash })) };
  return { result, cases };
}
if (import.meta.main) { const { result } = summarize(); writeRecord(resolve(here, "results.jsonl"), { name: "judgment-reliability", result }); console.log(JSON.stringify({ completion: result.availability, primary: result.metrics.primary, stability: result.metrics.stability }, null, 2)); }
