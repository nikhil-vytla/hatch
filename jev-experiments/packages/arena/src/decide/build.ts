/**
 * Builds public/decide/decide.json: the deck, the exact request per setup, and each recorded
 * contestant's raw answers and combined distribution per setup. A contestant with no recording
 * yet is left out, never invented.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { combine, wireAnswerSchema, type Dist, type WireAnswer } from "./combine";
import { describe } from "./combine";
import { DECK, requestFor } from "./deck";

export const CONTESTANTS = [
  {
    id: "jev",
    name: "Jev",
    about:
      "TypeSafe's decision model, as typesafe-ai/jev through the Vercel AI Gateway (which doesn't name the build)",
    file: "decide.jsonl",
  },
  {
    id: "laya",
    name: "Laya",
    about: "A local typed readout on convaiinnovations/laya, run with MLX on an M4 Max",
    file: "decide.laya.jsonl",
  },
  {
    id: "nli",
    name: "MobileBERT",
    about: "A 27 MB zero-shot classifier (MobileBERT-MNLI); it can run in your browser",
    file: "decide.nli.jsonl",
  },
] as const;

const rowSchema = z.object({
  id: z.string(),
  status: z.string(),
  latencyMs: z.number().nullable().optional(),
  model: z.string().optional(),
  at: z.string().optional(),
  costUsd: z.number().nullable().optional(),
  answers: z.record(z.string(), wireAnswerSchema).optional(),
});

export type Result = {
  dist: Dist;
  answers: Record<string, WireAnswer>;
  latencyMs: number | null;
  /** When this answer was recorded, and what it cost if the recorder logged it. */
  at: string | null;
  costUsd: number | null;
};

function readRows(path: string) {
  if (!existsSync(path)) return new Map<string, z.infer<typeof rowSchema>>();

  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => rowSchema.parse(JSON.parse(l)))
    .filter((r) => r.status === "ok" && r.answers);

  return new Map(rows.map((r) => [r.id, r]));
}

export function buildDecide(root: string, outDir: string) {
  const recorded = CONTESTANTS.map((c) => ({
    ...c,
    rows: readRows(join(root, "recordings", c.file)),
  }));

  const present = recorded.filter((c) => c.rows.size > 0);

  const decisions = DECK.map((d) => ({
    ...d,
    setups: d.setups.map((s) => ({
      ...s,
      request: requestFor(d, s),
      rule: describe(s.combine, d.options),
      results: Object.fromEntries(
        present.flatMap((c) => {
          const row = c.rows.get(`${d.id}:${s.id}`);

          if (!row?.answers) return [];

          const result: Result = {
            dist: combine(s.combine, d.options, row.answers),
            answers: row.answers,
            latencyMs: row.latencyMs ?? null,
            at: row.at ?? null,
            costUsd: row.costUsd ?? null,
          };

          return [[c.id, result]];
        }),
      ),
    })),
  }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "decide.json"),
    JSON.stringify({
      schema: "jev.decide/1",
      contestants: present.map(({ id, name, about, rows }) => {
        const days = [...rows.values()].flatMap((r) => (r.at ? [r.at.slice(0, 10)] : [])).sort();

        const recorded = !days.length
          ? ""
          : days[0] === days.at(-1)
            ? days[0]
            : `${days[0]} to ${days.at(-1)}`;

        return { id, name, about, model: [...rows.values()][0]?.model ?? "", recorded };
      }),
      decisions,
    }),
  );

  console.log(
    `Decide: ${decisions.length} decisions, contestants ${present.map((c) => c.id).join(", ")}.`,
  );
}
