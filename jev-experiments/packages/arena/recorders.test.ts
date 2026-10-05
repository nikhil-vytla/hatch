/**
 * The arena's recorders run on the shared recorder (packages/jev-client/src/recorder.ts). These
 * pin what they send and write, without sending anything:
 *
 * - job ids and request bodies, in order, equal what the recorders built before the move to the
 *   shared module (digests taken from that code), and every answered row in the committed
 *   recordings is one of those jobs;
 * - a row built from a recorded answer is byte for byte the recorded row, so new rows keep the
 *   shape on disk.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { JevResult, Reply } from "../jev-client/src/endpoints";
import { readRows, type RecordedRow } from "../jev-client/src/recordings";
import { attemptErrorRow, attemptRow, jevErrorRow, jevRow } from "../jev-client/src/recorder";
import { GatewayError } from "../jev-client/src/gateway";
import { foolJobs, intentJobs, oneBoxJobs as openOneBoxJobs, typedJobs } from "./open-decisions/record";
import { jobs as proseJobs, okRow as proseRow } from "./prose/record";
import { jobs as checkableJobs } from "./scripts/record-checkable";
import { jobs as decideJobs } from "./scripts/record-decide";
import { jobs as oneBoxJobs } from "./scripts/record-one-box";
import { jobs as spineJobs } from "./spine/record";
import { jobs as foolRecorderJobs, pilot as foolPilot } from "./src/fool/record";

const digest = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const recordings = new URL("./recordings/", import.meta.url).pathname;
const app = new URL("../../experience-prototypes/", import.meta.url).pathname;

/** count, first id and sha256 of the ordered [id, request, ...] list, from the pre-move recorders. */
const BEFORE = {
  spine: [1300, "parcel:plain", "75278395cc72f71aec36dabee6ee6d5eebbff010290ee3a0b3de6bb6b2f9bdaf"],
  fool: [175, "answer:weather:", "ac157ea60694e781b2be9d2f1bc64f2bd5ad4a74872a482a3a3dbd324d5ad69f"],
  prose: [2626, "claim-truth:guide-dog:context:long-background", "052f1ab62d454242bbe9c9fe1ac4116f9425895182803f11d7dc1bd4575e4eda"],
  checkable: [300, "tetris-110", "c3a01f5cea6f678bc2945c3a5eb60ab6910ec3baf1981cfa3c058942d46108c8"],
  judgement: [150, "route-41", "4964c48a5692db499d500f773febcf7651a82b1c2c843d5dddbc6dac0fb522ba"],
  decide: [121, "route-policy:each", "d50aafbfba6694fdf40428beed2b1b32509e7bfcceb1d89369e882fa7074ce2e"],
  "one-box:all": [5666, "grab a birthday", "5afd24d856a1a3c4aaea91645e525856f8fcbef233c7cc8bf69a2f51b42104e9"],
  "one-box:words": [1290, "split 210 between me,", "02fc1dfe766b0121dd00f2fce0bac325cffc30b8ad05d4d3362a1af32a670696"],
  "open-decisions:fool": [175, "answer:weather:", "54c56e0a5ee099367ddd67313a4916544ffe5d5d6baacb669bf0f06eb64f8e08"],
  "open-decisions:typed": [400, "agent_trace_observability_000000", "9a53e60e718f72598147c3667751cf6e0abf031a92814c7ff42137e3f0a40137"],
  "open-decisions:intent": [785, "clinc150/oos_test/664", "d2f111b23b403cf3fe3b55d5a973cfc34fe9919f2bd6f40046b791e8aa9325a9"],
  "open-decisions:one-box": [5666, "bu", "2a15524b5798ce52c3a672c53dfa0470c67ff60dfc2637f3df65e32cec2c46c6"],
} as const;

type Listed = { id: string; request: unknown };
const plainList = (jobs: Listed[]) => jobs.map((j) => [j.id, j.request]);
const openList = (jobs: (Listed & { extra?: unknown })[]) => jobs.map((j) => [j.id, j.request, j.extra ?? null]);

// The open-decisions typed and intent jobs read site data that `bun run build` generates.
const built = (file: string) => existsSync(`${app}public/data/${file}`);

const CASES: [keyof typeof BEFORE, () => unknown[][], boolean?][] = [
  ["spine", () => plainList(spineJobs())],
  ["fool", () => plainList(foolRecorderJobs())],
  ["prose", () => plainList(proseJobs())],
  ["checkable", () => plainList(checkableJobs("bank.json"))],
  ["judgement", () => plainList(checkableJobs("judgement-bank.json"))],
  ["decide", () => plainList(decideJobs())],
  ["one-box:all", () => oneBoxJobs("all").map((j) => [j.id, j.request, j.phrases])],
  ["one-box:words", () => oneBoxJobs("words").map((j) => [j.id, j.request, j.phrases])],
  ["open-decisions:fool", () => openList(foolJobs())],
  ["open-decisions:typed", () => openList(typedJobs()), !built("local-models.json")],
  ["open-decisions:intent", () => openList(intentJobs()), !built("classify.json")],
  ["open-decisions:one-box", () => openList(openOneBoxJobs())],
];

describe("recorder jobs are the ones the recordings were made from", () => {
  for (const [name, list, skip] of CASES)
    test.skipIf(Boolean(skip))(name, () => {
      const rows = list();
      const [count, first, sha] = BEFORE[name];

      expect([rows.length, rows[0]?.[0], digest(rows)]).toEqual([count, first, sha]);
    });

  const answered = (file: string, idOf = (r: RecordedRow) => r.id) =>
    readRows(`${recordings}${file}`)
      .filter((r) => r.status === "ok")
      .map(idOf);
  const ids = (jobs: { id: string }[]) => new Set(jobs.map((j) => j.id));

  test("every answered row in the committed recordings is a job", () => {
    const cases: [string, Set<string>, ((r: RecordedRow) => string)?][] = [
      ["fool.jsonl", ids(foolRecorderJobs())],
      ["../spine/recordings/spine.jsonl", ids(spineJobs())],
      ["../prose/recordings/prose.jsonl", ids(proseJobs())],
      ["checkable.jsonl", ids(checkableJobs("bank.json"))],
      ["judgement.jsonl", ids(checkableJobs("judgement-bank.json"))],
      ["decide.jsonl", ids(decideJobs())],
      ["one-box.jsonl", ids(oneBoxJobs("all")), (r) => r.key as string],
      ["open-decisions.fool.qwen3-4b.jsonl", ids(foolJobs())],
      ["one-box.qwen3-0.6b.jsonl", ids(openOneBoxJobs()), (r) => r.key as string],
    ];

    for (const [file, jobs, idOf] of cases) {
      const rows = answered(file, idOf);

      expect(rows.length, file).toBeGreaterThan(0);
      expect(
        rows.filter((id) => !jobs.has(id)),
        file,
      ).toEqual([]);
    }
  });

  test("the fool pilot is the seven requests it always was", () => {
    expect(foolPilot(foolRecorderJobs()).map((j) => j.id)).toHaveLength(7);
  });
});

/** What `evaluate` returned for a recorded row, as far as the row kept it. */
const replyFor = (row: RecordedRow): Reply<JevResult> => ({
  answers: row.answers ?? {},
  latencyMs: 0,
  inputTokens: row.inputTokens ?? null,
  costUsd: row.costUsd ?? null,
  servedBy: row.servedBy ?? null,
  model: row.model ?? null,
  raw: {
    model: row.model,
    served_by: row.servedBy,
    generation_id: row.generationId,
    latency_ms: row.latencyMs,
    service_latency_ms: row.latencyMs,
    usage: row.inputTokens === undefined ? null : { input_tokens: row.inputTokens },
    cost_usd: row.costUsd,
    answers: row.answers,
    rejected: row.rejected,
  } as unknown as JevResult,
});

const first = (file: string, status: string, has?: string) =>
  readRows(`${recordings}${file}`).find((r) => r.status === status && (!has || r[has] !== undefined))!;

describe("new rows keep the recorded shape", () => {
  test("spine, fool and count style rows (jevRow) with list-price cost", () => {
    for (const file of ["fool.jsonl", "../spine/recordings/spine.jsonl"]) {
      const row = first(file, "ok", "generationId");

      expect(JSON.stringify(jevRow(row, replyFor(row), { at: row.at, attempt: 1 })), file).toBe(JSON.stringify(row));
    }
  });

  test("prose rows, with the request hash", () => {
    const row = first("../prose/recordings/prose.jsonl", "ok", "generationId");
    const job = proseJobs().find((j) => j.id === row.id)!;

    expect(JSON.stringify(proseRow(job, replyFor(row), { at: row.at, attempt: row.attempt as number }))).toBe(JSON.stringify(row));
  });

  test("their failures", () => {
    const row = { id: "answer:weather:", at: "2026-10-04T00:00:00.000Z", status: "error", error: "Jev is busy. Your input is preserved; retry shortly." };

    expect(JSON.stringify(jevErrorRow(row, new GatewayError(row.error, 503), { at: row.at, attempt: 1 }))).toBe(JSON.stringify(row));
  });

  test("checkable, decide and one-box rows (every attempt logged)", () => {
    for (const file of ["checkable.jsonl", "decide.jsonl"]) {
      const row = first(file, "ok");

      expect(JSON.stringify(attemptRow(row, replyFor(row), { at: row.at, attempt: row.attempt as number })), file).toBe(JSON.stringify(row));
    }

    const box = first("one-box.jsonl", "ok");

    expect(JSON.stringify(attemptRow({ id: box.key as string }, replyFor(box), { at: box.at, attempt: box.attempt as number }, { key: box.key, phrases: box.phrases }))).toBe(JSON.stringify(box));

    const failed = first("checkable.jsonl", "error");

    expect(JSON.stringify(attemptErrorRow(failed, new GatewayError(failed.message!, failed.code!), { at: failed.at, attempt: failed.attempt as number }))).toBe(JSON.stringify(failed));
  });
});
