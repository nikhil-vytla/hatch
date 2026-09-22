import { expect, test } from "bun:test";
import { decide } from "./execute";
import { createJevAdapter } from "./jev";
import { DEFAULT_LIMITS, validateRequest, validateResponse, type DecisionRequest } from "./contract";
import { createMacAdapter } from "../routing/mac-adapter";
import { createDecisionClassifier } from "../routing/classifier";

const request: DecisionRequest = {
  schemaVersion: "2", requestId: "structured", state: {ticket: "Export fails in Safari"},
  questions: [
    {id: "category", kind: "choice", prompt: {ask: "Which area?"}, options: [
      {id: "bug", label: "Bug", description: {includes: ["Failed export"], excludes: null}},
      {id: "other", label: "Other", description: null},
    ]},
    {id: "repro", kind: "boolean", prompt: ["Does this name a browser?"], criteria: {true: {required: "browser"}, false: "not stated"}},
    {id: "severity", kind: "ordinal", prompt: null, min: 10, max: 30, step: 10, levels: [null, {impact: "workaround exists"}, ["blocks all work"]]},
  ],
};

test("native transport preserves structured criteria, expectation, raw answer and provider identity", async () => {
  let sent: any;
  const adapter = createJevAdapter("fixture", (async (_url: unknown, options: RequestInit) => {
    sent = JSON.parse(String(options.body));
    return Response.json({model: "jev-fixture-resolved", answers: {
      category: {type: "choice", choice: "bug", probabilities: {bug: .7, other: .3}, confidence: .12},
      repro: {type: "noul", noul: .8, legend: {true: {required: "browser"}, false: "not stated"}},
      severity: {type: "score", score: 1.43, probabilities: {"0": 0, "1": .57, "2": .43}, confidence: .35,
        legend: {"0": null, "1": {impact: "workaround exists"}, "2": ["blocks all work"]}},
    }});
  }) as unknown as typeof fetch);
  const result = await decide(adapter, request);
  expect(result.status).toBe("ok");
  expect(sent.questions.category.criteria.other).toBeNull();
  expect(sent.questions.category.criteria.bug).toEqual({includes: ["Failed export"], excludes: null});
  expect(sent.questions.repro.criteria).toEqual({true: {required: "browser"}, false: "not stated"});
  expect(sent.questions.severity.criteria).toEqual([null, {impact: "workaround exists"}, ["blocks all work"]]);
  const score = result.decisions[2];
  expect(score.selected).toBe(20);
  expect(score.expected).toBeCloseTo(24.3);
  expect(score.nativeValue).toBe(1.43);
  expect(score.confidence).toBe(.35);
  expect(score.legend?.[1]).toEqual({value: 20, description: {impact: "workaround exists"}});
  expect(result.decisions[1].probabilityTrue).toBe(.8);
  expect(result.decisions[0].confidence).toBe(.12);
  expect(result.execution.model).toBe("jev-fixture-resolved");
  expect(result.execution.requestedModel).toBe("typesafe-ai/jev");
  const malformed = structuredClone(result); malformed.decisions[2].expected = 20;
  expect(validateResponse(request, malformed).length).toBeGreaterThan(0);
});

test("local support is checked before starting an unavailable executable", async () => {
  const mac = createMacAdapter({executable: "does-not-exist-fixture", model: "laya-readout-experimental", dataDirectory: "."});
  const response = await decide(mac, request);
  expect(response.status).toBe("unsupported");
  expect(response.issues.map(x => x.code)).toContain("unsupported_structure");
  expect(response.issues.map(x => x.code)).toContain("unsupported_criteria");
  expect(response.issues.map(x => x.code)).toContain("unsupported_levels");
});

test("contract rejects hidden values, unsupported versions and excess Score levels", () => {
  let reads = 0;
  expect(validateRequest({...request, get state() { reads++; return "unsafe"; }}).length).toBeGreaterThan(0);
  expect(reads).toBe(0);
  expect(validateRequest({...request, schemaVersion: "1"})[0].code).toBe("invalid_request");
  expect(validateRequest({...request, questions: [{id: "q", kind: "ordinal", prompt: "rate", min: 0, max: 10}]}).map(x => x.code)).toContain("ordinal_limit");
});

test("routing consumes expected difficulty, not its modal level", async () => {
  const identity = {adapter: "fixture", model: "fixture", local: true};
  const classifier = createDecisionClassifier({identity, limits: DEFAULT_LIMITS, async decide(req) {
    return {schemaVersion: "2", requestId: req.requestId, status: "ok", execution: identity, timing: {totalMs: 0}, issues: [], decisions: [
      {questionId: "category", selected: "bug-fix", distribution: ["bug-fix", "test-writing", "repository-analysis", "writing", "other"].map((value, i) => ({value, probability: i === 0 ? 1 : 0}))},
      {questionId: "difficulty", selected: .25, expected: .55, distribution: [0, .25, .5, .75, 1].map((value, i) => ({value, probability: [0, .6, 0, 0, .4][i]}))},
    ]};
  }});
  const result = await classifier.classifier({id: "fixture", prompt: "Fix parser", context: []} as any);
  expect(result.difficulty).toBe(.55);
});

test("provider alias resolution remains bound to the requested model in router validation", async () => {
  const {classificationIssues, inspectedClassification} = await import("../routing/hooks");
  const declared = {source: "hosted" as const, local: false, model: "typesafe-ai/jev", modelResolution: "provider" as const};
  const base = {source: "hosted" as const, category: "bug-fix" as const, difficulty: .5, confidence: .8, latencyMs: 1, costUsd: null, evidence: "fixture", execution: {...declared, model: "jev-resolved-fixture", requestedModel: "typesafe-ai/jev", modelSource: "provider-reported" as const}};
  expect(classificationIssues(base, declared)).toEqual([]);
  expect(inspectedClassification(base, declared).execution?.model).toBe("jev-resolved-fixture");
  expect(classificationIssues({...base, execution: {...base.execution, requestedModel: "another-model"}}, declared).length).toBeGreaterThan(0);
  expect(classificationIssues(base, {...declared, modelResolution: undefined}).length).toBeGreaterThan(0);
});

test("raw probability mass and measured usage survive normalization", async () => {
  const only = {...request, questions: [request.questions[0]]};
  const result = await decide(createJevAdapter("fixture", (async () => Response.json({
    usage: {input_tokens: 43, output_tokens: 4, total_tokens: 47}, provider_metadata: {gateway: {cost: "0.00001"}},
    answers: {category: {type: "choice", choice: "bug", probabilities: {bug: .7, other: .29}}},
  })) as unknown as typeof fetch), only);
  expect(result.status).toBe("ok");
  expect(result.decisions[0].probabilityMass).toBeCloseTo(.99);
  expect(result.decisions[0].distribution[0].probability).toBeCloseTo(.7 / .99);
  expect(result.usage).toEqual({inputTokens: 43, outputTokens: 4, totalTokens: 47});
  expect(result.costUsd).toBe(.00001);
  expect(result.execution.modelSource).toBe("configured-unverified");
});

test("checked execution rejects an ordinal response that substitutes the mode for the expectation", async () => {
  const identity = {adapter: "fixture", model: "fixture", local: true};
  const input: DecisionRequest = {schemaVersion: "2", requestId: "wrong-summary", state: "fixture", questions: [{id: "q", kind: "ordinal", prompt: "Rate", min: .25, max: 1, step: .75}]};
  const result = await decide({identity, limits: DEFAULT_LIMITS, async decide() {
    return {schemaVersion: "2", requestId: input.requestId, status: "ok", execution: identity, timing: {totalMs: 0}, issues: [], decisions: [{questionId: "q", selected: .25, expected: .25, distribution: [{value: .25, probability: .6}, {value: 1, probability: .4}]}]};
  }}, input);
  expect(result.status).toBe("error");
  expect(result.issues[0].code).toBe("invalid_response");
  expect(result.decisions).toEqual([]);
});
