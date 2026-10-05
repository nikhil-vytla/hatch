/**
 * The live worlds' recorders run on the shared recorder (packages/jev-client/src/recorder.ts).
 * These pin what they send and write, without sending anything: job ids and request bodies equal
 * what the recorders built before the move (digests from that code), every answered row in the
 * committed recordings is one of those jobs, and a row rebuilt from a recorded answer is byte for
 * byte the recorded row.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JevResult, Reply } from "../packages/jev-client/src/endpoints";
import { readRows, type RecordedRow } from "../packages/jev-client/src/recordings";
import { jevRow } from "../packages/jev-client/src/recorder";
import { jobs as countJobs, out as countOut } from "./count/record-jev";
import { jobs as vlmJobs } from "./count/record-vlm";
import { jobs as rumourJobs, okRow as rumourRow, out as rumourOut } from "./rumour/record";
import { jobs as sentryJobs, okRow as sentryRow, out as sentryOut } from "./sentry/record";
import { jobs as whoJobs, okRow as whoRow, out as whoOut } from "./who-said-that/record-jev";

const digest = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

/** count, first id and sha256 of the ordered [id, request, ...] list, from the pre-move recorders. */
const BEFORE = {
  count: [98, "umbrella-215072", "2c0067273ddfd3b716c926b5ea152b47b2cac65056a9e15fbe94ac83d8e0460b"],
  "count-vlm": [588, "umbrella-215072:count", "e27a5f26071c1f184c7801e3ad6d95a33d8a4abdbb1beabbb0c37d58fad8ad67"],
  sentry: [21, "scene:flights:0", "50e4eaf3b336acb3f535d66b8d5f98d6f7adb41e8d7112dbb13138e2446235b6"],
  "who-said-that": [110, "design-meeting:0", "3c5dc3ef6d82fd495d266ab340b84adaaa09a01a3d23a25224c3cbc874b6bc1c"],
  rumour: [3, "rumour:0", "c97929f2917183853398d5bfda1333d257b3a9bff3eab75cdc893252ada3cc65"],
} as const;

const CASES: [keyof typeof BEFORE, () => unknown[][]][] = [
  ["count", () => countJobs().map((j) => [j.id, j.request])],
  ["count-vlm", () => vlmJobs().map((j) => [j.id, j.request])],
  ["sentry", () => sentryJobs().map((j) => [j.id, j.request, j.set, j.keys])],
  ["who-said-that", () => whoJobs().map((j) => [j.id, j.request])],
  ["rumour", () => rumourJobs().map((j) => [j.id, j.request, j.keys])],
];

describe("recorder jobs are the ones the recordings were made from", () => {
  for (const [name, list] of CASES)
    test(name, () => {
      const rows = list();
      const [count, first, sha] = BEFORE[name];

      expect([rows.length, rows[0]?.[0], digest(rows)]).toEqual([count, first, sha]);
    });

  test("every answered row in the committed recordings is a job", () => {
    const answered = (path: string | URL) => readRows(path).filter((r) => r.status === "ok");
    const cases: [string, RecordedRow[], Set<string>][] = [
      ["count", answered(countOut), new Set(countJobs().map((j) => j.id))],
      ["sentry", answered(sentryOut), new Set(sentryJobs().map((j) => j.id))],
      ["who-said-that", answered(whoOut), new Set(whoJobs().map((j) => j.id))],
      ["count-vlm", readRows(new URL("./count/recordings/qwen3-vl-4b.jsonl", import.meta.url)).map((r) => ({ ...r, id: `${r.id}:${r.question}` })), new Set(vlmJobs().map((j) => j.id))],
    ];

    for (const [name, rows, ids] of cases) {
      expect(rows.length, name).toBeGreaterThan(0);
      expect(
        rows.filter((r) => !ids.has(r.id)).map((r) => r.id),
        name,
      ).toEqual([]);
    }

    // Who said that? asks a line again only when its request changed: the latest answers match.
    const latest = new Map(answered(whoOut).map((r) => [r.id, r]));
    const stale = whoJobs().filter((j) => latest.has(j.id) && JSON.stringify(latest.get(j.id)!.request) !== JSON.stringify(j.request));

    expect(stale.map((j) => j.id)).toEqual([]);
  });
});

/** What `evaluate` returned for a recorded row, as far as the row kept it. */
const replyFor = (row: RecordedRow, answers: unknown = row.answers): Reply<JevResult> => ({
  answers: {},
  latencyMs: 0,
  inputTokens: row.inputTokens ?? null,
  costUsd: null,
  servedBy: row.servedBy ?? null,
  model: row.model ?? null,
  raw: {
    model: row.model,
    served_by: row.servedBy,
    generation_id: row.generationId,
    latency_ms: row.latencyMs,
    usage: row.inputTokens === undefined || row.inputTokens === null ? null : { input_tokens: row.inputTokens },
    answers,
  } as unknown as JevResult,
});

describe("new rows keep the recorded shape", () => {
  test("count", () => {
    const row = readRows(countOut).find((r) => r.status === "ok")!;

    expect(JSON.stringify(jevRow(row, replyFor(row), { at: row.at, attempt: 1 }))).toBe(JSON.stringify(row));
  });

  test("sentry, with the request", () => {
    const row = readRows(sentryOut).find((r) => r.status === "ok")!;
    const job = sentryJobs().find((j) => j.id === row.id)!;

    expect(JSON.stringify(sentryRow(job, replyFor(row), { at: row.at, attempt: 1 }))).toBe(JSON.stringify(row));
  });

  test("who said that, with the request", () => {
    const rows = readRows(whoOut).filter((r) => r.status === "ok");
    const jobs = new Map(whoJobs().map((j) => [j.id, j]));
    const row = rows.find((r) => JSON.stringify(r.request) === JSON.stringify(jobs.get(r.id)?.request))!;

    expect(JSON.stringify(whoRow(jobs.get(row.id)!, replyFor(row), { at: row.at, attempt: 1 }))).toBe(JSON.stringify(row));
  });

  test("rumour: no id or status, per-token cost rounding, answers by profile", () => {
    const row = readRows(rumourOut)[0]!;
    const job = rumourJobs()[0]!;
    const answers = Object.fromEntries(job.keys.map((key, j) => [`p${j}`, (row.answers as Record<string, unknown>)[key]]));

    expect(JSON.stringify(rumourRow(job, replyFor(row, answers), { at: row.at, attempt: 1 }))).toBe(JSON.stringify(row));
  });
});
