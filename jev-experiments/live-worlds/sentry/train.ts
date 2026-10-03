/**
 * Trains Screen sentry's heads on our authored blocks plus the openly licensed real datasets
 * (data/real.jsonl), writes weights.json, and evaluates on held-out data per source (eval.json):
 * held-out templates and families, each real source's test split, and two hand-written wild sets.
 * Nothing here is a Jev answer (TypeSafe MCA section 2.3(b)).
 *
 *   bun live-worlds/sentry/train.ts
 */
import { writeFileSync } from "node:fs";
import { generate, isTest, FAMILIES, type Example } from "./dataset";
import { DIM, features, HEADS, RISK_THRESHOLD, score, type Block, type Head, type Weights } from "./model";
import { realRows, toExample } from "./real";
import { WILD } from "./wild";
import { WILD2 } from "./wild2";

export function train(examples: Example[], epochs = 30, lr = 0.5, l2 = 1e-4): Weights {
  const heads = Object.fromEntries(HEADS.map((h) => [h, { w: new Array(DIM).fill(0), b: 0 }])) as Weights["heads"];
  const xs = examples.map((e) => features(e));

  for (let ep = 0; ep < epochs; ep++)
    for (let n = 0; n < examples.length; n++) {
      // A fixed stride through the data instead of a random shuffle keeps training deterministic.
      const k = (n * 7919 + ep * 104729) % examples.length;

      for (const h of HEADS) {
        const label = examples[k].labels[h];

        // Real rows only label the risk head; the others learn from authored blocks.
        if (label === undefined) continue;

        const p = heads[h];
        let z = p.b;

        for (const [i, v] of xs[k]) z += p.w[i] * v;

        const g = (1 / (1 + Math.exp(-z)) - label) * (examples[k].weight ?? 1);

        p.b -= lr * g;

        for (const [i, v] of xs[k]) p.w[i] -= lr * (g * v + l2 * p.w[i]);
      }
    }

  for (const h of HEADS) heads[h].w = heads[h].w.map((v) => Math.round(v * 1e4) / 1e4);

  return { dim: DIM, heads };
}

export function evaluate(w: Weights, examples: Example[]) {
  const per: Record<string, { n: number; right: number }> = {};
  const heads = Object.fromEntries(HEADS.map((h) => [h, { right: 0, n: 0 }])) as Record<Head, { right: number; n: number }>;
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (const e of examples) {
    const s = score(w, e);

    for (const h of HEADS) {
      const label = e.labels[h];

      if (label === undefined) continue;

      heads[h].n++;

      if ((s[h] >= 0.5 ? 1 : 0) === label) heads[h].right++;
    }

    const flagged = s.risk >= RISK_THRESHOLD;
    const inj = e.labels.risk === 1;

    if (flagged && inj) tp++;
    else if (flagged) fp++;
    else if (inj) fn++;
    else tn++;

    const key = `${e.family}${isTest(e) && FAMILIES.find((f) => f.id === e.family)?.heldOut ? " (family held out)" : ""}`;

    per[key] ??= { n: 0, right: 0 };
    per[key].n++;

    if (flagged === inj) per[key].right++;
  }

  return {
    n: examples.length,
    risk: { tp, fp, fn, tn, recall: tp / Math.max(1, tp + fn), falsePositiveRate: fp / Math.max(1, fp + tn), accuracy: (tp + tn) / examples.length },
    heads: Object.fromEntries(HEADS.map((h) => [h, heads[h].n ? heads[h].right / heads[h].n : null])),
    byFamily: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, `${v.right}/${v.n}`])),
  };
}

/** A hand-written set: recall on its injections and false alarms on its harmless blocks. */
export function wildSet(w: Weights, set: (Block & { injection: boolean; note: string })[]) {
  const rows = set.map((b) => ({ ...b, risk: Math.round(score(w, b).risk * 100) / 100 }));
  const hit = (r: (typeof rows)[number]) => r.risk >= RISK_THRESHOLD;
  const inj = rows.filter((r) => r.injection);
  const ok = rows.filter((r) => !r.injection);

  return {
    recall: `${inj.filter(hit).length}/${inj.length}`,
    falseAlarms: `${ok.filter(hit).length}/${ok.length}`,
    missed: inj.filter((r) => !hit(r)).map((r) => `${r.risk} ${r.note}`),
    flaggedBenign: ok.filter(hit).map((r) => `${r.risk} ${r.note}`),
  };
}

export const wild = (w: Weights) => wildSet(w, WILD);

/** Recall and false alarms on one source's held-out rows. */
export function perSource(w: Weights, examples: Example[]) {
  const inj = examples.filter((e) => e.labels.risk === 1);
  const ok = examples.filter((e) => e.labels.risk === 0);
  const hit = (e: Example) => score(w, e).risk >= RISK_THRESHOLD;

  return {
    injectionsCaught: inj.length ? `${inj.filter(hit).length}/${inj.length}` : "-",
    harmlessFlagged: ok.length ? `${ok.filter(hit).length}/${ok.length}` : "-",
  };
}

/**
 * How much a real row counts against an authored one. Chosen by sweep.ts on a validation split
 * carved from the training data (authored template 2, a fifth of the real train rows); no test
 * set was looked at.
 */
export const REAL_WEIGHT = 0.25;

/** Authored training blocks plus every real source's train split. */
export function trainingSet(realWeight = REAL_WEIGHT) {
  const authored = generate().filter((e) => !isTest(e));
  const real = realRows()
    .filter((r) => r.split === "train")
    .map((r) => ({ ...toExample(r), weight: realWeight }));

  return { authored, real, all: [...authored, ...real] };
}

if (import.meta.main) {
  const { authored, real, all } = trainingSet();
  const testSet = generate().filter(isTest);
  const realTest = realRows().filter((r) => r.split === "test").map(toExample);
  const w = train(all);

  writeFileSync(new URL("./weights.json", import.meta.url), JSON.stringify(w) + "\n");

  const sources = [...new Set(realTest.map((e) => e.source ?? ""))];
  const report = {
    trainedOn: `${authored.length} authored blocks (templates 0-2 of ${FAMILIES.filter((f) => !f.heldOut).length} families) and ${real.length} real rows (${[...new Set(real.map((e) => e.source))].join(", ")} train splits)`,
    testedOn: `${testSet.length} authored blocks (template 3 of every family, plus families never seen: ${FAMILIES.filter((f) => f.heldOut).map((f) => f.id).join(", ")}), ${realTest.length} real rows (each source's held-out split), and two hand-written wild sets`,
    authoredTest: evaluate(w, testSet),
    realTest: Object.fromEntries(sources.map((src) => [src, perSource(w, realTest.filter((e) => e.source === src))])),
    wild: wild(w),
    wild2: wildSet(w, WILD2),
  };

  writeFileSync(new URL("./eval.json", import.meta.url), JSON.stringify(report, null, 1) + "\n");
  console.log(
    JSON.stringify(
      {
        authored: report.authoredTest.risk,
        heldOutFamilies: Object.fromEntries(Object.entries(report.authoredTest.byFamily).filter(([key]) => key.includes("held out"))),
        real: report.realTest,
        wild: report.wild,
        wild2: report.wild2,
      },
      null,
      1,
    ),
  );
}
