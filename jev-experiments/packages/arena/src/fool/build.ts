/**
 * Builds public/fool/fool.json: the puzzles, and Jev's recorded answer and referee verdict for
 * every recorded sentence, so the toy works without a key. A sentence with no answered row is
 * left out, never invented.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHEATS, cleanSentence, MENU, PUZZLES, sentencesFor } from "./model";

type Row = {
  id: string;
  status: string;
  at?: string;
  latencyMs?: number | null;
  servedBy?: string | null;
  costUsd?: number | null;
  answers?: Record<string, { value?: unknown }>;
};

export type Recorded = {
  pYes: number;
  pChanges: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  at: string | null;
  servedBy: string | null;
  /** The answers exactly as recorded, for the receipt's raw view. */
  answers: Row["answers"] | null;
  refereeAnswers: Row["answers"] | null;
};

function readRows(path: string) {
  const rows = new Map<string, Row>();

  if (!existsSync(path)) return rows;

  // A request is logged once per run; the last answered row stands.
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;

    const row: Row = JSON.parse(line);

    if (row.status === "ok") rows.set(row.id, row);
  }

  return rows;
}

const value = (row: Row | undefined, key: string) => {
  const v = row?.answers?.[key]?.value;

  return Number.isFinite(v) ? Number(v) : null;
};

export function buildFool(root: string, outDir: string) {
  const rows = readRows(join(root, "recordings/fool.jsonl"));

  const recorded = Object.fromEntries(
    PUZZLES.map((p) => {
      const answers = sentencesFor(p.id).flatMap((s): [string, Recorded][] => {
        const answer = rows.get(`answer:${p.id}:${s}`);
        const referee = rows.get(`referee:${p.id}:${s}`);
        const pYes = value(answer, "q");

        if (pYes === null || !answer) return [];

        const costs = [answer.costUsd, referee?.costUsd].filter((c): c is number =>
          Number.isFinite(c),
        );

        return [
          [
            cleanSentence(s),
            {
              pYes,
              pChanges: s ? value(referee, "changes") : null,
              latencyMs: answer.latencyMs ?? null,
              costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
              at: answer.at ?? null,
              servedBy: answer.servedBy ?? null,
              answers: answer.answers ?? null,
              refereeAnswers: s ? (referee?.answers ?? null) : null,
            },
          ],
        ];
      });

      return [p.id, Object.fromEntries(answers)];
    }),
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "fool.json"),
    JSON.stringify({ puzzles: PUZZLES, menu: MENU, cheats: CHEATS, recorded }) + "\n",
  );

  return Object.values(recorded).reduce((n, r) => n + Object.keys(r).length, 0);
}
