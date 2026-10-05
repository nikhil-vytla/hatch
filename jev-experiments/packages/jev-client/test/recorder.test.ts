/**
 * The shared recorder and the recordings reader, against the local mock /v1/systemone and an
 * in-process endpoint. Nothing leaves the machine and nothing is billed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EndpointError, systemoneEndpoint, type Endpoint, type Reply } from "../src/endpoints";
import { serveMock } from "../src/mock";
import { latestById, readRows, receipt, recordFile } from "../src/recordings";
import { noRetry, record, recorderKey, requireKey, retryBusy, waitOutBusy, type Job } from "../src/recorder";

const dir = mkdtempSync(join(tmpdir(), "jev-recorder-"));
const ok = serveMock();
const down = serveMock({ failWith: 503 });

afterAll(() => {
  ok.stop(true);
  down.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const quiet = () => {};
const noWait = async () => {};
let n = 0;
const fresh = () => join(dir, `run-${++n}.jsonl`);
const jobs = (count: number): Job[] =>
  Array.from({ length: count }, (_, i) => ({ id: `job-${i}`, request: { state: { i }, questions: { q: { type: "noul", instructions: `Is ${i} even?` } } } }));

/** An in-process endpoint: answers unless `fail(id, call)` returns an error to throw. */
function fake(fail: (id: string, call: number) => Error | null = () => null, usdPerMTok = 0): Endpoint & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    label: "fake",
    usdPerMTok,
    async ask(request) {
      const id = `job-${(request.state as { i: number }).i}`;
      const e = fail(id, calls.push(id));

      if (e) throw e;

      return { answers: { q: { type: "noul", value: 0.5, probabilities: { false: 0.5, true: 0.5 } } }, latencyMs: 1, inputTokens: 1000, costUsd: null, servedBy: "fake", model: "fake" } satisfies Reply;
    },
  };
}

describe("record", () => {
  const ep = systemoneEndpoint(`http://localhost:${ok.port}`);

  test("records every job in the default row shape, then resumes past them", async () => {
    const out = fresh();
    const first = await record(jobs(6), ep, { out, log: quiet });
    const rows = readRows(out);

    expect(first).toMatchObject({ sent: 6, ok: 6, errors: 0, skipped: 0, stopped: null });
    expect(Object.keys(rows[0]!)).toEqual(["id", "at", "status", "latencyMs", "inputTokens", "costUsd", "servedBy", "model", "endpoint", "answers"]);
    expect(rows[0]!.answers!.q).toMatchObject({ type: "noul", probabilities: expect.any(Object) });

    const again = await record(jobs(8), ep, { out, log: quiet });

    expect(again).toMatchObject({ sent: 2, ok: 2, skipped: 6 });
    expect(readRows(out).map((r) => r.id)).toEqual(jobs(8).map((j) => j.id));
    expect([...again.answered.keys()]).toHaveLength(8);
  });

  test("limit and resume: false", async () => {
    const out = fresh();

    expect((await record(jobs(5), ep, { out, limit: 2, log: quiet })).ok).toBe(2);
    expect((await record(jobs(5), ep, { out, resume: false, limit: 1, log: quiet })).skipped).toBe(4);
    expect(readRows(out).map((r) => r.id)).toEqual(["job-0", "job-1", "job-0"]);
  });

  test("a cap with an estimate stops before a request could pass it", async () => {
    // 1,000 tokens at $10 per million: $0.01 a request.
    const out = fresh();
    const r = await record(jobs(10), fake(undefined, 10), { out, maxUsd: 0.035, worstUsd: () => 0.01, log: quiet });

    expect(r.ok).toBe(3);
    expect(r.spentUsd).toBeCloseTo(0.03, 10);
    expect(r.stopped).toContain("next request could cost");
  });

  test("a cap without one stops once spend reaches it, counting spend from before the run", async () => {
    const r = await record(jobs(10), fake(undefined, 10), { out: fresh(), maxUsd: 0.035, spentUsd: 0.02, log: quiet });

    expect(r.ok).toBe(2);
    expect(r.stopped).toContain("cap $0.035");
  });

  test("a dead server stops the run after five failures in a row, all logged", async () => {
    const out = fresh();
    const r = await record(jobs(10), systemoneEndpoint(`http://localhost:${down.port}`), { out, retry: noRetry, log: quiet });
    const rows = readRows(out);

    expect(r.stopped).toContain("5 failures in a row");
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => x.status === "error" && x.code === 503)).toBe(true);
  });

  test("an answer resets the streak; failures that don't count leave it alone", async () => {
    const flaky = fake((id) => (["job-0", "job-1", "job-3", "job-4"].includes(id) ? new EndpointError("no", id === "job-3" ? 400 : 500) : null));
    const r = await record(jobs(8), flaky, { out: fresh(), retry: noRetry, failFast: 2, failCounts: (e) => (e as EndpointError).status !== 400, log: quiet });

    // job-0, job-1 fail: streak 2, stop.
    expect(r.stopped).toContain("2 failures in a row");
    expect(flaky.calls).toEqual(["job-0", "job-1"]);

    const later = fake((id) => (["job-1", "job-3", "job-4"].includes(id) ? new EndpointError("no", id === "job-3" ? 400 : 500) : null));
    const r2 = await record(jobs(8), later, { out: fresh(), retry: noRetry, failFast: 2, failCounts: (e) => (e as EndpointError).status !== 400, log: quiet });

    // job-1 fails (1), job-2 answers (0), job-3 is a 400 (still 0), job-4 fails (1): no stop.
    expect(r2.stopped).toBeNull();
    expect(r2).toMatchObject({ ok: 5, errors: 3 });
  });

  test("busy replies are asked again after a wait, every attempt logged", async () => {
    const busy = serveMock({ failWith: 503, failTimes: 2 });
    const waits: number[] = [];
    const out = fresh();
    const r = await record(jobs(2), systemoneEndpoint(`http://localhost:${busy.port}`), { out, retry: retryBusy(3), wait: async (ms) => void waits.push(ms), log: quiet });

    busy.stop(true);
    expect(waits).toEqual([2000, 4000]);
    expect(readRows(out).map((x) => `${x.id}:${x.status}`)).toEqual(["job-0:error", "job-0:error", "job-0:ok", "job-1:ok"]);
    expect(r).toMatchObject({ sent: 4, ok: 2, errors: 2 });
  });

  test("waitOutBusy backs off on 429, 503 and network failures, and stops the run on anything else", async () => {
    const out = fresh();
    const waits: number[] = [];
    const ep = fake((id, call) => (call <= 3 ? new EndpointError("busy", [429, 503, 0][call - 1]!) : id === "job-1" ? new EndpointError("bad request", 400) : null));
    const run = record(jobs(3), ep, { out, retry: waitOutBusy, failFast: Infinity, wait: async (ms) => void waits.push(ms), log: quiet });

    expect(run).rejects.toThrow("bad request");
    await run.catch(() => {});
    expect(waits).toEqual([2000, 4000, 8000]);
    expect(readRows(out).map((x) => `${x.id}:${x.status}:${x.code}`)).toEqual(["job-0:error:429", "job-0:error:503", "job-0:error:0", "job-0:ok:undefined", "job-1:error:400"]);
  });

  test("a failure that settles is recorded once and counts as answered", async () => {
    const out = fresh();
    const ep = fake((id) => (id === "job-1" ? new EndpointError("rejected score", 502) : null));
    const opts = {
      out,
      settles: (e: unknown) => e instanceof EndpointError && e.status === 502,
      done: (r: { status?: unknown }) => r.status === "ok" || r.status === "rejected",
      errorRow: (j: Job, e: unknown, a: { at: string }) => ({ id: j.id, at: a.at, status: (e as EndpointError).status === 502 ? "rejected" : "error" }),
      log: quiet,
    };
    const r = await record(jobs(3), ep, opts);

    expect(r).toMatchObject({ ok: 2, errors: 0, stopped: null });
    expect(ep.calls).toEqual(["job-0", "job-1", "job-2"]);
    expect((await record(jobs(3), ep, opts)).skipped).toBe(3);
  });

  test("a dry run lists the jobs and sends and writes nothing", async () => {
    const lines: string[] = [];
    const out = fresh();
    const ep = fake(undefined, 0.042);
    const r = await record(jobs(4), ep, { out, dryRun: true, log: (l) => lines.push(l) });

    expect(r.sent).toBe(0);
    expect(ep.calls).toEqual([]);
    expect(existsSync(out)).toBe(false);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain("Nothing was sent");
  });

  test("concurrency keeps at most that many requests in flight", async () => {
    let flying = 0;
    let most = 0;
    const slow: Endpoint = {
      label: "slow",
      usdPerMTok: 0,
      async ask() {
        most = Math.max(most, ++flying);
        await new Promise((r) => setTimeout(r, 5));
        flying--;

        return { answers: {}, latencyMs: 5, inputTokens: null, costUsd: null, servedBy: null, model: null };
      },
    };
    const r = await record(jobs(9), slow, { out: fresh(), concurrency: 3, log: quiet });

    expect(r.ok).toBe(9);
    expect(most).toBe(3);
  });

  test("custom rows, a pause between jobs and progress hooks", async () => {
    const out = fresh();
    const waits: number[] = [];
    const started: number[] = [];
    const r = await record(jobs(2), fake(), {
      out,
      gapMs: 700,
      wait: async (ms) => void waits.push(ms),
      okRow: (j, reply, a) => ({ key: j.id, at: a.at, attempt: a.attempt, status: "ok", model: reply.model }),
      idOf: (row) => row.key as string,
      onStart: (todo, skipped) => started.push(todo, skipped),
      log: quiet,
    });

    expect(r.ok).toBe(2);
    expect(waits).toEqual([700, 700]);
    expect(started).toEqual([2, 0]);
    expect(Object.keys(readRows(out)[0]!)).toEqual(["key", "at", "attempt", "status", "model"]);
    expect((await record(jobs(2), fake(), { out, idOf: (row) => row.key as string, log: quiet })).skipped).toBe(2);
  });
});

describe("reading recordings", () => {
  test("a gzipped recording is unpacked to its working copy, which then wins over the .gz", async () => {
    const out = join(dir, "packed.jsonl");
    const old = [
      { id: "job-0", at: "2026-09-01T00:00:00.000Z", status: "error", code: 503 },
      { id: "job-0", at: "2026-09-01T00:00:01.000Z", status: "ok", latencyMs: 9, inputTokens: 10, costUsd: 0.5 },
      { id: "job-1", at: "2026-09-01T00:00:02.000Z", status: "ok", latencyMs: 3, inputTokens: 20, costUsd: 0.25 },
    ];

    writeFileSync(`${out}.gz`, gzipSync(old.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    expect(recordFile(out)).toBe(`${out}.gz`);
    expect(readRows(out)).toEqual(old as never);

    const r = await record(jobs(3), fake(), { out, log: quiet });

    expect(r).toMatchObject({ ok: 1, skipped: 2 });
    expect(recordFile(out)).toBe(out);
    expect(readRows(out).map((x) => x.id)).toEqual(["job-0", "job-0", "job-1", "job-2"]);
    // The .gz is untouched until someone compresses the working copy.
    expect(readRows(`${out}.gz`)).toHaveLength(3);
  });

  test("latest answer per id, failures excluded; the receipt counts every attempt's cost", () => {
    const rows = readRows(join(dir, "packed.jsonl"));
    const latest = latestById(rows);

    expect([...latest.keys()]).toEqual(["job-0", "job-1", "job-2"]);
    expect(latest.get("job-0")!.at).toBe("2026-09-01T00:00:01.000Z");
    expect(receipt(rows)).toMatchObject({ attempts: 4, ok: 3, errors: 1, inputTokens: 1030 });
  });

  test("a missing recording reads as no rows; blank lines are skipped", () => {
    const path = join(dir, "blank.jsonl");

    expect(readRows(join(dir, "missing.jsonl"))).toEqual([]);
    writeFileSync(path, '{"id":"a","status":"ok"}\n\n  \n{"id":"b","status":"ok"}\n');
    expect(readRows(path).map((r) => r.id)).toEqual(["a", "b"]);
    expect(readFileSync(path, "utf8")).toContain("\n\n");
  });
});

describe("the key", () => {
  test("recorders need AI_GATEWAY_API_KEY, except for a dry run", () => {
    expect(() => requireKey({})).toThrow("Set AI_GATEWAY_API_KEY to record.");
    expect(requireKey({ AI_GATEWAY_API_KEY: "k" })).toBe("k");
    expect(recorderKey(["bun", "record.ts", "--dry-run"])).toEqual({ dryRun: true, apiKey: "" });
  });
});
