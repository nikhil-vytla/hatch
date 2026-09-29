/**
 * What Decide adds up to, computed from the published data (decide.json) and, when there are
 * enough votes, the visitor tally. Pure functions, so the page and its tests agree.
 */
import type { DecideData, DecideDecision, DecideSetup } from "./data";

type Dist = Record<string, number>;

export const topId = (d: DecideDecision, dist: Dist) =>
  d.options.reduce((best, o) => ((dist[o.id] ?? 0) > (dist[best.id] ?? 0) ? o : best), d.options[0])
    .id;

const neutralOf = (d: DecideDecision) => d.setups.find((s) => s.id === "neutral") ?? d.setups[0];

/** Setups compared with the plain question, in the order the page shows them. */
export const VARIANTS = [
  { id: "leading", label: "Leading wording" },
  { id: "terse", label: "Terse wording" },
  { id: "shape", label: "Another answer shape" },
  { id: "context", label: "More context" },
  { id: "split", label: "Split into small questions" },
] as const;

export type VariantId = (typeof VARIANTS)[number]["id"];

const setupsFor = (d: DecideDecision, v: VariantId): DecideSetup[] =>
  d.setups.filter((s) => (v === "shape" ? s.group === "shape" : s.id === v));

/** Per contestant and variant: on how many decisions that variant changes the plain answer. */
export function flips(data: DecideData) {
  return data.contestants.map((c) => ({
    contestant: c,
    cells: VARIANTS.map((v) => {
      let asked = 0;
      let flipped = 0;

      for (const d of data.decisions) {
        const base = neutralOf(d).results[c.id];

        for (const s of setupsFor(d, v.id)) {
          const r = s.results[c.id];

          if (!base || !r) continue;
          asked++;

          if (topId(d, r.dist) !== topId(d, base.dist)) flipped++;
        }
      }

      return { variant: v, asked, flipped };
    }),
  }));
}

/** The calls with an answer: right when asked plainly, and which setups get it right. */
export function answered(data: DecideData) {
  return data.decisions.flatMap((d) => {
    const truth = d.truth;

    if (!truth) return [];

    return [
      {
        decision: d,
        truth,
        byContestant: data.contestants.map((c) => {
          const plain = neutralOf(d).results[c.id];

          const rightIn = d.setups.flatMap((s) => {
            const r = s.results[c.id];

            return r && topId(d, r.dist) === truth.option ? [s.label] : [];
          });

          return {
            contestant: c,
            plainRight: plain ? topId(d, plain.dist) === truth.option : null,
            rightIn,
            of: d.setups.filter((s) => s.results[c.id]).length,
          };
        }),
      },
    ];
  });
}

/** How often a contestant's plain answer holds across every setup of a decision. */
export function steadiness(data: DecideData) {
  return data.contestants.map((c) => {
    const held = data.decisions.filter((d) => {
      const base = neutralOf(d).results[c.id];

      return (
        base &&
        d.setups.every(
          (s) => !s.results[c.id] || topId(d, s.results[c.id].dist) === topId(d, base.dist),
        )
      );
    }).length;

    return { contestant: c, held, of: data.decisions.length };
  });
}

/** Decisions where the contestants' plain answers are not all the same. */
export function disagreements(data: DecideData) {
  return data.decisions.flatMap((d) => {
    const picks = data.contestants.flatMap((c) => {
      const r = neutralOf(d).results[c.id];

      return r
        ? [{ contestant: c, option: topId(d, r.dist), p: r.dist[topId(d, r.dist)] ?? 0 }]
        : [];
    });

    return new Set(picks.map((p) => p.option)).size > 1 ? [{ decision: d, picks }] : [];
  });
}

/** Fewer votes than this on a decision and the crowd's majority is not shown for it. */
export const MIN_VOTES = 5;

/** Per contestant: on how many decisions with enough votes it agrees with the visitors' majority. */
export function crowdAgreement(data: DecideData, tallies: Record<string, Record<string, number>>) {
  const voted = data.decisions.flatMap((d) => {
    const counts = tallies[d.id] ?? {};
    const total = Object.values(counts).reduce((s, n) => s + n, 0);

    if (total < MIN_VOTES) return [];
    const majority = topId(d, counts);

    return [{ decision: d, total, majority, share: (counts[majority] ?? 0) / total }];
  });

  return {
    voted,
    votes: data.decisions.reduce(
      (s, d) => s + Object.values(tallies[d.id] ?? {}).reduce((a, n) => a + n, 0),
      0,
    ),
    byContestant: data.contestants.map((c) => ({
      contestant: c,
      agree: voted.filter((v) => {
        const r = neutralOf(v.decision).results[c.id];

        return r && topId(v.decision, r.dist) === v.majority;
      }).length,
    })),
  };
}
