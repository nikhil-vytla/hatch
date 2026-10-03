/**
 * PROTOTYPE. Two recordings of the same study side by side: top-answer agreement on shared
 * questions, each one's flip rate, and the decoy effect with bootstrap intervals (plus a paired
 * interval on the difference, over scenarios).
 */
import { bootstrap, mean } from "../../../packages/arena/prose/metrics";
import { decoy, flipRate, tops } from "./analysis";
import { receipt, type Row } from "./record";
import { studyOf, type StudyId } from "./studies";

export function compare(a: Row[], b: Row[]) {
  const studies = (rows: Row[]) => new Set(rows.map((r) => studyOf(r.id)).filter((s): s is StudyId => s !== null));
  const shared = [...studies(a)].filter((s) => studies(b).has(s));
  const ta = tops(a);
  const tb = tops(b);
  const keys = [...ta.keys()].filter((k) => tb.has(k) && shared.includes(studyOf(k.split("#")[0]!) as StudyId));
  const agree = keys.filter((k) => ta.get(k) === tb.get(k)).length;

  const perStudy = shared.map((study) => {
    if (study === "decoy") {
      const da = decoy(a);
      const db = decoy(b);
      const both = da.scenarios.filter((s) => db.scenarios.some((t) => t.item === s.item));
      const diffs = both.map((s) => s.effect - db.scenarios.find((t) => t.item === s.item)!.effect);

      return { study, a: da.effect, b: db.effect, difference: { mean: mean(diffs), ci: bootstrap(diffs, 51), scenarios: diffs.length } };
    }

    return { study, a: flipRate(study, a), b: flipRate(study, b) };
  });

  return {
    studies: shared,
    agreement: { shared: keys.length, agree, rate: keys.length ? agree / keys.length : NaN },
    perStudy,
    receipts: { a: receipt(a), b: receipt(b) },
  };
}
