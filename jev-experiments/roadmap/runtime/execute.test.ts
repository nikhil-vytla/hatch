import { test, expect } from "bun:test";
import { decide } from "./execute";
import { createJevAdapter } from "./jev";
import {
  DEFAULT_LIMITS,
  type Adapter,
  type DecisionRequest,
  type DecisionResponse,
} from "./contract";
const request: DecisionRequest = {
  schemaVersion: "2",
  requestId: "one",
  state: "hello",
  questions: [{ id: "q", kind: "boolean", prompt: "Greeting?" }],
};
test("cancels even a runtime that ignores the signal", async () => {
  let finish!: (x: DecisionResponse) => void;
  const identity = { adapter: "mock", model: "mock", local: true };
  const adapter: Adapter = {
    identity,
    limits: DEFAULT_LIMITS,
    decide: () => new Promise((r) => (finish = r)),
  };
  const abort = new AbortController(),
    running = decide(adapter, request, { signal: abort.signal });
  abort.abort();
  expect((await running).status).toBe("cancelled");
  finish({
    schemaVersion: "2",
    requestId: "one",
    status: "ok",
    decisions: [
      {
        questionId: "q",
        distribution: [
          { value: false, probability: 0 },
          { value: true, probability: 1 },
        ],
        selected: true,
        probabilityTrue: 1,
      },
    ],
    execution: identity,
    timing: { totalMs: 1 },
    issues: [],
  });
});
test("native boolean response becomes a complete distribution", async () => {
  const result = await decide(
    createJevAdapter("fixture", (async () =>
      Response.json({
        answers: { q: { type: "noul", noul: 0.8 } },
      })) as unknown as typeof fetch),
    request,
  );
  expect(result.status).toBe("ok");
  expect(result.decisions[0].selected).toBe(true);
  expect(result.execution.local).toBe(false);
});
test("missing provider distributions fail explicitly", async () => {
  const q: DecisionRequest = {
    ...request,
    questions: [
      {
        id: "q",
        kind: "choice",
        prompt: "Pick",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ],
  };
  const result = await decide(
    createJevAdapter("fixture", (async () =>
      Response.json({
        answers: { q: { type: "choice", choice: "a" } },
      })) as unknown as typeof fetch),
    q,
  );
  expect(result.status).toBe("error");
  expect(result.decisions).toEqual([]);
});
