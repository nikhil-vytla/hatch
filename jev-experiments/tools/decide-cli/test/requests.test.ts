/** Request builders: the CLI asks exactly what our recordings asked. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fromDecisionsAnswers, toDecisionsRequest } from "../src/endpoints";
import { readRows } from "../src/record";
import { jobsFor, studyOf } from "../src/studies";

const root = new URL("../../../packages/arena/", import.meta.url).pathname;

describe("study jobs", () => {
  test("sizes", () => {
    expect(jobsFor("fool")).toHaveLength(175);
    expect(jobsFor("suggestion")).toHaveLength(100);
    expect(jobsFor("decoy")).toHaveLength(48);
  });

  test("every job id is one our recordings answered, so runs line up request for request", () => {
    const prose = new Set(readRows(`${root}prose/recordings/prose.jsonl.gz`).filter((r) => r.status === "ok").map((r) => r.id));
    const foolIds = new Set(readRows(`${root}recordings/fool.jsonl`).filter((r) => r.status === "ok").map((r) => r.id));

    for (const j of [...jobsFor("suggestion"), ...jobsFor("decoy")]) expect(prose.has(j.id)).toBe(true);
    for (const j of jobsFor("fool")) expect(foolIds.has(j.id)).toBe(true);
  });

  test("prose requests hash to what the recording logged", () => {
    const logged = new Map(readRows(`${root}prose/recordings/prose.jsonl.gz`).map((r) => [r.id, (r as { requestHash?: string }).requestHash]));
    const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
    const checked = jobsFor("decoy").filter((j) => logged.get(j.id));

    expect(checked.length).toBeGreaterThan(0);

    for (const j of checked) expect(hash(j.request)).toBe(logged.get(j.id)!);
  });

  test("ids map back to their study", () => {
    expect(studyOf("answer:weather:")).toBe("fool");
    expect(studyOf("referee:cart:Be strict.")).toBe("fool");
    expect(studyOf("decoy:apartment:none:forward")).toBe("decoy");
    expect(studyOf("claim-truth:weather:suggestion:most-say-no")).toBe("suggestion");
    expect(studyOf("claim-truth:weather:register:formal")).toBe(null);
  });
});

describe("SGLang /v1/decisions translation", () => {
  test("yes/no and choice questions", () => {
    const r = toDecisionsRequest({
      state: { a: 1 },
      questions: {
        q: { type: "noul", instructions: "Is it?" },
        c: { type: "choice", instructions: "Which?", criteria: { Ash: "first", Birch: "second" } },
      },
    });

    expect(r).toEqual({
      input: { a: 1 },
      questions: [
        { id: "q", type: "yes_no", question: "Is it?" },
        { id: "c", type: "choice", question: "Which?", options: [{ name: "Ash", description: "first" }, { name: "Birch", description: "second" }] },
      ],
    });
  });

  test("answers come back in our wire shape", () => {
    const a = fromDecisionsAnswers({ q: { type: "yes_no", probabilities: { yes: 0.8, no: 0.2 } }, c: { type: "choice", choice: "Ash", probabilities: { Ash: 0.7, Birch: 0.3 } } });

    expect(a.q).toEqual({ type: "noul", value: 0.8, probabilities: { false: 0.19999999999999996, true: 0.8 } });
    expect(a.c).toEqual({ type: "choice", value: "Ash", probabilities: { Ash: 0.7, Birch: 0.3 } });
  });
});
