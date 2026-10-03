/** Offline audit. Run from the repository root with bun run <this path>. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const decode = (path: string) => {
  const lines = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  const doc = lines[0].document;
  for (const { path, index, value } of lines.slice(1)) {
    let arr = doc;
    for (const key of path) arr = arr[key];
    if (arr.length !== index) throw new Error("Noncontiguous result");
    arr.push(value);
  }
  return doc;
};
const doc = decode(`${root}/results/optimize.jsonl`);
const result = doc.result;
const methods = result.methods;
const baseline = new Map(methods.unchanged.test_rows.map((r: any) => [r.id, r]));
const count = (rows: any[], key: (r: any) => string) => {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
};
const wilson = (hits: number, n: number) => {
  const z = 1.959963984540054, p = hits / n, denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const width = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [center - width, center + width];
};
const summary: any = {
  run: doc.manifest.id,
  source: result.sources["PolyAI-LDN/task-specific-datasets"],
  resumedFrom: result.resumed_from,
  splits: Object.fromEntries(Object.entries(result.splits).map(([k, v]: any) => [k, { count: v.length, unique: new Set(v).size }])),
  trainValidationOverlap: result.splits.train.filter((id: string) => result.splits.validation.includes(id)),
  methods: Object.fromEntries(Object.entries(methods).map(([name, method]: any) => {
    const rows = method.test_rows;
    const correct = rows.filter((r: any) => r.target === r.prediction).length;
    return [name, {
      validation: method.validation_accuracy,
      metricCalls: method.metric_calls,
      candidates: method.history?.length ?? 0,
      uniquePrompts: new Set(method.history?.map((h: any) => h.prompt)).size,
      validationHistory: method.history?.map((h: any) => h.validation_accuracy),
      changedPrompt: method.prompt !== methods.unchanged.prompt,
      answered: rows.filter((r: any) => r.prediction).length,
      attempted: rows.length,
      correct,
      wilson95: wilson(correct, rows.length),
      targetCounts: count(rows, r => r.target),
      disagreementIds: rows.filter((r: any) => r.prediction !== (baseline.get(r.id) as any).prediction).map((r: any) => r.id),
      errors: rows.filter((r: any) => r.target !== r.prediction).map((r: any) => ({ id: r.id, target: r.target, prediction: r.prediction })),
    }];
  })),
};
summary.runs = [];
for (const name of readdirSync(`${root}/runs`).filter(n => n.includes("-optimize-")).sort()) {
  const dir = `${root}/runs/${name}`;
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const raw = existsSync(`${dir}/result.json`) ? JSON.parse(readFileSync(`${dir}/result.json`, "utf8")) : {};
  const requests = readFileSync(`${dir}/requests.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  const successful = requests.filter(r => r.status === "ok");
  const logical: any[][] = [];
  for (const req of requests) {
    if (req.attempt === 1 || !logical.length) logical.push([]);
    logical.at(-1)!.push(req);
  }
  summary.runs.push({
    name, status: manifest.status, config: manifest.config,
    resumedFrom: raw.resumed_from,
    statuses: count(requests, r => String(r.http_status ?? r.status)),
    attemptsByTag: count(requests, r => r.tag),
    successesByTag: count(successful, r => r.tag),
    scoredRecordsByTag: Object.fromEntries([...new Set(successful.map(r => r.tag))].map(tag => [tag, successful.filter(r => r.tag === tag).reduce((n, r) => n + Object.keys(r.request.questions ?? {}).length, 0)])),
    reflectionFinishReasons: count(successful.filter(r => r.tag === "gepa/reflect"), r => r.response.choices[0].finish_reason),
    failedEvaluationBatches: logical.filter(group => group.at(-1).status !== "ok" && group[0].request.questions).map(group => ({
      tag: group[0].tag,
      recordCount: Object.keys(group[0].request.questions).length,
      attemptCount: group.length,
      statuses: group.map(r => r.http_status),
      requestHash: group[0].request_hash,
      prompt: Object.values(group[0].request.questions)[0].instructions,
    })),
    methods: Object.fromEntries(Object.entries(raw.methods ?? {}).map(([k, v]: any) => [k, {
      validation: v.validation_accuracy, metricCalls: v.metric_calls,
      candidates: v.history?.length ?? 0,
      validationHistory: v.history?.map((h: any) => h.validation_accuracy),
      test: v.test?.accuracy_all_attempted, failed: v.test?.failed,
      sameFrozenPromptAsPublished: v.prompt === methods[k]?.prompt,
    }])),
  });
}
console.log(JSON.stringify(summary, null, 2));
