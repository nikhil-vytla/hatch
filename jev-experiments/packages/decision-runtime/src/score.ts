/** An authored acceptance tolerance, not a provider precision guarantee. */
export const SCORE_ROUNDING = 0.005;
const EPSILON = 1e-12;
/** Shared decimal-mass boundary, including only the frozen floating-point margin. */
export function probabilityMassAccepted(mass: number): boolean {
  return Number.isFinite(mass) && Math.abs(mass - 1) <= 0.025 + EPSILON;
}
export type ScoreAgreement = {
  accepted: boolean;
  reason:
    | "agreement"
    | "invalid_inputs"
    | "invalid_mass"
    | "infeasible_rounding"
    | "native_score_mismatch";
  rawScore: number;
  probabilities: number[];
  probabilityMass: number;
  normalizedExpectation: number | null;
  expectationInterval: [number, number] | null;
  scoreInterval: [number, number] | null;
  roundingAllowance: number;
};

/** Bound the expectation of every distribution that can round to the reported probabilities. */
export function scoreAgreement(
  score: number,
  probabilities: number[],
): ScoreAgreement {
  const mass = probabilities.reduce((sum, p) => sum + p, 0);
  const result: ScoreAgreement = {
    accepted: false,
    reason: "invalid_inputs",
    rawScore: score,
    probabilities: [...probabilities],
    probabilityMass: mass,
    normalizedExpectation:
      mass > 0
        ? probabilities.reduce((sum, p, i) => sum + i * p, 0) / mass
        : null,
    expectationInterval: null,
    scoreInterval: null,
    roundingAllowance: SCORE_ROUNDING,
  };
  if (
    probabilities.length < 2 ||
    probabilities.length > 10 ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > probabilities.length - 1 ||
    probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
  )
    return result;
  if (!probabilityMassAccepted(mass))
    return { ...result, reason: "invalid_mass" };
  const lower = probabilities.map((p) => Math.max(0, p - SCORE_ROUNDING));
  const upper = probabilities.map((p) => Math.min(1, p + SCORE_ROUNDING));
  const remaining = 1 - lower.reduce((sum, p) => sum + p, 0);
  if (
    remaining < -EPSILON ||
    upper.reduce((sum, p) => sum + p, 0) < 1 - EPSILON
  )
    return { ...result, reason: "infeasible_rounding" };
  // A linear objective is minimized/maximized by filling the lowest/highest indices first.
  const bound = (descending: boolean) => {
    let rest = Math.max(0, remaining);
    let mean = lower.reduce((sum, p, i) => sum + i * p, 0);
    const indices = probabilities.map((_, i) => i);
    if (descending) indices.reverse();
    for (const i of indices) {
      const added = Math.min(rest, upper[i] - lower[i]);
      mean += i * added;
      rest -= added;
    }
    return mean;
  };
  const expectationInterval: [number, number] = [bound(false), bound(true)];
  const scoreInterval: [number, number] = [
    Math.max(0, score - SCORE_ROUNDING),
    Math.min(probabilities.length - 1, score + SCORE_ROUNDING),
  ];
  const accepted =
    scoreInterval[1] >= expectationInterval[0] - EPSILON &&
    scoreInterval[0] <= expectationInterval[1] + EPSILON;
  return {
    ...result,
    accepted,
    reason: accepted ? "agreement" : "native_score_mismatch",
    expectationInterval,
    scoreInterval,
  };
}
