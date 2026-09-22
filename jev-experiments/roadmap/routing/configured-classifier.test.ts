import { expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifierConfigIssues } from "./configured-classifier";
import { defaultPolicy } from "./policy";
import models from "../mac/models.json";
import type { Route, RouterConfig, Task } from "./types";

const evidencePath = process.env.JEV_CLASSIFIER_CHECK_REPORT;
if (evidencePath) writeFileSync(evidencePath, "", {flag: "wx"});
const retain = (row: unknown) => {
  if (evidencePath) appendFileSync(evidencePath, JSON.stringify(row) + "\n");
};

const task: Task = {id: "authored-task", prompt: "Fix the function using the supplied source.", context: "function present() { return false; }", outputTokens: 128};
const route = (id: "a" | "b"): Route => ({
  id, model: `authored-${id}`, available: true, local: false, capabilities: ["text"], tools: [], contextTokens: 200_000, maxOutputTokens: 1024,
  quality: {value: .5, basis: "measured", evidence: "Authored fixture value; not a model measurement."},
  taskQuality: {
    "bug-fix": {easy: id === "a" ? .9 : .1, hard: id === "a" ? .1 : .9, basis: "measured", evidence: "Authored test input."},
    "test-writing": {easy: id === "a" ? .1 : .9, hard: id === "a" ? .1 : .9, basis: "measured", evidence: "Authored test input."},
  },
  latencyMs: {value: 1, basis: "measured", evidence: "Authored test input; no timing claim."},
  pricing: {inputPerMillion: 1, outputPerMillion: 1, basis: "configured", evidence: "Authored fixture arithmetic."},
  destination: {kind: "openai-compatible", endpoint: "https://delegates.fixture.invalid/chat"},
});

async function fixture(kind: "heuristic" | "hosted-jev" | "local", scenario = "hard") {
  const directory = await mkdtemp(join(tmpdir(), "jev-classifier-tools-"));
  const executable = join(directory, "local-fixture");
  await copyFile(join(import.meta.dir, "classifier-fixtures/local-runtime.ts"), executable);
  await chmod(executable, 0o755);
  const config: RouterConfig = {
    routes: [route("a"), route("b")], policy: {...defaultPolicy, weights: {quality: 1, cost: 0, latency: 0}},
    ...(kind === "heuristic" ? {} : {classifier: kind === "hosted-jev" ? {kind, apiKeyEnv: "AUTHORED_CLASSIFIER_KEY"} : {kind}}),
    ...(kind === "local" ? {localRuntime: {executable, model: "laya-base-experimental", dataDirectory: directory}} : {}),
  };
  const path = join(directory, "config.json"), eventsPath = join(directory, "events.jsonl");
  await writeFile(path, JSON.stringify(config));
  const spec = models.models["laya-base-experimental"];
  const env: Record<string, string> = {
    PATH: process.env.PATH!, JEV_ROUTER_CONFIG: path, AUTHORED_CLASSIFIER_KEY: "inert-authored-value",
    JEV_FIXTURE_EVENTS: eventsPath, JEV_FIXTURE_SCENARIO: scenario,
    JEV_FIXTURE_MODEL: JSON.stringify({model: spec.model, revision: spec.revision}),
  };
  const command = (file: string, ...args: string[]) => [process.execPath, "--preload", join(import.meta.dir, "classifier-fixtures/transport.ts"), join(import.meta.dir, file), ...args];
  const events = () => existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const waitFor = async (kind: string) => {
    const until = Date.now() + 5000;
    while (!events().some(e => e.kind === kind)) {
      if (Date.now() > until) throw Error(`Fixture did not observe ${kind}`);
      await Bun.sleep(5);
    }
  };
  const cli = async (input = task, cancel = false, operation = "route_task") => {
    const firstEvent = events().length;
    const child = Bun.spawn(command("cli.ts", operation), {cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
    child.stdin.write(JSON.stringify(input)); child.stdin.end();
    if (cancel) { await waitFor(kind === "local" ? "local-classifier" : "native-classifier"); child.kill("SIGINT"); }
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    const value = JSON.parse(stdout);
    retain({transport: "cli", kind, scenario, operation, cancel, input: operation === "route_task" ? input : undefined, response: value, exitCode: code, events: events().slice(firstEvent)});
    return {value, code};
  };
  const close = () => rm(directory, {recursive: true, force: true});
  return {directory, config, path, env, command, events, waitFor, cli, close, kind, scenario};
}

test("classifier configuration rejects ignored or incomplete opt-ins", () => {
  const base = {routes: [], policy: defaultPolicy};
  for (const classifier of [null, [], {kind: "unknown"}, {kind: "local"}, {kind: "hosted-jev"}, {kind: "hosted-jev", apiKeyEnv: "literal key"}, {kind: "heuristic", unexpected: true}])
    expect(classifierConfigIssues({...base, classifier} as any).length).toBeGreaterThan(0);
  expect(classifierConfigIssues(base)).toEqual([]);
  expect(classifierConfigIssues({...base, classifier: {kind: "hosted-jev", apiKeyEnv: "JEV_KEY"}})).toEqual([]);
});

test("actual CLI default remains heuristic and doctor discloses it", async () => {
  const f = await fixture("heuristic");
  try {
    const result = await f.cli();
    expect(result.code).toBe(0); expect(result.value.classification.source).toBe("heuristic");
    expect(result.value.outcome.actualRouteId).toBe("a");
    expect(f.events().map(e => e.kind)).toEqual(["destination"]);
    expect((await f.cli(task, false, "doctor")).value.taskClassifier.kind).toBe("heuristic");
  } finally { await f.close(); }
});

test("actual hosted CLI classifier changes the route using v2 expected difficulty", async () => {
  for (const [scenario, selected, difficulty] of [["easy", "a", .2], ["hard", "b", .8], ["tests", "b", .8]] as const) {
    const f = await fixture("hosted-jev", scenario);
    try {
      const {value, code} = await f.cli();
      expect(code).toBe(0); expect(value.classification.source).toBe("hosted");
      expect(value.classification.difficulty).toBeCloseTo(difficulty);
      expect(value.outcome.actualRouteId).toBe(selected);
      expect(value.classification.execution.model).toBe("authored-native-classifier");
      expect(value.classification.execution.modelSource).toBe("provider-reported");
      expect(value.classification.accounting.attempts).toHaveLength(1);
      expect(value.classification.costUsd).toBe(.002);
      expect(value.outcome.totalCostUsd).toBeCloseTo(.00203);
      const events = f.events();
      expect(events.map(e => e.kind)).toEqual(["native-classifier", "destination"]);
      expect(events[0].request.state).toEqual({prompt: task.prompt, context: task.context});
      expect(Object.keys(events[0].request.questions)).toEqual(["category", "difficulty"]);
      expect(events[1].model).toBe(`authored-${selected}`);
    } finally { await f.close(); }
  }
});

test("actual local CLI invokes the configured executable and keeps unknown cost", async () => {
  for (const [scenario, selected] of [["easy", "a"], ["hard", "b"]] as const) {
    const f = await fixture("local", scenario);
    try {
      const {value, code} = await f.cli();
      expect(code).toBe(0); expect(value.classification.source).toBe("local");
      expect(value.outcome.actualRouteId).toBe(selected); expect(value.outcome.totalCostUsd).toBeNull();
      const events = f.events();
      expect(events.map(e => e.kind)).toEqual(["local-classifier", "destination"]);
      expect(events[0].request.schemaVersion).toBe("2");
      expect(events[0].request.state).toEqual({prompt: task.prompt, context: task.context});
      expect(value.classification.execution.model).toBe(models.models["laya-base-experimental"].model);
      expect(value.classification.execution.adapter).toBe("jev-local-mlx");
      expect(value.classification.execution.revision).toBe(models.models["laya-base-experimental"].revision);
      expect(value.classification.declaredExecution).toEqual(value.classification.execution);
    } finally { await f.close(); }
  }
});

test("actual CLI retains failed and unknown classifier accounting without fallback", async () => {
  for (const scenario of ["http-error", "malformed", "unknown-cost"]) {
    const f = await fixture("hosted-jev", scenario);
    try {
      const {value, code} = await f.cli();
      if (scenario === "unknown-cost") {
        expect(code).toBe(0); expect(value.classification.costUsd).toBeNull(); expect(value.outcome.totalCostUsd).toBeNull();
      } else {
        expect(code).toBe(2); expect(value.status).toBe("error"); expect(value.attempts).toEqual([]);
        expect(value.classification.costUsd).toBe(.002); expect(value.outcome.totalCostUsd).toBe(.002);
        expect(f.events().map(e => e.kind)).toEqual(["native-classifier"]);
      }
      expect(value.classification.accounting.attempts).toHaveLength(1);
    } finally { await f.close(); }
  }
});

test("actual CLI rejects unsupported local classification and missing hosted credentials", async () => {
  for (const scenario of ["unsupported", "local-error"]) {
    const f = await fixture("local", scenario);
    try {
      const {value, code} = await f.cli();
      expect(code).toBe(2); expect(value.status).toBe("error"); expect(value.attempts).toEqual([]);
      expect(value.classification.evidence).toContain(scenario === "unsupported" ? "token_limit" : "authored_error");
      expect(value.classification.decisionStatus).toBe(scenario === "unsupported" ? "unsupported" : "error");
      if (scenario === "unsupported") expect(value.classification.issues).toEqual([{code: "token_limit", message: "Authored input uses 769 tokens; this runtime accepts at most 768.", questionIds: ["category"]}]);
      expect(value.outcome.totalCostUsd).toBeNull();
      expect(f.events().map(e => e.kind)).toEqual(["local-classifier"]);
    } finally { await f.close(); }
  }
  const f = await fixture("hosted-jev");
  try {
    delete f.env.AUTHORED_CLASSIFIER_KEY;
    const {value, code} = await f.cli();
    expect(code).toBe(2); expect(value.classification.evidence).toContain("credentials");
    expect(value.attempts).toEqual([]); expect(f.events()).toEqual([]);
  } finally { await f.close(); }
});

test("configured classification cannot bypass locality or hard spending limits", async () => {
  for (const policy of [{...defaultPolicy, localOnly: true}, {...defaultPolicy, maxCostUsd: .1}]) {
    const f = await fixture("hosted-jev");
    try {
      await writeFile(f.path, JSON.stringify({...f.config, policy}));
      const {value, code} = await f.cli();
      expect(code).toBe(2); expect(value.status).toBe("unavailable");
      expect(value.attempts).toEqual([]); expect(f.events()).toEqual([]);
    } finally { await f.close(); }
  }
});

test("actual CLI cancels a pending classifier and never executes a destination", async () => {
  for (const kind of ["hosted-jev", "local"] as const) {
    const f = await fixture(kind, "delayed");
    try {
      const {value, code} = await f.cli(task, true);
      expect(code).toBe(2); expect(value.status).toBe("cancelled");
      expect(value.attempts).toEqual([]); expect(value.outcome.artifact).toBeUndefined();
      expect(f.events().some(e => e.kind === "destination" || e.kind === "unexpected-network")).toBe(false);
    } finally { await f.close(); }
  }
});

async function mcp(f: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn(f.command("mcp.ts"), {cwd: f.directory, env: f.env, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  const pending = new Map<number, (message: any) => void>(); let next = 1;
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
  const pump = (async () => {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      buffer += decoder.decode(value, {stream: true});
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    }
  })();
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const rpc = (method: string, params?: unknown) => {
    const id = next++;
    const response = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`MCP fixture timed out: ${method}`)), 5000);
      pending.set(id, value => {
        clearTimeout(timeout);
        retain({transport: "mcp", kind: f.kind, scenario: f.scenario, request: {jsonrpc: "2.0", id, method, params}, response: value, events: f.events()});
        resolve(value);
      });
    });
    send({jsonrpc: "2.0", id, method, params}); return {id, response};
  };
  const initialize = await rpc("initialize", {protocolVersion: "2025-06-18", clientInfo: {name: "authored-classifier-fixture", version: "1"}}).response;
  expect(initialize.result.instructions).toContain(f.config.classifier?.kind === "local" ? "Explicit local model" : "Hosted Jev");
  const list = await rpc("tools/list").response;
  expect(list.result.tools.find((t: any) => t.name === "route_task").description).toContain("Classification defaults to a lexical heuristic");
  return {rpc, send, close: async () => {child.stdin.end(); await pump; expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");}};
}

test("real MCP exchanges route through both configured v2 classifier adapters", async () => {
  for (const [kind, scenario, selected] of [["hosted-jev", "easy", "a"], ["hosted-jev", "hard", "b"], ["local", "easy", "a"], ["local", "hard", "b"]] as const) {
    const f = await fixture(kind, scenario); const client = await mcp(f);
    try {
      const response = await client.rpc("tools/call", {name: "route_task", arguments: {task}}).response;
      const result = response.result.structuredContent;
      expect(response.result.isError).toBe(false);
      expect(JSON.parse(response.result.content[0].text)).toEqual(result);
      expect(result.outcome.actualRouteId).toBe(selected);
      expect(result.classification.source).toBe(kind === "local" ? "local" : "hosted");
      if (kind === "local") {
        expect(result.classification.execution.adapter).toBe("jev-local-mlx");
        expect(result.classification.execution.revision).toBe(models.models["laya-base-experimental"].revision);
      }
      expect(result.outcome.artifact.text).toBe(`authored artifact from authored-${selected}`);
      expect(f.events().filter(e => e.kind === "destination")).toHaveLength(1);
    } finally { await client.close(); await f.close(); }
  }
});

test("real MCP classifier refusals and cancellation preserve error flags and no artifact", async () => {
  for (const [kind, scenario] of [["local", "unsupported"], ["hosted-jev", "http-error"], ["hosted-jev", "malformed"], ["hosted-jev", "delayed"], ["local", "delayed"]] as const) {
    const f = await fixture(kind, scenario); const client = await mcp(f);
    try {
      const call = client.rpc("tools/call", {name: "route_task", arguments: {task}});
      if (scenario === "delayed") {
        await f.waitFor(kind === "local" ? "local-classifier" : "native-classifier");
        client.send({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId: call.id}});
      }
      const response = await call.response, result = response.result.structuredContent;
      expect(response.result.isError).toBe(true); expect(result.attempts).toEqual([]);
      expect(result.status).toBe(scenario === "delayed" ? "cancelled" : "error");
      if (scenario === "unsupported") {
        expect(result.classification.decisionStatus).toBe("unsupported");
        expect(result.classification.issues).toEqual([{code: "token_limit", message: "Authored input uses 769 tokens; this runtime accepts at most 768.", questionIds: ["category"]}]);
      }
      expect(result.outcome.artifact).toBeUndefined();
      expect(f.events().some(e => e.kind === "destination" || e.kind === "unexpected-network")).toBe(false);
    } finally { await client.close(); await f.close(); }
  }
});
