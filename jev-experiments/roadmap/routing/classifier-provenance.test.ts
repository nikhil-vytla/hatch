import { expect, test } from "bun:test";
import { createDecisionClassifier } from "./classifier";
import { classifierIdentity, classifierIssues } from "./hooks";
import { priorAdapter } from "./decide";
import { defaultPolicy } from "./policy";
import { routeTask } from "./router";
import type { Adapter, DecisionResponse } from "../runtime/contract";
import type { Route } from "./types";

const task = {id: "authored-provenance", prompt: "Review the supplied source.", context: "function example() { return 1; }"};
const identity = (revision: string) => ({adapter: "authored-local-adapter", model: "authored-same-model", revision, local: true});
const adapter = (revision: string): Adapter => ({
  ...priorAdapter, identity: identity(revision),
  async decide(request) { return {...await priorAdapter.decide(request), execution: identity(revision), costUsd: null}; },
});
const eligible: Route = {
  id: "authored-destination", model: "authored-destination", available: true, local: true, capabilities: [], tools: [], contextTokens: 200_000, maxOutputTokens: 4096,
  quality: {value: 1, basis: "measured", evidence: "Authored test input, not measurement."},
  latencyMs: {value: 0, basis: "measured", evidence: "Authored test input, not measurement."},
  pricing: {inputPerMillion: 0, outputPerMillion: 0, basis: "configured", evidence: "Authored test input."},
  destination: {kind: "openai-compatible", endpoint: "http://127.0.0.1:1/unreachable"},
};
const config = {routes: [eligible], policy: defaultPolicy};

test("validated local revisions remain distinct in declared and actual classifier identities", async () => {
  const records = [];
  for (const revision of ["revision-a", "revision-b"]) {
    const result = await routeTask(task, {...config, routes: []}, createDecisionClassifier(adapter(revision)));
    expect(result.classification.status).toBe("ok");
    expect(result.classification.execution).toEqual({...identity(revision), source: "local"});
    expect(result.classification.declaredExecution).toEqual({...identity(revision), source: "local"});
    expect(result.classification.decisionStatus).toBe("ok");
    records.push(result.classification.execution);
  }
  expect(records[0]).not.toEqual(records[1]);
});

test("reported adapter or revision contradictions stop routing but preserve actual identity", async () => {
  const hooks = createDecisionClassifier(adapter("revision-a"));
  for (const changed of [{adapter: "authored-other-adapter"}, {revision: "revision-b"}]) {
    let executed = false;
    const result = await routeTask(task, config, {...hooks,
      classifier: async input => {const original = await hooks.classifier(input); return {...original, execution: {...original.execution!, ...changed}};},
      execute: async () => {executed = true; throw Error("A contradicted identity must not execute.");},
    });
    expect(result.status).toBe("error"); expect(executed).toBe(false);
    expect(result.classification.execution).toEqual({...identity("revision-a"), source: "local", ...changed});
    expect(result.classification.declaredExecution).toEqual({...identity("revision-a"), source: "local"});
    expect(result.attempts).toEqual([]);
  }
});

test("typed refusal retains actionable limits, affected questions, status and local revision", async () => {
  const issue = {code: "token_limit", message: "Authored input uses 769 tokens; this runtime accepts at most 768.", questionIds: ["category"], unrelated: "must not be projected"};
  let executed = false;
  const local: Adapter = {...adapter("revision-refused"), async decide(request): Promise<DecisionResponse> {
    return {schemaVersion: "2", requestId: request.requestId, status: "unsupported", decisions: [], execution: identity("revision-refused"), timing: {totalMs: 0}, costUsd: null, issues: [issue]};
  }};
  const result = await routeTask(task, config, {...createDecisionClassifier(local), execute: async () => {executed = true; throw Error("A refusal must not execute.");}});
  expect(result.status).toBe("error"); expect(executed).toBe(false); expect(result.attempts).toEqual([]);
  expect(result.classification.decisionStatus).toBe("unsupported");
  expect(result.classification.issues).toEqual([{code: issue.code, message: issue.message, questionIds: ["category"]}]);
  expect(result.classification.evidence).toContain(issue.message);
  expect(result.classification.execution).toEqual({...identity("revision-refused"), source: "local"});
  expect(result.outcome.totalCostUsd).toBeNull(); expect(result.outcome.artifact).toBeUndefined();
  issue.questionIds.push("mutated-after-return");
  expect(result.classification.issues![0].questionIds).toEqual(["category"]);
});

test("classifier metadata projection rejects malformed identifiers and strips unrelated fields", () => {
  for (const change of [{adapter: " "}, {adapter: 1}, {revision: ""}, {revision: null}])
    expect(classifierIdentity({...identity("revision-a"), source: "local", ...change})).toBeNull();
  for (const questionIds of [null, "category", [1], [" "]])
    expect(classifierIssues([{code: "token_limit", message: "A useful explanation.", questionIds}])).toBeNull();
  expect(classifierIssues([{code: "token_limit", message: "A useful explanation.", questionIds: ["category"], unrelated: "omit"}]))
    .toEqual([{code: "token_limit", message: "A useful explanation.", questionIds: ["category"]}]);
});
