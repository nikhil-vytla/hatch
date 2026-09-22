import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The runner verifies every selected source file before and after this suite.
const root = process.env.RCW_REVIEW_SOURCE;
const observationPath = process.env.RCW_REVIEW_OBSERVATIONS;
if (!root || !observationPath) throw Error("Run through run-review.py with an explicit source and new output directory.");
const routing = pathToFileURL(resolve(root, "jev-experiments/roadmap/routing") + "/");
const runtime = pathToFileURL(resolve(root, "jev-experiments/roadmap/runtime") + "/");
const { createDecisionClassifier } = await import(new URL("classifier.ts", routing).href);
const { routeTask } = await import(new URL("router.ts", routing).href);
const { priorAdapter } = await import(new URL("decide.ts", routing).href);
const { defaultPolicy } = await import(new URL("policy.ts", routing).href);
const { requestAccounting } = await import(new URL("accounting.ts", runtime).href);

let unexpectedFetch = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { unexpectedFetch++; throw Error("Network is forbidden in this authored suite."); }) as typeof fetch;
const observations: Record<string, unknown>[] = [];
afterAll(() => {
  globalThis.fetch = originalFetch;
  writeFileSync(observationPath, JSON.stringify({condition: "Authored adapters and executor; no model inference or provider transport.", unexpectedFetch, observations}, null, 2) + "\n", {flag: "wx"});
  expect(unexpectedFetch).toBe(0);
});
const task = {id: "independent-rcw", prompt: "Review the supplied synthetic function.", context: "function fixture() { return 1; }"};
const identity = (adapter = "independent-local", revision = "authored-revision-a") => ({adapter, model: "authored-model", revision, local: true});
const destination = {
  id: "authored-route", model: "authored-destination", available: true, local: true, capabilities: ["text"], tools: [], contextTokens: 200_000, maxOutputTokens: 4096,
  quality: {value: 1, basis: "measured", evidence: "Synthetic test input; not measured quality."},
  latencyMs: {value: 0, basis: "measured", evidence: "Synthetic test input; not measured latency."},
  pricing: {inputPerMillion: 0, outputPerMillion: 0, basis: "configured", evidence: "Authored zero-charge executor."},
  destination: {kind: "openai-compatible", endpoint: "http://127.0.0.1:1/not-called"},
};
const config = {routes: [destination], policy: defaultPolicy};
function ledger(unknown = false) {
  const common = {requestMs: 2, requestedModel: "authored-model", model: "authored-model", modelSource: "configured-unverified", accountingScope: "gateway-response", providerAttempts: "unknown", issues: []};
  return requestAccounting([
    {...common, attempt: 1, status: 503, costUsd: 0.125, usage: {inputTokens: 9}},
    {...common, attempt: 2, status: 200, costUsd: unknown ? null : 0.25, usage: unknown ? null : {inputTokens: 11, outputTokens: 3, totalTokens: 14}},
  ]);
}
function adapter(id = identity(), accounting?: any, status = "ok", issues: any[] = []) {
  return {...priorAdapter, identity: id, async decide(request: any) {
    const ok = await priorAdapter.decide(request);
    return {...ok, status, execution: id, decisions: status === "ok" ? ok.decisions : [], issues,
      ...(accounting ? {accounting, costUsd: accounting.costUsd, usage: accounting.usage} : {costUsd: null})};
  }};
}
async function route(hooks: any) {
  let executions = 0;
  const result = await routeTask(task, config, {...hooks, execute: async () => {
    executions++;
    return {status: "ok", actualModel: destination.model, costUsd: 0, usage: null, artifact: {kind: "answer", text: "Authored executor result."}};
  }});
  // Exclude diagnostic timings from authored observation records.
  observations.push({executions, status: result.status, classification: {
    source: result.classification.source, status: result.classification.status,
    execution: result.classification.execution, declaredExecution: result.classification.declaredExecution,
    decisionStatus: result.classification.decisionStatus, issues: result.classification.issues,
    accounting: result.classification.accounting, costUsd: result.classification.costUsd,
  }, totalCostUsd: result.outcome.totalCostUsd, destinationAttempts: result.attempts.length, hasArtifact: !!result.outcome.artifact});
  return {result, executions};
}
function noDestination(record: any) {
  expect(record.executions).toBe(0);
  expect(record.result.status).toBe("error");
  expect(record.result.attempts).toEqual([]);
  expect(record.result.outcome.artifact).toBeUndefined();
}

test("valid adapter and revision changes survive successful routing in declared and actual identity", async () => {
  for (const id of [identity(), identity("independent-local", "authored-revision-b"), identity("second-local", "authored-revision-a")]) {
    const {result, executions} = await route(createDecisionClassifier(adapter(id)));
    expect(executions).toBe(1); expect(result.status).toBe("ok");
    expect(result.classification.declaredExecution).toEqual({...id, source: "local"});
    expect(result.classification.execution).toEqual({...id, source: "local"});
    expect(result.classification.decisionStatus).toBe("ok");
    expect(result.classification.issues).toEqual([]);
    expect(result.outcome.totalCostUsd).toBeNull();
  }
});

test("contradicted or missing reported adapter and revision fail closed without erasing observed spend", async () => {
  for (const unknown of [false, true]) for (const change of [{adapter: "different-adapter"}, {revision: "different-revision"}, {adapter: undefined}, {revision: undefined}]) {
    const accounting = ledger(unknown);
    const hooks = createDecisionClassifier(adapter(identity(), accounting));
    const record = await route({...hooks, classifier: async (input: any) => {
      const result = await hooks.classifier(input);
      return {...result, execution: {...result.execution, ...change}};
    }});
    noDestination(record);
    expect(record.result.classification.declaredExecution).toEqual({...identity(), source: "local"});
    const reported = {...identity(), source: "local", ...change};
    for (const key of ["adapter", "revision"] as const) if (reported[key] === undefined) delete reported[key];
    expect(record.result.classification.execution).toEqual(reported);
    expect(record.result.classification.accounting).toEqual(accounting);
    expect(record.result.outcome.totalCostUsd).toBe(accounting.costUsd);
  }
});

test("runtime identity rejection remains structured and keeps accounting observed before validation", async () => {
  for (const changed of [{adapter: "different-adapter"}, {revision: "different-revision"}]) {
    const accounting = ledger(true);
    const original = adapter(identity(), accounting);
    const record = await route(createDecisionClassifier({...original, async decide(request: any) {
      const result = await original.decide(request);
      return {...result, execution: {...result.execution, ...changed}};
    }}));
    noDestination(record);
    expect(record.result.classification.decisionStatus).toBe("error");
    expect(record.result.classification.issues).toEqual([{code: "identity_mismatch", message: "The returned destination does not match the configured runtime."}]);
    expect(record.result.classification.accounting).toEqual(accounting);
    expect(record.result.outcome.totalCostUsd).toBeNull();
  }
});

test("unsupported and error preserve every issue field and both paid and partly unknown accounting", async () => {
  for (const status of ["unsupported", "error"]) for (const accounting of [undefined, ledger(false), ledger(true)]) {
    const issues = [
      {code: "authored_limit", message: "Fixture accepts 768 units; supplied input has 769.", questionIds: ["category", "difficulty"], ignored: "not public diagnostic metadata"},
      {code: "authored_detail", message: "Second complete explanation.", questionIds: []},
      {code: "authored_global", message: "A request-wide explanation."},
    ];
    const expected = issues.map(({ignored, ...issue}) => structuredClone(issue));
    const record = await route(createDecisionClassifier(adapter(identity(), accounting, status, issues)));
    noDestination(record);
    expect(record.result.classification.decisionStatus).toBe(status);
    expect(record.result.classification.issues).toEqual(expected);
    expect(record.result.classification.execution).toEqual({...identity(), source: "local"});
    expect(record.result.classification.declaredExecution).toEqual({...identity(), source: "local"});
    for (const issue of issues) expect(record.result.classification.evidence).toContain(issue.message);
    expect(record.result.classification.accounting).toEqual(accounting);
    expect(record.result.outcome.totalCostUsd).toBe(accounting?.costUsd ?? null);
    issues[0].questionIds!.push("late-mutation");
    expect(record.result.classification.issues).toEqual(expected);
    if (accounting) {
      accounting.attempts[0].costUsd = 99;
      expect(record.result.classification.accounting.attempts[0].costUsd).toBe(0.125);
    }
  }
});

test("malformed diagnostic question IDs fail closed while observed accounting survives", async () => {
  for (const questionIds of [null, "category", [1], [" "]]) {
    const accounting = ledger(true);
    const record = await route(createDecisionClassifier(adapter(identity(), accounting, "unsupported", [{code: "authored_limit", message: "Readable refusal.", questionIds}])));
    noDestination(record);
    expect(record.result.classification.issues).toEqual([{code: "invalid_classifier_issues", message: "Classifier refusal contained malformed issue metadata."}]);
    expect(record.result.classification.accounting).toEqual(accounting);
  }
});

test("a thrown runtime error and cancellation retain observed attempts, messages and revision", async () => {
  for (const cancelled of [false, true]) {
    const accounting = ledger(true);
    const controller = new AbortController();
    const fixture = {...adapter(), async decide(_request: any, options: any) {
      options.onAccounting(accounting);
      if (cancelled) controller.abort();
      throw Error("Authored failure after accounting observation.");
    }};
    const record = await route({...createDecisionClassifier(fixture), signal: controller.signal});
    expect(record.executions).toBe(0);
    expect(record.result.status).toBe(cancelled ? "cancelled" : "error");
    expect(record.result.classification.decisionStatus).toBe(cancelled ? "cancelled" : "error");
    expect(record.result.classification.issues).toEqual([{code: cancelled ? "cancelled" : "runtime_error", message: "Authored failure after accounting observation."}]);
    expect(record.result.classification.execution).toEqual({...identity(), source: "local"});
    expect(record.result.classification.accounting).toEqual(accounting);
    expect(record.result.outcome.totalCostUsd).toBeNull();
    expect(record.result.attempts).toEqual([]); expect(record.result.outcome.artifact).toBeUndefined();
  }
});

test("existing model contradiction and no-destination unknown-cost controls remain enforced", async () => {
  const accounting = ledger(true);
  const hooks = createDecisionClassifier(adapter(identity(), accounting));
  const contradicted = await route({...hooks, classifier: async (input: any) => {
    const value = await hooks.classifier(input);
    return {...value, execution: {...value.execution, model: "unselected-model"}};
  }});
  noDestination(contradicted);
  expect(contradicted.result.classification.accounting).toEqual(accounting);
  expect(contradicted.result.outcome.totalCostUsd).toBeNull();
  const refused = await route(createDecisionClassifier(adapter(identity(), undefined, "unsupported", [{code: "authored_limit", message: "Input is unsupported."}])));
  noDestination(refused);
  expect(refused.result.outcome.totalCostUsd).toBeNull();
});
