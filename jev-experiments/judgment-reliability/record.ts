import { readFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, GatewayError } from "../experience-prototypes/scripts/local-model";
import { hash, tasks, shuffled, PROTOCOL, POLICY_STATE, encodedQuestions, type Pair, type Task } from "./protocol";
const here = dirname(fileURLToPath(import.meta.url)), file = resolve(here, "events.jsonl"), lock = resolve(here, ".recording.lock");
const handle = openSync(lock, "wx");
const cleanup = () => { try { closeSync(handle); unlinkSync(lock); } catch {} }; process.on("exit", cleanup); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const raw = readFileSync(resolve(here, "cases.jsonl"), "utf8"), manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
const pairs: Pair[] = raw.trim().split("\n").map(line => JSON.parse(line)), byPair = new Map(pairs.map(p => [p.pair_id, p])), all = tasks(pairs), done = new Map<string, any>(), blocked = new Set<string>();
if (hash(raw) !== manifest.cases_sha256 || hash(JSON.stringify({ protocol: PROTOCOL, policy_state: POLICY_STATE, encoder: encodedQuestions(pairs[0], tasks([pairs[0]])[0]) })) !== manifest.protocol_sha256) throw new Error("Source/protocol drift");
const prior = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
for (const e of prior) { if (e.status === "completed") { if (done.has(e.id)) throw new Error(`Duplicate completion ${e.id}`); done.set(e.id, e); } if (e.status === "failed" && !e.transient) for (const id of e.task_ids ?? []) blocked.add(id); }
// Recover a returned batch if a process stopped before its normalized records were appended.
for (const b of prior.filter(e => e.event === "batch_completed" && e.answers)) {
  const request = prior.find(e => e.event === "batch_request" && e.batch_id === b.batch_id);
  if (!request) throw new Error(`Missing batch mapping ${b.batch_id}`);
  const taskIds = [...new Set(request.mapping.map((m: any) => m.task.id))];
  for (const id of taskIds) if (!done.has(id as string)) {
    const mapping = request.mapping.filter((m: any) => m.task.id === id), task = mapping[0].task;
    const recovered = { ...task, batch_id: b.batch_id, wire_sha256: b.wire_sha256, protocol_sha256: b.protocol_sha256, request_sha256: hash(JSON.stringify(encodedQuestions(byPair.get(task.pair_id)!, task))), question_hashes: Object.fromEntries(mapping.map((m: any) => [m.name, m.question_sha256])), status: "completed", started_at: b.started_at, finished_at: b.finished_at, answers: Object.fromEntries(mapping.map((m: any) => [m.name, b.answers[m.wire_id]])), model: b.model, latency_ms: b.latency_ms, retries: b.retries, cost_usd: null, source: "live", batch_question_count: request.mapping.length, recovered_from_completed_batch: true };
    appendFileSync(file, JSON.stringify(recovered) + "\n"); done.set(id as string, recovered);
  }
}
for (const t of all) { const e = done.get(t.id); if (e && e.request_sha256 !== hash(JSON.stringify(encodedQuestions(byPair.get(t.pair_id)!, t)))) throw new Error(`Question drift ${t.id}`); }
const write = (data: any) => appendFileSync(file, JSON.stringify(data) + "\n");
const concurrency = Number(process.env.JUDGE_CONCURRENCY ?? 1), limit = Number(process.env.JUDGE_BATCH_LIMIT ?? Infinity); let completed = 0, started = 0, failures = 0, cooldown = 0;
type Batch = { tasks: Task[]; body: { state: string; questions: Record<string, any> }; mapping: { task: Task; name: string; wire_id: string; question_sha256: string }[] };
function batches(pending: Task[]) {
  const out: Batch[] = []; let current: Batch = { tasks: [], body: { state: POLICY_STATE, questions: {} }, mapping: [] };
  for (const task of pending) {
    const qs = encodedQuestions(byPair.get(task.pair_id)!, task);
    if (Object.values(qs).some((q: any) => q.instructions.length > 12000)) throw new Error(`Question context too large ${task.id}`);
    const add = (batch: Batch) => { const qid = batch.mapping.length; const mapping = Object.entries(qs).map(([name, question], i) => ({ task, name, wire_id: `q${String(qid + i).padStart(3, "0")}`, question_sha256: hash(JSON.stringify(question)) })); return { tasks: [...batch.tasks, task], body: { state: POLICY_STATE, questions: { ...batch.body.questions, ...Object.fromEntries(mapping.map(m => [m.wire_id, qs[m.name]])) } }, mapping: [...batch.mapping, ...mapping] }; };
    let next = add(current);
    if (current.tasks.length && (Buffer.byteLength(JSON.stringify(next.body)) > PROTOCOL.max_batch_bytes || next.mapping.length > PROTOCOL.max_batch_questions)) { out.push(current); current = { tasks: [], body: { state: POLICY_STATE, questions: {} }, mapping: [] }; next = add(current); }
    if (Buffer.byteLength(JSON.stringify(next.body)) > PROTOCOL.max_batch_bytes) throw new Error(`Single case exceeds batch budget ${task.id}`);
    current = next;
  }
  if (current.tasks.length) out.push(current); return out;
}
async function one(batch: Batch) {
  const wire_sha256 = hash(JSON.stringify(batch.body)), batch_id = `${batch.tasks[0].repeat}/${hash(JSON.stringify({ wire_sha256, task_ids: batch.tasks.map(t => t.id) }))}`, at = new Date().toISOString();
  const base = { batch_id, wire_sha256, protocol_sha256: manifest.protocol_sha256, started_at: at };
  write({ ...base, event: "batch_request", bytes: Buffer.byteLength(JSON.stringify(batch.body)), question_count: batch.mapping.length, mapping: batch.mapping });
  try {
    const out = await evaluate(batch.body, { deadlineMs: 115000, fetcher: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok) {
        const allowed = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"];
        const headers = Object.fromEntries(allowed.map(name => [name, response.headers.get(name)]).filter(([, value]) => value != null));
        let provider_error: any = null;
        if (response.status === 429) { try { const raw = await response.clone().json(); const e = raw.error ?? raw; const sanitize = (value: unknown) => typeof value === "string" ? value.replaceAll(process.env.AI_GATEWAY_API_KEY ?? "__no_key__", "[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_\-]{48,}/g, "[redacted]").slice(0, 500) : null; provider_error = { code: sanitize(e.code), type: sanitize(e.type), message: sanitize(e.message) }; } catch {} }
        write({ ...base, event: "provider_failure_metadata", at: new Date().toISOString(), http_status: response.status, rate_limit_headers: headers, provider_error });
      }
      return response;
    }, onAttempt: attempt => { write({ ...base, event: "attempt", at: new Date().toISOString(), ...attempt }); if (attempt.status === 429 || attempt.status === 503) cooldown = Date.now() + 10000; } });
    write({ ...base, event: "batch_completed", finished_at: new Date().toISOString(), question_count: batch.mapping.length, latency_ms: out.latency_ms, retries: out.retries, cost_usd: out.cost_usd, model: out.model, answers: out.answers });
    for (const task of batch.tasks) {
      const mapping = batch.mapping.filter(m => m.task.id === task.id), answers = Object.fromEntries(mapping.map(m => [m.name, out.answers[m.wire_id]]));
      const record = { ...task, ...base, request_sha256: hash(JSON.stringify(encodedQuestions(byPair.get(task.pair_id)!, task))), question_hashes: Object.fromEntries(mapping.map(m => [m.name, m.question_sha256])), status: "completed", finished_at: new Date().toISOString(), answers, model: out.model, latency_ms: out.latency_ms, retries: out.retries, cost_usd: null, source: "live", batch_question_count: batch.mapping.length }; write(record); done.set(task.id, record); completed++;
    }
  } catch (error) {
    const e = error as GatewayError; const transient = [408, 429, 500, 502, 503, 504].includes(e.status) && !/invalid (JSON|answer|confidence|probabilities)/i.test(e.message);
    write({ ...base, status: "failed", task_ids: batch.tasks.map(t => t.id), finished_at: new Date().toISOString(), transient, error: e.message, http_status: e.status ?? null, attempts: e.attempts ?? [] }); failures++; if (!transient) for (const t of batch.tasks) blocked.add(t.id); else cooldown = Date.now() + 15000;
    if ([401, 403].includes(e.status)) throw e;
  }
  console.log(JSON.stringify({ completed: done.size, planned: all.length, questions_completed: [...done.values()].reduce((n, r) => n + Object.keys(r.answers).length, 0), batches_started: started, failures, blocked: blocked.size, at: new Date().toISOString() }));
}
console.log(JSON.stringify({ event: "resume", completed: done.size, planned: all.length, concurrency, protocol_sha256: manifest.protocol_sha256 }));
for (const repeat of [0, 1, 2]) {
  for (let sweep = 0; sweep < 5; sweep++) {
    const pending = batches(shuffled(all.filter(t => t.repeat === repeat && !done.has(t.id) && !blocked.has(t.id)), 42 + repeat + sweep * 1000)); let next = 0;
    if (!pending.length || started >= limit) break;
    write({ event: "schedule", repeat, sweep, seed: 42 + repeat + sweep * 1000, pending_batches: pending.length, concurrency, at: new Date().toISOString() });
    await Promise.all(Array.from({ length: concurrency }, async () => { while (next < pending.length && started < limit) { const batch = pending[next++]; started++; if (Date.now() < cooldown) await Bun.sleep(cooldown - Date.now()); await one(batch); await Bun.sleep(1100); } }));
  }
}
console.log(JSON.stringify({ event: "finished", completed: done.size, planned: all.length, failed: failures, blocked: blocked.size }));
