import { decisionSummary } from "../../../roadmap/runtime/contract";

export const scoreLevels = [
  {
    value: 0,
    label: "Cosmetic",
    description: "Visible defect; the task still works.",
  },
  {
    value: 1,
    label: "Workaround",
    description: "The task works through another route.",
  },
  { value: 2, label: "Blocked", description: "The task cannot be completed." },
] as const;

/** Authored probability fixture. No model is called. */
export function summarizeScore(
  middlePercent: number,
  highSharePercent: number,
) {
  for (const n of [middlePercent, highSharePercent]) {
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new RangeError("Probability controls must be between 0 and 100.");
  }
  const middle = middlePercent / 100;
  const highShare = highSharePercent / 100;
  const high = (1 - middle) * highShare;
  const low = (1 - middle) * (1 - highShare);
  const probabilities = [low, middle, high];
  const distribution = scoreLevels.map((level, i) => ({
    value: level.value,
    probability: probabilities[i],
  }));
  const { expected } = decisionSummary(
    {
      id: "severity",
      kind: "ordinal",
      prompt: "How severe is the defect?",
      min: 0,
      max: 2,
    },
    distribution,
  );
  const peak = Math.max(...probabilities);
  const modes = distribution
    .filter((p) => Math.abs(p.probability - peak) < 1e-12)
    .map((p) => p.value);
  return { distribution, expected: expected!, modes };
}
