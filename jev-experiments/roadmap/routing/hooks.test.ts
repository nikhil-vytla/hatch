import { expect, test } from "bun:test";
import { routeTask } from "./router";
import { defaultPolicy } from "./policy";
import type { Route, Task, Executor } from "./types";
const task: Task = {
  id: "verifier-boundary",
  prompt: "Fix a bug",
  context: "Synthetic source",
  outputTokens: 32,
};
const cheap: Route = {
  id: "cheap",
  model: "cheap-fixture",
  local: true,
  available: true,
  capabilities: ["text"],
  tools: [],
  contextTokens: 10000,
  maxOutputTokens: 128,
  quality: { value: 0.7, basis: "measured", evidence: "fixture" },
  latencyMs: { value: 1, basis: "measured", evidence: "fixture" },
  pricing: {
    inputPerMillion: 1,
    outputPerMillion: 1,
    basis: "configured",
    evidence: "fixture",
  },
  destination: { kind: "openai-compatible", endpoint: "http://127.0.0.1:1" },
};
const strong: Route = {
  ...cheap,
  id: "strong",
  model: "strong-fixture",
  quality: { ...cheap.quality, value: 0.9 },
  pricing: { ...cheap.pricing!, inputPerMillion: 2, outputPerMillion: 2 },
};
const policy = {
  ...defaultPolicy,
  weights: { quality: 0, cost: 1, latency: 0 },
  allowQualityEscalation: true,
  allowAvailabilityFallback: true,
  maxAttempts: 2,
};
const resultFor = (route = cheap) => ({
  status: "ok" as const,
  actualModel: route.model,
  usage: { inputTokens: 10, outputTokens: 10 },
  costUsd: 0.001,
  artifact: { kind: "answer" as const, text: `${route.id} proposal` },
});
const valid = {
  adequate: true,
  evidence: "Synthetic independent check",
  latencyMs: 1,
  costUsd: 0.00003,
};
const localIdentity = {
  adapter: "fixture-verifier",
  model: "deterministic-v1",
  local: true,
};
test("local-only never invokes an undeclared, remote or malformed-locality verifier", async () => {
  for (const verifierIdentity of [
    undefined,
    { ...localIdentity, local: false },
    { ...localIdentity, local: "true" },
    { model: "missing adapter", local: true },
  ]) {
    let calls = 0;
    const output = await routeTask(
      task,
      { routes: [cheap, strong], policy: { ...policy, localOnly: true } },
      {
        execute: async () => resultFor(),
        verifierIdentity,
        verify: async () => {
          calls++;
          return valid;
        },
      } as any,
    );
    expect(calls).toBe(0);
    expect(output.status).toBe("ok");
    expect(output.attempts).toHaveLength(1);
    expect(output.attempts[0].verification?.status).toBe("skipped");
    expect(output.attempts[0].verification?.adequate).toBeNull();
    expect(output.outcome.note).toContain("local");
    expect(output.outcome.totalCostUsd).toBe(0.001);
  }
});
test("an explicitly local verifier runs and preserves unknown charge plus evidence", async () => {
  const output = await routeTask(
    task,
    { routes: [cheap], policy: { ...policy, localOnly: true } },
    {
      execute: async () => resultFor(),
      verifierIdentity: localIdentity,
      verify: async () => ({ ...valid, costUsd: null }),
    },
  );
  expect(output.status).toBe("ok");
  expect(output.attempts[0].verification).toMatchObject({
    status: "ok",
    identity: localIdentity,
    adequate: true,
    evidence: valid.evidence,
    costUsd: null,
  });
  expect(output.outcome.totalCostUsd).toBeNull();
});
test("malformed verifier decisions cannot certify an answer, corrupt totals or cause either fallback", async () => {
  const values = [
    null,
    { ...valid, adequate: "yes" },
    { ...valid, adequate: undefined },
    { ...valid, evidence: " " },
    { ...valid, latencyMs: NaN },
    { ...valid, latencyMs: -1 },
    { ...valid, costUsd: NaN },
    { ...valid, costUsd: -1 },
    { ...valid, costUsd: undefined },
  ];
  for (const value of values) {
    let calls = 0;
    const output = await routeTask(
      task,
      { routes: [cheap, strong], policy },
      {
        execute: async () => {
          calls++;
          return resultFor();
        },
        verify: async () => value as any,
      },
    );
    expect(calls).toBe(1);
    expect(output.status).toBe("error");
    expect(output.outcome.artifact).toBeUndefined();
    expect(output.attempts[0].artifact?.text).toBe("cheap proposal");
    expect(output.attempts[0].verification?.status).toBe("error");
    expect(output.attempts[0].verification?.adequate).toBeNull();
    expect(
      output.outcome.totalCostUsd === null ||
        Number.isFinite(output.outcome.totalCostUsd),
    ).toBe(true);
    if (value && value.evidence === valid.evidence)
      expect(output.attempts[0].verification?.evidence).toBe(valid.evidence);
    if (
      !value ||
      value.costUsd === undefined ||
      !Number.isFinite(value.costUsd) ||
      value.costUsd < 0
    )
      expect(output.outcome.totalCostUsd).toBeNull();
  }
});
test("a thrown verifier records unknown charge and fails without escalation", async () => {
  const output = await routeTask(
    task,
    { routes: [cheap, strong], policy },
    {
      execute: async () => resultFor(),
      verify: async () => {
        throw Error("synthetic failure");
      },
    },
  );
  expect(output.status).toBe("error");
  expect(output.attempts).toHaveLength(1);
  expect(output.attempts[0].verification?.status).toBe("error");
  expect(output.outcome.totalCostUsd).toBeNull();
  expect(output.outcome.artifact).toBeUndefined();
});
test("valid rejection alone triggers quality escalation and includes all known verifier charges", async () => {
  let calls = 0;
  const output = await routeTask(
    task,
    { routes: [cheap, strong], policy: { ...policy, localOnly: true } },
    {
      execute: async (route) => resultFor(route),
      verifierIdentity: localIdentity,
      verify: async () => ({ ...valid, adequate: ++calls === 2 }),
    },
  );
  expect(output.status).toBe("ok");
  expect(output.attempts).toHaveLength(2);
  expect(output.attempts[1].trigger).toBe("quality-escalation");
  expect(output.outcome.artifact?.text).toBe("strong proposal");
  expect(output.outcome.totalCostUsd).toBeCloseTo(0.00206, 10);
});
test("cancellation during verification discards the proposal and retains a returned charge", async () => {
  const abort = new AbortController();
  const output = await routeTask(
    task,
    { routes: [cheap], policy },
    {
      signal: abort.signal,
      execute: async () => resultFor(),
      verify: async () => {
        abort.abort();
        return valid;
      },
    },
  );
  expect(output.status).toBe("cancelled");
  expect(output.outcome.artifact).toBeUndefined();
  expect(output.attempts[0].verification?.status).toBe("cancelled");
  expect(output.attempts[0].verification?.costUsd).toBe(valid.costUsd);
  expect(output.outcome.totalCostUsd).toBeCloseTo(resultFor().costUsd! + valid.costUsd!, 10);
});
test("invalid custom executor metadata cannot create negative budgets or a false usable result", async () => {
  for (const value of [
    null,
    { ...resultFor(), costUsd: -1 },
    { ...resultFor(), costUsd: NaN },
    { ...resultFor(), usage: { inputTokens: -1, outputTokens: 1 } },
    { ...resultFor(), usage: { inputTokens: 1.5, outputTokens: 2 } },
    { ...resultFor(), usage: { inputTokens: 2, outputTokens: 0.5 } },
    { ...resultFor(), usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0.5 } },
    { ...resultFor(), usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 } },
    { ...resultFor(), artifact: { kind: "answer", text: "" } },
  ]) {
    let calls = 0;
    const output = await routeTask(
      task,
      { routes: [cheap, strong], policy: { ...policy, maxCostUsd: 0.01 } },
      {
        execute: (async () => {
          calls++;
          return value;
        }) as Executor,
      },
    );
    expect(calls).toBe(1);
    expect(output.status).toBe("error");
    expect(output.outcome.totalCostUsd).toBe(value && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : null);
    expect(output.outcome.artifact).toBeUndefined();
  }
});

test("classifier identity contradictions stop before destination execution", async () => {
  const declared = { source: "local" as const, local: true, model: "local-v1" };
  const base = {
    source: "local" as const,
    category: "bug-fix" as const,
    difficulty: 0.2,
    confidence: 0.8,
    latencyMs: 1,
    costUsd: 0,
    evidence: "Fixture traits",
    execution: declared,
  };
  for (const returned of [
    {
      ...base,
      source: "hosted",
      execution: { source: "hosted", local: false, model: "remote" },
    },
    { ...base, execution: { ...declared, local: false } },
    { ...base, execution: { ...declared, model: "different" } },
    { ...base, execution: { ...declared, source: "hosted" } },
    { ...base, execution: { ...declared, local: "true" } },
    null,
  ]) {
    let calls = 0;
    const output = await routeTask(
      task,
      { routes: [cheap], policy: { ...policy, localOnly: true } },
      {
        classifierIdentity: declared,
        classifier: async () => returned as any,
        execute: async () => {
          calls++;
          return resultFor();
        },
      },
    );
    expect(calls).toBe(0);
    expect(output.status).toBe("error");
    expect(output.attempts).toHaveLength(0);
    expect(output.classification.status).toBe("error");
    expect(output.classification.category).toBe("bug-fix");
    expect(output.outcome.totalCostUsd).toBe(returned === null ? null : 0);
  }
});

test("consistent declared classifier identity works, including host traits without repeated identity", async () => {
  for (const source of ["host", "local"] as const) {
    const declared = { source, local: true, model: "fixture-v1" };
    const output = await routeTask(
      task,
      { routes: [cheap], policy: { ...policy, localOnly: true } },
      {
        classifierIdentity: declared,
        classifier: async () => ({
          source,
          category: "bug-fix",
          difficulty: 0.2,
          confidence: 0.8,
          latencyMs: 1,
          costUsd: 0,
          evidence: "Fixture traits",
          ...(source === "local" ? { execution: declared } : {}),
        }),
        execute: async () => resultFor(),
      },
    );
    expect(output.status).toBe("ok");
    expect(output.classification.source).toBe(source);
    expect(output.attempts).toHaveLength(1);
  }
});

test("hard budget skips unreserved verification and records an unverified proposal", async () => {
  let calls = 0;
  const output = await routeTask(
    task,
    { routes: [cheap], policy: { ...policy, maxCostUsd: 0.1 } },
    {
      execute: async () => resultFor(),
      verifierIdentity: localIdentity,
      verify: async () => {
        calls++;
        return valid;
      },
    },
  );
  expect(calls).toBe(0);
  expect(output.status).toBe("ok");
  expect(output.attempts[0].verification?.status).toBe("skipped");
  expect(output.outcome.note).toContain("unverified");
});

test("a rejected first proposal is not returned when the stronger destination fails", async () => {
  const output = await routeTask(
    task,
    { routes: [cheap, strong], policy },
    {
      execute: async (route) =>
        route.id === cheap.id
          ? resultFor(route)
          : {
              status: "error",
              actualModel: route.model,
              usage: null,
              costUsd: null,
              error: "Fixture failure",
            },
      verify: async () => ({ ...valid, adequate: false }),
    },
  );
  expect(output.status).toBe("error");
  expect(output.attempts).toHaveLength(2);
  expect(output.outcome.actualRouteId).toBe("strong");
  expect(output.outcome.artifact).toBeUndefined();
  expect(output.attempts[0].artifact?.text).toBe("cheap proposal");
});

test("finite reported charges cannot overflow the public total", async () => {
  const output = await routeTask(
    task,
    { routes: [cheap], policy },
    {
      execute: async () => ({ ...resultFor(), costUsd: Number.MAX_VALUE }),
      verify: async () => ({ ...valid, costUsd: Number.MAX_VALUE }),
    },
  );
  expect(output.status).toBe("ok");
  expect(output.outcome.totalCostUsd).toBeNull();
});

test("reported hosted identity remains visible when it contradicts declared locality", async () => {
  const declared = { source: "local" as const, model: "fixture", local: true };
  const reported = { source: "hosted" as const, model: "remote", local: false };
  const output = await routeTask(
    task,
    { routes: [cheap], policy: { ...policy, localOnly: true } },
    {
      classifierIdentity: declared,
      classifier: async () => ({
        source: "hosted",
        category: "bug-fix",
        difficulty: 0.2,
        confidence: 0.8,
        latencyMs: 1,
        costUsd: 0.001,
        evidence: "Returned remote traits",
        execution: reported,
      }),
      execute: async () => resultFor(),
    },
  );
  expect(output.status).toBe("error");
  expect(output.classification.execution).toEqual(reported);
  expect(output.classification.declaredExecution).toEqual(declared);
  expect(output.classification.evidence).toContain("contradicts");
  expect(output.attempts).toHaveLength(0);
  expect(output.classification.costUsd).toBe(.001);
  expect(output.outcome.totalCostUsd).toBe(.001);
});

test("a custom executor cannot substitute a different model or cause an identity fallback", async () => {
  let calls = 0;
  const output = await routeTask(
    task,
    { routes: [cheap, strong], policy },
    {
      execute: async () => {
        calls++;
        return {
          ...resultFor(),
          actualModel: "substitute",
          identityBasis: "provider-reported",
          costUsd: 2,
        };
      },
      verify: async () => valid,
    },
  );
  expect(calls).toBe(1);
  expect(output.status).toBe("error");
  expect(output.outcome.actualModel).toBe("substitute");
  expect(output.outcome.artifact).toBeUndefined();
  expect(output.outcome.totalCostUsd).toBe(2);
  expect(output.attempts[0].usage).toEqual({
    inputTokens: 10,
    outputTokens: 10,
  });
  expect(output.attempts[0].verification).toBeUndefined();
  expect(output.attempts[0].error).toContain("does not match");
});
