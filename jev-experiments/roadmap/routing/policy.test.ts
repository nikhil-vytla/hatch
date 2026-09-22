import { describe, expect, test } from "bun:test";
import { defaultPolicy, selectRoute } from "./policy";
import { routeTask } from "./router";
import { decide } from "./decide";
import { classifyEml } from "./email";
import type { Route, Task } from "./types";
const task: Task = {
  id: "fixture",
  prompt: "Fix a bug",
  context: "source",
  outputTokens: 50,
};
const route: Route = {
  id: "cheap",
  model: "fixture",
  available: true,
  local: true,
  capabilities: ["text"],
  tools: [],
  contextTokens: 10_000,
  maxOutputTokens: 100,
  quality: { value: 0.8, basis: "measured", evidence: "test fixture" },
  latencyMs: { value: 10, basis: "measured", evidence: "test fixture" },
  pricing: {
    inputPerMillion: 1,
    outputPerMillion: 1,
    basis: "configured",
    evidence: "test fixture",
  },
  destination: { kind: "openai-compatible", endpoint: "http://127.0.0.1:1" },
};
const ok = async () => ({
  status: "ok" as const,
  actualModel: route.model,
  usage: { inputTokens: 10, outputTokens: 10 },
  costUsd: 0.00002,
  artifact: { kind: "answer" as const, text: "answer" },
});
describe("hard eligibility", () => {
  test("never widens when no route meets permissions", () => {
    const selection = selectRoute(
      { ...task, requiredTools: ["shell"] },
      [route],
      defaultPolicy,
    );
    expect(selection.status).toBe("unavailable");
    expect(selection.candidates[0].reasons.join()).toContain("not permitted");
  });
  test("rejects local-only cloud destinations", () =>
    expect(
      selectRoute(task, [{ ...route, local: false }], {
        ...defaultPolicy,
        localOnly: true,
      }).routeId,
    ).toBeNull());
  test("rejects excessive context without truncating", () =>
    expect(
      selectRoute(
        { ...task, context: "x".repeat(10000) },
        [route],
        defaultPolicy,
      ).routeId,
    ).toBeNull());
  test("requires configured known prices for hard caps", () => {
    for (const pricing of [
      null,
      { ...route.pricing!, basis: "simulation" as const },
    ])
      expect(
        selectRoute(task, [{ ...route, pricing }], {
          ...defaultPolicy,
          maxCostUsd: 1,
        }).routeId,
      ).toBeNull();
  });
  test("does not spend cache savings against hard caps", () => {
    const cached = {
      ...route,
      cache: {
        tokens: 10000,
        expiresAt: Date.now() + 10000,
        basis: "simulation" as const,
      },
      pricing: { ...route.pricing!, cachedInputPerMillion: 0 },
    };
    const s = selectRoute(task, [cached], {
      ...defaultPolicy,
      maxCostUsd: 0.001,
    });
    expect(s.routeId).toBeNull();
    expect(s.candidates[0].estimatedCostUsd!).toBeLessThan(
      s.candidates[0].maximumCostUsd!,
    );
  });
  test("cache expiry changes estimate, never permissions", () => {
    const cached = {
      ...route,
      cache: { tokens: 1000, expiresAt: 100, basis: "simulation" as const },
      pricing: { ...route.pricing!, cachedInputPerMillion: 0 },
    };
    expect(
      selectRoute(task, [cached], defaultPolicy, { now: 101 }).candidates[0]
        .estimatedCostUsd!,
    ).toBeGreaterThan(
      selectRoute(task, [cached], defaultPolicy, { now: 99 }).candidates[0]
        .estimatedCostUsd!,
    );
  });
  test("weights cannot override spending limits", () =>
    expect(
      selectRoute(task, [route], {
        ...defaultPolicy,
        maxCostUsd: 0,
        weights: { quality: 100, cost: 0, latency: 0 },
      }).routeId,
    ).toBeNull());
});
describe("execution records", () => {
  test("records actual destination and null for unknown charges", async () => {
    const result = await routeTask(
      task,
      { routes: [route], policy: defaultPolicy },
      { execute: async () => ({ ...(await ok()), costUsd: null }) },
    );
    expect(result.status).toBe("ok");
    expect(result.outcome.actualModel).toBe(route.model);
    expect(result.outcome.totalCostUsd).toBeNull();
  });
  test("availability fallback stays eligible and explicit", async () => {
    const result = await routeTask(
      task,
      {
        routes: [route, { ...route, id: "second" }],
        policy: {
          ...defaultPolicy,
          maxAttempts: 2,
          allowAvailabilityFallback: true,
        },
      },
      {
        execute: async (r) =>
          r.id === "cheap"
            ? {
                status: "unavailable",
                actualModel: "fixture",
                usage: null,
                costUsd: null,
                error: "offline",
              }
            : ok(),
      },
    );
    expect(result.status).toBe("ok");
    expect(result.attempts[1].trigger).toBe("availability-fallback");
  });
  test("unknown first charge reserves full maximum before retry", async () => {
    const bound = selectRoute(task, [route], defaultPolicy).candidates[0]
      .maximumCostUsd!;
    let calls = 0;
    const result = await routeTask(
      task,
      {
        routes: [route, { ...route, id: "second" }],
        policy: {
          ...defaultPolicy,
          maxCostUsd: bound * 1.5,
          maxAttempts: 2,
          allowAvailabilityFallback: true,
        },
      },
      {
        execute: async () => {
          calls++;
          return {
            status: "unavailable",
            actualModel: "fixture",
            usage: null,
            costUsd: null,
          };
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("unavailable");
  });
  test("malformed response is not treated as availability failure", async () => {
    const result = await routeTask(
      task,
      {
        routes: [route, { ...route, id: "second" }],
        policy: {
          ...defaultPolicy,
          maxAttempts: 2,
          allowAvailabilityFallback: true,
        },
      },
      {
        execute: async () => ({
          status: "malformed",
          actualModel: "fixture",
          usage: null,
          costUsd: null,
        }),
      },
    );
    expect(result.attempts).toHaveLength(1);
    expect(result.status).toBe("error");
  });
  test("cancelled result discards late answer", async () => {
    const abort = new AbortController();
    const result = await routeTask(
      task,
      { routes: [route], policy: defaultPolicy },
      {
        signal: abort.signal,
        execute: async () => {
          abort.abort();
          return ok();
        },
      },
    );
    expect(result.status).toBe("cancelled");
    expect(result.outcome.artifact).toBeUndefined();
  });
  test("quality escalation requires measured stronger route", async () => {
    const strong = {
      ...route,
      id: "strong",
      quality: { ...route.quality, value: 0.9 },
    };
    const result = await routeTask(
      task,
      {
        routes: [route, strong],
        policy: {
          ...defaultPolicy,
          weights: { quality: 0, cost: 1, latency: 0 },
          allowQualityEscalation: true,
          maxAttempts: 2,
        },
      },
      {
        execute: ok,
        verify: async () => ({
          adequate: false,
          evidence: "independent fixture verifier",
          latencyMs: 0,
          costUsd: 0,
        }),
      },
    );
    expect(result.attempts[1].trigger).toBe("quality-escalation");
    expect(result.status).toBe("error");
  });
});
test("prior declares identity and exact uniform distribution", async () => {
  const output = await decide({
    schemaVersion: "2",
    requestId: "one",
    state: "ignored",
    questions: [{ id: "q", kind: "boolean", prompt: "Yes?" }],
  });
  expect(output.execution.model).toBe("uniform-v1");
  expect(output.decisions[0].distribution.map((p) => p.probability)).toEqual([
    0.5, 0.5,
  ]);
});
test("email baseline rejects unsupported MIME and leaves input unchanged", () => {
  const eml = "Subject: receipt\nContent-Type: text/plain\n\nPayment received";
  expect(classifyEml(eml).status).toBe("ok");
  const parsed = classifyEml(eml);
  if (parsed.status === "ok") expect(parsed.calibrated).toBe(false);
  expect(classifyEml(eml.replace("text/plain", "text/html")).status).toBe(
    "unsupported",
  );
  expect(classifyEml("bad").status).toBe("unsupported");
});
test("invalid route limits cannot qualify through NaN comparisons", () => {
  for (const contextTokens of [NaN, Infinity, undefined, -1])
    expect(
      selectRoute(
        task,
        [{ ...route, contextTokens: contextTokens as number }],
        defaultPolicy,
      ).routeId,
    ).toBeNull();
});
test("simulated quality cannot satisfy a hard minimum", () =>
  expect(
    selectRoute(
      task,
      [{ ...route, quality: { ...route.quality, basis: "simulation" } }],
      { ...defaultPolicy, minimumQuality: 0.1 },
    ).routeId,
  ).toBeNull());
test("local-only blocks a hosted classifier before sending input", async () => {
  let calls = 0;
  const result = await routeTask(
    task,
    { routes: [route], policy: { ...defaultPolicy, localOnly: true } },
    {
      classifierIdentity: {
        source: "hosted",
        model: "remote-fixture",
        local: false,
      },
      classifier: async () => {
        calls++;
        throw Error("must not execute");
      },
    },
  );
  expect(calls).toBe(0);
  expect(result.status).toBe("unavailable");
  expect(result.classification.source).toBe("hosted");
});
test("an already cancelled task never calls its classifier", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await routeTask(
    task,
    { routes: [route], policy: defaultPolicy },
    {
      signal: abort.signal,
      classifier: async () => {
        calls++;
        throw Error();
      },
    },
  );
  expect(calls).toBe(0);
});
test("classification changes soft ranking under the same policy without changing eligibility", () => {
  const a = {
      ...route,
      id: "a",
      taskQuality: {
        "bug-fix": {
          easy: 0.9,
          hard: 0.2,
          basis: "simulation" as const,
          evidence: "fixture",
        },
      },
    },
    b = {
      ...route,
      id: "b",
      taskQuality: {
        "bug-fix": {
          easy: 0.7,
          hard: 0.8,
          basis: "simulation" as const,
          evidence: "fixture",
        },
      },
    };
  const base = {
    source: "host" as const,
    category: "bug-fix" as const,
    difficulty: 0,
    confidence: 1,
    latencyMs: 0,
    costUsd: 0,
    evidence: "fixture",
  };
  const policy = {
    ...defaultPolicy,
    weights: { quality: 1, cost: 0, latency: 0 },
  };
  const easy = selectRoute(task, [a, b], policy, { classification: base }),
    hard = selectRoute(task, [a, b], policy, {
      classification: { ...base, difficulty: 1 },
    });
  expect(easy.routeId).toBe("a");
  expect(hard.routeId).toBe("b");
  expect(easy.candidates.map((c) => c.eligible)).toEqual(
    hard.candidates.map((c) => c.eligible),
  );
});

test("invalid SDK spending policy is rejected before a paid classifier can run", async () => {
  let calls = 0;
  const result = await routeTask(
    task,
    { routes: [route], policy: { ...defaultPolicy, maxCostUsd: Number.NaN } },
    {
      classifierMaxCostUsd: 0.01,
      classifier: async () => {
        calls++;
        throw Error("Must not execute");
      },
    },
  );
  expect(calls).toBe(0);
  expect(result.status).toBe("unsupported");
  expect(result.attempts).toEqual([]);
});

test("remaining reservation can tighten but never widen a configured spending cap", () => {
  const capped = { ...defaultPolicy, maxCostUsd: 0 };
  expect(
    selectRoute(task, [route], capped, { remainingBudget: 1 }).status,
  ).toBe("unavailable");
  expect(
    selectRoute(
      task,
      [route],
      { ...defaultPolicy, maxCostUsd: 1 },
      { remainingBudget: 0 },
    ).status,
  ).toBe("unavailable");
  for (const remainingBudget of [NaN, -1, Infinity, null, "1"]) {
    const result = selectRoute(task, [route], defaultPolicy, {
      remainingBudget,
    } as any);
    expect(result.status).toBe("unsupported");
    expect(result.explanation).toContain("remainingBudget");
  }
});

test("malformed registry entries stay ineligible without crashing valid candidate selection", async () => {
  const result = selectRoute(task, [null, route] as any, defaultPolicy);
  expect(result.status).toBe("selected");
  expect(result.routeId).toBe(route.id);
  expect(result.candidates[0].eligible).toBe(false);
  expect(result.candidates[0].reasons).toContain(
    "Destination must be an object.",
  );
  const execution = await routeTask(
    task,
    { routes: [null, route] as any, policy: defaultPolicy },
    { execute: ok },
  );
  expect(execution.status).toBe("ok");
  expect(execution.outcome.actualRouteId).toBe(route.id);
});

test("contradictory OpenCode model configuration is ineligible before any executor call", async () => {
  let calls = 0;
  const contradictory: Route = {
    ...route,
    local: false,
    contextTokens: 100000,
    destination: { kind: "opencode", model: "different" },
  };
  const result = await routeTask(
    task,
    { routes: [contradictory], policy: defaultPolicy },
    {
      execute: async () => {
        calls++;
        return ok();
      },
    },
  );
  expect(calls).toBe(0);
  expect(result.status).toBe("unavailable");
  expect(result.selection.candidates[0].reasons.join(" ")).toContain(
    "must match",
  );
});

test("direct OpenCode execution rejects a model conflict without resolving an executable", async () => {
  const contradictory: Route = {
    ...route,
    local: false,
    contextTokens: 100000,
    destination: { kind: "opencode", model: "different" },
  };
  const source = `import { executeDestination } from ${JSON.stringify(new URL("./execute.ts", import.meta.url).href)};
    const result = await executeDestination(${JSON.stringify(contradictory)}, ${JSON.stringify(task)}, {outputTokens: 50});
    console.log(JSON.stringify(result));`;
  // If the guard regresses, this process cannot find OpenCode or make a provider call.
  const proc = Bun.spawn([process.execPath, "--eval", source], {
    env: { ...process.env, PATH: "/jev-empty-executable-path" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const output = JSON.parse(text);
  expect(output.status).toBe("error");
  expect(output.identityBasis).toBe("configured-unverified");
  expect(output.costUsd).toBeNull();
  expect(output.error).toContain("no process was started");
});

test("minimumQuality remains an aggregate measured floor despite a higher task-calibrated score", () => {
  const configured: Route = {
    ...route,
    quality: { ...route.quality, value: 0.4 },
    taskQuality: {
      "bug-fix": {
        easy: 0.95,
        hard: 0.95,
        basis: "measured",
        evidence: "task fixture",
      },
    },
  };
  const classification = {
    source: "host" as const,
    category: "bug-fix" as const,
    difficulty: 0.5,
    confidence: 1,
    latencyMs: 0,
    costUsd: 0,
    evidence: "fixture",
  };
  const result = selectRoute(
    task,
    [configured],
    { ...defaultPolicy, minimumQuality: 0.8 },
    { classification },
  );
  expect(result.status).toBe("unavailable");
  expect(result.candidates[0].quality.value).toBe(0.95);
  expect(result.candidates[0].reasons.join(" ")).toContain("minimum");
});

test("quality escalation requires improvement in both aggregate and calibrated measured quality", async () => {
  for (const [aggregate, calibrated, expectedCalls] of [
    [0.9, 0.2, 1],
    [0.7, 0.95, 1],
    [0.9, 0.95, 2],
  ]) {
    let calls = 0;
    const initial: Route = {
      ...route,
      quality: { ...route.quality, value: 0.8 },
      taskQuality: {
        "bug-fix": {
          easy: 0.7,
          hard: 0.7,
          basis: "measured",
          evidence: "fixture",
        },
      },
    };
    const candidate: Route = {
      ...initial,
      id: "strong",
      quality: { ...route.quality, value: aggregate },
      taskQuality: {
        "bug-fix": {
          easy: calibrated,
          hard: calibrated,
          basis: "measured",
          evidence: "fixture",
        },
      },
    };
    const result = await routeTask(
      task,
      {
        routes: [initial, candidate],
        policy: {
          ...defaultPolicy,
          weights: { quality: 0, cost: 1, latency: 0 },
          allowQualityEscalation: true,
          maxAttempts: 2,
        },
      },
      {
        execute: async () => {
          calls++;
          return ok();
        },
        verify: async () => ({
          adequate: calls === 2,
          evidence: "fixture verifier",
          latencyMs: 0,
          costUsd: 0,
        }),
      },
    );
    expect(calls).toBe(expectedCalls);
    expect(result.status).toBe(expectedCalls === 2 ? "ok" : "error");
    if (expectedCalls === 2)
      expect(result.attempts[1].trigger).toBe("quality-escalation");
    else expect(result.outcome.artifact).toBeUndefined();
  }
});
