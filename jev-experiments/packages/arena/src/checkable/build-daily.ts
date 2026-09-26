/**
 * Builds public/daily/daily.json from the checkable bank and Jev's recording of it. Items Jev
 * has not answered are left out, so a partial recording publishes a smaller bank rather than
 * placeholders. Run by experience-prototypes/scripts/prepare.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { dailySchema, optionKeys, questionFor, truthKey, type DailyItem } from "./daily";
import { bankSchema } from "./items";

const rowSchema = z.object({
  id: z.string(),
  at: z.string(),
  status: z.string(),
  latencyMs: z.number().optional(),
  answers: z
    .record(
      z.string(),
      z.object({
        value: z.union([z.string(), z.number()]),
        probabilities: z.record(z.string(), z.number()).nullish(),
      }),
    )
    .optional(),
});

type Answer = NonNullable<z.infer<typeof rowSchema>["answers"]>[string];

/** Jev's answer as a distribution over the question's option keys. */
function distribution(keys: string[], a: Answer) {
  if (keys.length === 2 && keys[0] === "true") {
    const yes = Number(a.value);

    return Object.fromEntries([
      ["true", yes],
      ["false", 1 - yes],
    ]);
  }

  const p = a.probabilities ?? { [String(a.value)]: 1 };
  const total = keys.reduce((s, k) => s + (p[k] ?? 0), 0) || 1;

  return Object.fromEntries(keys.map((k) => [k, (p[k] ?? 0) / total]));
}

export function buildDaily(root: string, outDir: string) {
  const bank = bankSchema.parse(
    JSON.parse(readFileSync(join(root, "src/checkable/bank.json"), "utf8")),
  );

  const raw = join(root, "recordings/checkable.jsonl");
  const gz = `${raw}.gz`;

  const text = existsSync(raw)
    ? readFileSync(raw, "utf8")
    : existsSync(gz)
      ? gunzipSync(readFileSync(gz)).toString("utf8")
      : "";

  const rows = new Map<string, z.infer<typeof rowSchema>>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = rowSchema.parse(JSON.parse(line));

    if (row.status === "ok" && row.answers) rows.set(row.id, row);
  }

  const items: DailyItem[] = [];

  let sureN = 0,
    sureRight = 0,
    recordedAt = "";

  for (const item of bank.items) {
    const row = rows.get(item.id);

    if (!row?.answers) continue;
    recordedAt = row.at > recordedAt ? row.at : recordedAt;

    // Jev's record when sure, over every question of every item it answered.
    for (const [qid, q] of Object.entries(item.questions)) {
      const a = row.answers[qid];

      if (!a) continue;
      const d = distribution(optionKeys(q), a);
      const [top, p] = Object.entries(d).reduce((x, y) => (y[1] > x[1] ? y : x));

      if (p >= 0.9) {
        sureN++;

        if (top === truthKey(item.truth[qid])) sureRight++;
      }
    }

    const qid = questionFor(item);
    const answer = row.answers[qid];

    if (!answer) continue;

    items.push({
      id: item.id,
      kind: item.kind,
      difficulty: item.difficulty,
      state: item.state,
      questionId: qid,
      question: item.questions[qid],
      truth: item.truth[qid],
      jev: distribution(optionKeys(item.questions[qid]), answer),
      jevMs: row.latencyMs ?? 0,
    });
  }

  const daily = dailySchema.parse({
    schema: "jev.daily/1",
    recordedAt: recordedAt || new Date(0).toISOString(),
    sure: { n: sureN, right: sureRight },
    bank: {
      schema: bank.schema,
      generatedWith: bank.generatedWith,
      ids: items.map((i) => ({ id: i.id, kind: i.kind })),
    },
    items,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "daily.json"), JSON.stringify(daily));

  return { items: items.length, sure: daily.sure };
}
