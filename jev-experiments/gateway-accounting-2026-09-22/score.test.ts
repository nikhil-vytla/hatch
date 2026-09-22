import { expect, test } from "bun:test";
import { probabilityMassAccepted, scoreAgreement } from "../packages/decision-runtime/src/score";

test("Score rounding intervals include exact endpoints and reject values immediately outside", () => {
  const interval = scoreAgreement(1.3, [0.2, 0.3, 0.5]).expectationInterval!;
  expect(interval[0]).toBeCloseTo(1.29, 12);
  expect(interval[1]).toBeCloseTo(1.31, 12);
  for (const value of [1.285, 1.3, 1.315])
    expect(scoreAgreement(value, [0.2, 0.3, 0.5]).accepted).toBe(true);
  for (const value of [1.285 - 1e-9, 1.315 + 1e-9, 0])
    expect(scoreAgreement(value, [0.2, 0.3, 0.5]).accepted).toBe(false);
  expect(scoreAgreement(1, [0.33, 0.33, 0.33]).accepted).toBe(true);
  expect(scoreAgreement(0.5, [0.49, 0.49]).reason).toBe("infeasible_rounding");
  expect(scoreAgreement(0.5, [0.51, 0.51]).reason).toBe("infeasible_rounding");
  expect(scoreAgreement(1, [0.3, 0.3, 0.426]).reason).toBe("invalid_mass");
  expect(scoreAgreement(0, [0, 0]).accepted).toBe(false);
  expect(scoreAgreement(0, [1]).accepted).toBe(false);
});

// Independent linear-program vertex enumeration, rather than another greedy implementation.
function vertexBounds(probabilities: number[]): [number, number] {
  const n = probabilities.length;
  let minimum = Infinity,
    maximum = -Infinity;
  for (let free = 0; free < n; free++) {
    const fixed = Array.from({ length: n }, (_, i) => i).filter(
      (i) => i !== free,
    );
    for (let mask = 0; mask < 2 ** fixed.length; mask++) {
      const q = Array(n).fill(0);
      for (let bit = 0; bit < fixed.length; bit++) {
        const i = fixed[bit];
        q[i] =
          mask & (2 ** bit)
            ? Math.min(1, probabilities[i] + 0.005)
            : Math.max(0, probabilities[i] - 0.005);
      }
      q[free] = 1 - q.reduce((sum, p) => sum + p, 0);
      if (
        q[free] < Math.max(0, probabilities[free] - 0.005) - 1e-12 ||
        q[free] > Math.min(1, probabilities[free] + 0.005) + 1e-12
      )
        continue;
      const value = q.reduce((sum, p, i) => sum + p * i, 0);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  return [minimum, maximum];
}

test("greedy Score interval equals independently enumerated feasible vertices for two through ten levels", () => {
  for (let n = 2; n <= 10; n++) {
    const probabilities = Array(n).fill(1 / n);
    const actual = scoreAgreement(
      (n - 1) / 2,
      probabilities,
    ).expectationInterval!;
    const expected = vertexBounds(probabilities);
    expect(actual[0]).toBeCloseTo(expected[0], 10);
    expect(actual[1]).toBeCloseTo(expected[1], 10);
  }
  expect(
    scoreAgreement(4.5, Array(10).fill(0.1)).expectationInterval![0],
  ).toBeCloseTo(4.375, 12);
  expect(
    scoreAgreement(4.5, Array(10).fill(0.1)).expectationInterval![1],
  ).toBeCloseTo(4.625, 12);
});

test("simultaneous probability and Score rounding conservatively accepts generated underlying distributions", () => {
  let accepted = 0,
    outsideMassGate = 0;
  for (let n = 2; n <= 10; n++)
    for (let seed = 1; seed <= 64; seed++) {
      const weights = Array.from(
        { length: n },
        (_, i) => ((seed * (i + 3) ** 2 + i * 17) % 97) + 1,
      );
      const total = weights.reduce((a, b) => a + b, 0);
      const q = weights.map((w) => w / total);
      const probabilities = q.map((p) => Math.round(p * 100) / 100);
      const score =
        Math.round(q.reduce((sum, p, i) => sum + p * i, 0) * 100) / 100;
      const result = scoreAgreement(score, probabilities);
      if (
        Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) >
        0.025 + 1e-12
      ) {
        expect(result.reason).toBe("invalid_mass");
        outsideMassGate++;
      } else {
        expect(result.accepted).toBe(true);
        accepted++;
      }
    }
  expect(accepted + outsideMassGate).toBe(576);
  expect(accepted).toBeGreaterThan(550);
});

test("nonuniform and clipped Score intervals match independent feasible vertices", () => {
  for (let n = 2; n <= 10; n++) {
    const weights = Array.from({ length: n }, (_, i) => i + 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    for (const probabilities of [
      weights.map((w) => w / sum),
      [1, ...Array(n - 1).fill(0)],
      [...Array(n - 1).fill(0), 1],
    ]) {
      const expected = vertexBounds(probabilities);
      const score = probabilities.reduce((mean, p, i) => mean + p * i, 0);
      const actual = scoreAgreement(score, probabilities).expectationInterval!;
      expect(actual[0]).toBeCloseTo(expected[0], 10);
      expect(actual[1]).toBeCloseTo(expected[1], 10);
    }
  }
});

test("probability mass uses the declared decimal boundary", () => {
  for (const mass of [.975, 1, 1.025]) expect(probabilityMassAccepted(mass)).toBe(true);
  for (const mass of [.975 - 2e-12, 1.025 + 2e-12, NaN, Infinity])
    expect(probabilityMassAccepted(mass)).toBe(false);
});
