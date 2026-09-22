#!/usr/bin/env bun
/** Authored stand-in for the local executable; no model or GPU is loaded. */
import { appendFileSync } from "node:fs";
const request = JSON.parse(await Bun.stdin.text());
const record = (event: unknown) => appendFileSync(process.env.JEV_FIXTURE_EVENTS!, JSON.stringify(event) + "\n");
record({kind: "local-classifier", operation: process.argv[2], model: process.argv[4], inputFromStdin: process.argv.at(-1) === "-", request});
const scenario = process.env.JEV_FIXTURE_SCENARIO;
if (scenario === "delayed") await Bun.sleep(150);
const model = JSON.parse(process.env.JEV_FIXTURE_MODEL!);
const status = scenario === "unsupported" ? "unsupported" : scenario === "local-error" ? "error" : "ok";
const category = scenario === "tests" ? "test-writing" : "bug-fix";
const hard = scenario !== "easy";
const response = {
  schemaVersion: "2", requestId: request.requestId, status,
  execution: {adapter: "jev-local-mlx", ...model, local: true},
  timing: {totalMs: 0}, costUsd: null,
  decisions: status === "ok" ? request.questions.map((q: any) => q.kind === "choice" ? {
    questionId: q.id, selected: category,
    distribution: q.options.map((o: any) => ({value: o.id, probability: Number(o.id === category)})),
  } : {
    questionId: q.id, selected: hard ? 1 : 0, expected: hard ? .8 : .2,
    distribution: [0, .25, .5, .75, 1].map(value => ({value, probability: value === 0 ? (hard ? .2 : .8) : value === 1 ? (hard ? .8 : .2) : 0})),
  }) : [],
  issues: status === "ok" ? [] : [{code: status === "unsupported" ? "token_limit" : "authored_error",
    message: status === "unsupported" ? "Authored input uses 769 tokens; this runtime accepts at most 768." : "Authored local refusal; no inference performed.",
    ...(status === "unsupported" ? {questionIds: ["category"]} : {}),
  }],
};
console.log(JSON.stringify(response));
if (status !== "ok") process.exitCode = 2;
