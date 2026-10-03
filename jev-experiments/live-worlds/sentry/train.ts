/**
 * PROTOTYPE. Trains Screen sentry's heads on the authored training blocks, writes weights.json,
 * and evaluates on held-out templates and families (eval.json).
 *
 *   bun live-worlds/sentry/train.ts
 */
import { writeFileSync } from "node:fs";
import { generate, isTest, FAMILIES, type Example } from "./dataset";
import { DIM, features, HEADS, RISK_THRESHOLD, score, type Head, type Weights } from "./model";
import { WILD } from "./wild";

export function train(examples: Example[], epochs = 30, lr = 0.5, l2 = 1e-4): Weights {
  const heads = Object.fromEntries(HEADS.map((h) => [h, { w: new Array(DIM).fill(0), b: 0 }])) as Weights["heads"];
  const xs = examples.map((e) => features(e));

  for (let ep = 0; ep < epochs; ep++)
    for (let n = 0; n < examples.length; n++) {
      // A fixed stride through the data instead of a random shuffle keeps training deterministic.
      const k = (n * 7919 + ep * 104729) % examples.length;

      for (const h of HEADS) {
        const p = heads[h];
        let z = p.b;

        for (const [i, v] of xs[k]) z += p.w[i] * v;

        const g = 1 / (1 + Math.exp(-z)) - examples[k].labels[h];

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
      heads[h].n++;

      if ((s[h] >= 0.5 ? 1 : 0) === e.labels[h]) heads[h].right++;
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
    heads: Object.fromEntries(HEADS.map((h) => [h, heads[h].right / heads[h].n])),
    byFamily: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, `${v.right}/${v.n}`])),
  };
}

/** The hand-written wild set: recall on its 20 injections and false alarms on its 20 benign blocks. */
export function wild(w: Weights) {
  const rows = WILD.map((b) => ({ ...b, risk: Math.round(score(w, b).risk * 100) / 100 }));
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

if (import.meta.main) {
  const all = generate();
  const trainSet = all.filter((e) => !isTest(e));
  const testSet = all.filter(isTest);
  const w = train(trainSet);

  writeFileSync(new URL("./weights.json", import.meta.url), JSON.stringify(w) + "\n");

  const report = {
    trainedOn: `${trainSet.length} authored blocks: templates 0–2 of ${FAMILIES.filter((f) => !f.heldOut).length} families`,
    testedOn: `${testSet.length} blocks: template 3 of every family, plus 2 families never seen (${FAMILIES.filter((f) => f.heldOut).map((f) => f.id).join(", ")})`,
    train: evaluate(w, trainSet),
    test: evaluate(w, testSet),
    wild: wild(w),
  };

  writeFileSync(new URL("./eval.json", import.meta.url), JSON.stringify(report, null, 1) + "\n");
  console.log(
    JSON.stringify(
      { test: report.test.risk, heldOutFamilies: Object.fromEntries(Object.entries(report.test.byFamily).filter(([k]) => k.includes("held out"))), wild: report.wild },
      null,
      1,
    ),
  );
}
