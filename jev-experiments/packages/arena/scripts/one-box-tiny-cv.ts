/**
 * An honest development estimate for the tiny model. The committed model trained on every
 * development prefix, so replaying it on development phrases is in-sample. Here each
 * development phrase is replayed with a fold model that never saw any of its prefixes
 * (five folds over phrases, seeded; held-out phrases are never used).
 *
 *   bun packages/arena/scripts/one-box-tiny-data.ts
 *   uv run --no-project --with scikit-learn==1.9.1 --with numpy==2.5.3 \
 *     python packages/arena/scripts/train-one-box-tiny.py --cv
 *   bun packages/arena/scripts/one-box-tiny-cv.ts
 */
import { readFileSync } from "node:fs";
import { toReading } from "../src/one-box/adapter";
import { phrasesSchema } from "../src/one-box/phrases";
import { outcome, replay, type AnswerFor, type Policy } from "../src/one-box/replay";
import { tinyModel } from "../src/one-box/tiny";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const cache = new URL("../.cache/one-box-tiny/", import.meta.url);

const { phraseFold }: { phraseFold: Record<string, number> } = JSON.parse(
  readFileSync(new URL("folds.json", cache), "utf8"),
);

const models = [0, 1, 2, 3, 4].map((f) =>
  tinyModel(
    JSON.parse(readFileSync(new URL(`cv-${f}/vectorizer.json`, cache), "utf8")),
    JSON.parse(readFileSync(new URL(`cv-${f}/heads.json`, cache), "utf8")),
  ),
);

const dev = doc.phrases.filter((p) => p.split === "dev");

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

for (const policy of ["cancel", "latest"] satisfies Policy[]) {
  console.log(`\nTiny model, out of fold · ${policy} policy`);

  for (const kind of [undefined, "plain", "ambiguous", "adversarial"] as const) {
    const ps = kind ? dev.filter((p) => p.kind === kind) : dev;

    const rows = ps.map((p) => {
      const model = models[phraseFold[p.id]];

      const answerFor: AnswerFor = (key) => ({
        reading: toReading(model.answers(key)).reading,
        latencyMs: 1,
      });

      const full = toReading(model.answers(p.text.toLowerCase().replace(/\s+/g, " ").trim()))
        .reading.intent.value;

      return {
        o: outcome(replay(p.text, answerFor, policy), p),
        full: full === p.intent || (p.acceptable ?? []).some((a) => a === full),
      };
    });

    const times = rows.flatMap((r) => (r.o.timeToRight === undefined ? [] : [r.o.timeToRight]));

    console.log(
      `  ${(kind ?? "all").padEnd(11)} ${String(ps.length).padStart(3)} · full phrase right ${pct(mean(rows.map((r) => Number(r.full))))} · box right at end ${pct(mean(rows.map((r) => Number(r.o.finalRight))))} · wrong commits ${mean(rows.map((r) => r.o.wrongCommits)).toFixed(2)} · changes ${mean(rows.map((r) => r.o.changes)).toFixed(2)} · right for good ${Math.round(median(times))} ms median (${times.length} reach it)`,
    );
  }
}
