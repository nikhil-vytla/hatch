import { readFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, GatewayError } from "../../experience-prototypes/scripts/local-model";
import { hash, payload, tasks, shuffled, PROTOCOL, type Pair, type Task } from "./protocol";
const here = dirname(fileURLToPath(import.meta.url)), file = resolve(here, "events.jsonl"), lock = resolve(here, ".recording.lock");
const handle = openSync(lock, "wx");
const cleanup = () => { try { closeSync(handle); unlinkSync(lock); } catch {} }; process.on("exit", cleanup); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const raw = readFileSync(resolve(here, "cases.jsonl"), "utf8"), manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8"));
if (hash(raw) !== manifest.cases_sha256 || hash(JSON.stringify(PROTOCOL)) !== manifest.protocol_sha256) throw new Error("Source/protocol drift");
const pairs: Pair[] = raw.trim().split("\n").map(line => JSON.parse(line)), byPair = new Map(pairs.map(p => [p.pair_id, p])), all = tasks(pairs), done = new Map<string, any>(), blocked = new Set<string>();
const prior = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
for (const e of prior) { if (e.status === "completed") { if (done.has(e.id)) throw new Error(`Duplicate completion ${e.id}`); done.set(e.id, e); } if (e.status === "failed" && !e.transient) blocked.add(e.id); }
for (const t of all) { const e = done.get(t.id); if (e && e.request_sha256 !== hash(JSON.stringify(payload(byPair.get(t.pair_id)!, t)))) throw new Error(`Request drift ${t.id}`); }
const write = (data: any) => appendFileSync(file, JSON.stringify(data) + "\n");
const concurrency = Number(process.env.JUDGE_CONCURRENCY ?? 4), limit = Number(process.env.JUDGE_LIMIT ?? Infinity); let completed = 0, started = 0, failures = 0, cooldown = 0;
async function one(task: Task) {
  const body = payload(byPair.get(task.pair_id)!, task), request_sha256 = hash(JSON.stringify(body)), at = new Date().toISOString();
  const base = { ...task, request_sha256, protocol_sha256: manifest.protocol_sha256, started_at: at };
  try {
    const out = await evaluate(body, { deadlineMs: 115000, onAttempt: attempt => { write({ ...base, event: "attempt", at: new Date().toISOString(), ...attempt }); if (attempt.status === 429 || attempt.status === 503) cooldown = Date.now() + 5000; } });
    const record = { ...base, status: "completed", finished_at: new Date().toISOString(), ...out }; write(record); done.set(task.id, record); completed++;
  } catch (error) {
    const e = error as GatewayError; const transient = [408, 429, 500, 502, 503, 504].includes(e.status) && !/invalid (JSON|answer|confidence|probabilities)/i.test(e.message);
    write({ ...base, status: "failed", finished_at: new Date().toISOString(), transient, error: e.message, http_status: e.status ?? null, attempts: e.attempts ?? [] }); failures++; if (!transient) blocked.add(task.id); else cooldown = Date.now() + 10000;
    if ([401, 403].includes(e.status)) throw e;
  }
  if ((completed + failures) % 40 === 0) console.log(JSON.stringify({ completed: done.size, planned: all.length, newly_completed: completed, failures, blocked: blocked.size, at: new Date().toISOString() }));
}
console.log(JSON.stringify({ event: "resume", completed: done.size, planned: all.length, concurrency, protocol_sha256: manifest.protocol_sha256 }));
for (const repeat of [0, 1, 2]) {
  for (let sweep = 0; sweep < 5; sweep++) {
    const pending = shuffled(all.filter(t => t.repeat === repeat && !done.has(t.id) && !blocked.has(t.id)), 42 + repeat + sweep * 1000); let next = 0;
    if (!pending.length || started >= limit) break;
    write({ event: "schedule", repeat, sweep, seed: 42 + repeat + sweep * 1000, pending: pending.length, concurrency, at: new Date().toISOString() });
    await Promise.all(Array.from({ length: concurrency }, async () => { while (next < pending.length && started < limit) { const task = pending[next++]; started++; if (Date.now() < cooldown) await Bun.sleep(cooldown - Date.now()); await one(task); await Bun.sleep(30); } }));
  }
}
console.log(JSON.stringify({ event: "finished", completed: done.size, planned: all.length, failed: failures, blocked: blocked.size }));
