import { describe, expect, test } from "bun:test";
import type { DecideData } from "./data";
import { answered, crowdAgreement, disagreements, flips, steadiness } from "./results";

const r = (a: number) => ({ dist: { a, b: 1 - a }, answers: {}, latencyMs: null });

const setup = (
  id: string,
  group: "wording" | "shape" | "split",
  results: Record<string, ReturnType<typeof r>>,
) => ({
  id,
  group,
  label: id,
  withContext: false,
  request: { state: {}, questions: {} },
  combine: null,
  rule: "",
  results,
});

const data: DecideData = {
  schema: "jev.decide/1",
  contestants: [
    { id: "x", name: "X", about: "", model: "" },
    { id: "y", name: "Y", about: "", model: "" },
  ],
  decisions: [
    {
      id: "d1",
      ask: "One?",
      state: {},
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      truth: { option: "b", why: "" },
      setups: [
        setup("neutral", "wording", { x: r(0.9), y: r(0.2) }),
        setup("terse", "wording", { x: r(0.8), y: r(0.7) }),
        setup("yes-no", "shape", { x: r(0.3), y: r(0.1) }),
      ],
    },
  ],
};

describe("results", () => {
  test("flips count setups whose answer differs from the plain one", () => {
    const [x, y] = flips(data);

    expect(x.cells.find((c) => c.variant.id === "terse")).toMatchObject({ asked: 1, flipped: 0 });
    expect(x.cells.find((c) => c.variant.id === "shape")).toMatchObject({ asked: 1, flipped: 1 });
    expect(y.cells.find((c) => c.variant.id === "terse")).toMatchObject({ asked: 1, flipped: 1 });
    expect(x.cells.find((c) => c.variant.id === "context")).toMatchObject({ asked: 0, flipped: 0 });
  });

  test("answered says who is right plainly and in which setups", () => {
    const [t] = answered(data);

    expect(t.byContestant.map((b) => [b.plainRight, b.rightIn])).toEqual([
      [false, ["yes-no"]],
      [true, ["neutral", "yes-no"]],
    ]);
  });

  test("steadiness and disagreement", () => {
    expect(steadiness(data).map((s) => s.held)).toEqual([0, 0]);
    expect(disagreements(data)).toHaveLength(1);
  });

  test("the crowd's majority shows only with enough votes", () => {
    expect(crowdAgreement(data, { d1: { a: 1, b: 2 } }).voted).toHaveLength(0);

    const c = crowdAgreement(data, { d1: { a: 1, b: 5 } });

    expect(c.voted[0]).toMatchObject({ majority: "b", total: 6 });
    expect(c.byContestant.map((b) => b.agree)).toEqual([0, 1]);
  });
});
