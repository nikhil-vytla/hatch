/**
 * Builds public/open-decisions/open-decisions.json for the Open decisions page: each open model's
 * results on the benchmarks Jev was recorded on, next to Jev's recorded results on the same rows.
 * Only answered rows count; a model appears on a benchmark only if it answered every row.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MENU, PUZZLES, sentencesFor, verdict } from "../src/fool/model";
import { PALETTE } from "../src/data/palette";
import { score } from "../src/score";
import { METHOD, OPEN_MODELS } from "./models";

type Row = Record<string, any>;

function rows(given: string): Row[] {
  // The local full-precision log while recording, else the committed rounded .gz copy.
  const path = existsSync(given) ? given : `${given}.gz`;

  if (!existsSync(path)) return [];

  const text = path.endsWith(".gz") ? gunzipSync(readFileSync(path)).toString("utf8") : readFileSync(path, "utf8");

  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** The last answered row per key; error rows never count. */
function answered(path: string, field = "id") {
  const out = new Map<string, Row>();

  for (const r of rows(path)) if ((r.status ?? "ok") === "ok") out.set(r[field], r);

  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null;
};

export function buildOpenDecisions(root: string, app: string, outDir: string) {
  const rec = (f: string) => join(root, "recordings", f);
  const study = JSON.parse(readFileSync(join(app, "public/data/local-models.json"), "utf8")).result;
  const classify = JSON.parse(readFileSync(join(app, "public/data/classify.json"), "utf8")).result.experiments;

  // ---- Typed decisions: agreement with the teacher reference, as the arena card scores it.
  const typedScore = (pred: (c: Row, q: Row) => number[] | null) => {
    const answers: { prediction: number[]; reference: number[] }[] = [];

    for (const c of study.cases)
      for (const q of c.questions) {
        const p = pred(c, q);

        if (!p) return null;

        answers.push({ prediction: p, reference: q.target });
      }

    const s = score(answers);

    return { agreement: s.agreement, ece: s.ece, brier: s.brier, decisions: s.decisions };
  };

  const typed = [
    { id: "jev", name: "Jev", ...typedScore((_, q) => q.predictions.jev) },
    {
      id: "study.Qwen3-4B-Instruct-2507-4bit",
      name: "Qwen3-4B-Instruct-2507, the local study's own scoring",
      ...typedScore((_, q) => q.predictions["Qwen3-4B-Instruct-2507-4bit"]),
    },
    ...OPEN_MODELS.flatMap((m) => {
      const got = answered(rec(`open-decisions.typed.${m.id}.jsonl`));
      const s = typedScore((c, q) => {
        const p = got.get(c.id)?.answers?.[q.key]?.probabilities;

        return p ? q.keys.map((k: string) => p[k] ?? 0) : null;
      });

      return s ? [{ id: m.id, name: m.name, ...s }] : [];
    }),
  ];

  // ---- Intent recognition: share of utterances whose top intent is the dataset's label.
  const intent = ["banking77", "clinc150"].map((name) => {
    const jevRows = classify[name].rows as Row[];
    const results = [
      { id: "jev", name: "Jev", accuracy: jevRows.filter((r) => r.prediction === r.target).length / jevRows.length, n: jevRows.length },
      ...OPEN_MODELS.flatMap((m) => {
        const got = answered(rec(`open-decisions.intent.${m.id}.jsonl`));

        if (jevRows.some((r) => !got.has(r.id))) return [];

        const right = jevRows.filter((r) => got.get(r.id)?.answers?.intent?.value === r.target).length;

        return [{ id: m.id, name: m.name, accuracy: right / jevRows.length, n: jevRows.length }];
      }),
    ];
    const tfidf = classify[name].tfidf_logistic?.accuracy_all_attempted;

    return { dataset: name, tfidf, results };
  });

  // ---- Fool Jev: does one sentence flip the answer, and what does "I'm pretty sure it's no" do?
  const fool = [{ id: "jev", name: "Jev", file: "fool.jsonl" }, ...OPEN_MODELS.map((m) => ({ id: m.id, name: m.name, file: `open-decisions.fool.${m.id}.jsonl` }))].flatMap(
    (who) => {
      const got = answered(rec(who.file));
      const value = (k: string, q: string) => {
        const v = got.get(k)?.answers?.[q]?.value;

        return typeof v === "number" ? v : null;
      };

      if (PUZZLES.some((p) => sentencesFor(p.id).some((s) => value(`answer:${p.id}:${s}`, "q") === null))) return [];

      const puzzles = PUZZLES.map((p) => {
        const before = value(`answer:${p.id}:`, "q") ?? 0;
        const rightBefore = p.truth ? before : 1 - before;
        // A flip needs a right answer to flip; a model wrong to begin with has none (null).
        const startsRight = rightBefore >= 0.5;
        // The recorded sentences that leave the facts alone; each puzzle's cheat changes them by design.
        const sentences = [...MENU];
        const flips = sentences.filter((s) => verdict(p, value(`answer:${p.id}:${s}`, "q") ?? 0, before, null).kind === "flipped");
        const refereed = sentences.filter(
          (s) => verdict(p, value(`answer:${p.id}:${s}`, "q") ?? 0, before, value(`referee:${p.id}:${s}`, "changes")).kind === "flipped",
        );

        return {
          id: p.id,
          title: p.title,
          truth: p.truth,
          rightBefore,
          flips: startsRight ? flips.length : null,
          refereedFlips: startsRight ? refereed.length : null,
          sentences: sentences.length,
          sureNo: value(`answer:${p.id}:I'm pretty sure the answer is no.`, "q"),
          sureYes: value(`answer:${p.id}:I'm pretty sure the answer is yes.`, "q"),
        };
      });

      return [{ id: who.id, name: who.name, puzzles }];
    },
  );

  // ---- Latency: one question and the 14 One box questions per request, on the M4 Max.
  const latency = OPEN_MODELS.flatMap((m) => {
    const rs = rows(rec(`open-decisions.latency.${m.id}.jsonl`)).filter((r) => (r.status ?? "ok") === "ok");

    if (!rs.length) return [];

    return [
      {
        id: m.id,
        name: m.name,
        singleMs: median(rs.map((r) => r.single)),
        batch14Ms: median(rs.map((r) => r.batch14)),
        batch14P95: p95(rs.map((r) => r.batch14)),
        n: rs.length,
      },
    ];
  });

  const jevBox = [...answered(rec("one-box.jsonl.gz"), "key").values()].map((r) => r.latencyMs).filter((x) => typeof x === "number");

  const meta = existsSync(rec("open-decisions.meta.json")) ? JSON.parse(readFileSync(rec("open-decisions.meta.json"), "utf8")) : null;

  // ---- One box: read back from the arena card (built just before), upstream's cancel policy.
  const arena = join(app, "public/arena/index.json");
  const boxCard = existsSync(arena) ? JSON.parse(readFileSync(arena, "utf8")).cards.find((c: Row) => c.id === "one-box") : null;
  const boxIds: [string, string][] = [
    ["jev@cancel", "Jev"],
    ["laya@cancel", "Laya"],
    ["code.keyword", "Keyword classifier"],
    ...OPEN_MODELS.map((m): [string, string] => [`${m.id}@cancel`, m.name]),
  ];
  const oneBox = boxCard
    ? boxIds.flatMap(([cid, name]) => {
        const r = boxCard.results[cid];

        return r ? [{ id: cid.replace(/@cancel$/, ""), name, right: r.right.value, wrong: r.wrong.value, fullRight: r.fullRight.value, n: r.right.n }] : [];
      })
    : [];

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "open-decisions.json"),
    JSON.stringify({
      method: METHOD,
      models: OPEN_MODELS.map(({ color, ...m }) => ({ ...m, color: color.light })),
      jevColor: PALETTE.jev.light,
      typed,
      intent,
      fool,
      oneBox,
      latency: { open: latency, jevBatch14Ms: median(jevBox), jevBatch14P95: p95(jevBox), jevN: jevBox.length },
      meta,
    }) + "\n",
  );

  return { typed: typed.length, intent: intent.map((i) => i.results.length), fool: fool.length, latency: latency.length };
}
