/**
 * Picks REAL_WEIGHT (how much a real row counts against an authored one) on a validation split
 * carved from the training data: authored template 2 of every training family, and a fixed fifth
 * of each real source's train rows. Test sets (template 3, held-out families, real test splits,
 * both wild sets) are never read here.
 *
 *   bun live-worlds/sentry/sweep.ts
 */
import { trainingSet, train } from "./train";
import { RISK_THRESHOLD, score } from "./model";
import type { Example } from "./dataset";
import { fnv1aUnit } from "../../packages/seeded/src/index";

const hashed = (s: string) => fnv1aUnit(s, 0x2545f491);

const isValidation = (e: Example) => (e.source ? hashed(e.text) < 0.2 : e.template === 2);

/** Balanced accuracy on risk: the mean of recall and 1 − false-alarm rate. */
function balanced(w: ReturnType<typeof train>, rows: Example[]) {
  const inj = rows.filter((e) => e.labels.risk === 1);
  const ok = rows.filter((e) => e.labels.risk === 0);
  const hit = (e: Example) => score(w, e).risk >= RISK_THRESHOLD;
  const recall = inj.filter(hit).length / Math.max(1, inj.length);
  const falseAlarms = ok.filter(hit).length / Math.max(1, ok.length);

  return { recall, falseAlarms, balanced: (recall + 1 - falseAlarms) / 2 };
}

if (import.meta.main) {
  for (const weight of [0, 0.1, 0.25, 0.5, 1]) {
    const { all } = trainingSet(weight);
    const fit = all.filter((e) => !isValidation(e));
    const val = all.filter(isValidation);
    const w = train(fit);
    const authored = balanced(w, val.filter((e) => !e.source));
    const real = balanced(w, val.filter((e) => e.source));

    console.log(
      `weight ${weight}: authored balanced ${authored.balanced.toFixed(3)} (false alarms ${authored.falseAlarms.toFixed(3)}) · real balanced ${real.balanced.toFixed(3)} (recall ${real.recall.toFixed(3)}, false alarms ${real.falseAlarms.toFixed(3)}) · mean ${((authored.balanced + real.balanced) / 2).toFixed(3)}`,
    );
  }
}
