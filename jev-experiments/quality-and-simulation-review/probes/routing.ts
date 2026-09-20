import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readRecord } from "../../experience-prototypes/scripts/records";
import { agentHarness, app, readApp } from "./routing.harness";

const doc = readRecord(new URL("results/routing.jsonl", app));
const result = doc.result;
const original = readRecord(new URL("../results/routing.jsonl", app));
const wirePath = new URL(`../runs/${doc.manifest.id}/requests.jsonl`, app);
const logs = readFileSync(wirePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
const requests = logs.filter(r => r.request);
const uniqueRequests = [...new Map(requests.map(r => [r.tag, r])).values()];
const wire = uniqueRequests[0].request;
const labels = Object.keys(wire.questions.route.criteria);
const diagnosticRules: Array<[string, RegExp]> = [
  ["calculator", /\btimes\b|\bconvert\b/i], ["navigation", /\bclick\b|\bopen\b|\bselect\b/i],
  ["beverage", /\blatte\b|\bespresso\b|\bcaffeine\b/i], ["local_writer", /\bwrite\b|\bsummarize\b|\bdraft\b/i],
  ["search", /\bfind\b|\blocate\b|\bsearch\b/i], ["reasoning_model", /\bprove\b|\btradeoffs\b|\bdesign an experiment\b/i],
  ["jev", /\bclassify\b|\brelevant\b|\bcalming\b/i],
];
const ruleRows = result.rows.map((row: any) => ({ id: row.id, target: row.target, predicted: diagnosticRules.find(([, re]) => re.test(row.text))?.[0] ?? "unknown" }));
const h = agentHarness("routing", result);
const initial = { input: h.find("textarea").props.value, row: h.inspector(), selectedIndex: h.find("select").props.value };
const pending = h.find("RunButton").props.onClick();
h.find("select").props.onChange({ target: { value: "3" } }); h.render();
const beforeOldResponse = { input: h.find("textarea").props.value, row: h.inspector(), selectedIndex: h.find("select").props.value };
h.requests[0].resolve({ answers: { route: { type: "choice", value: "calculator", probabilities: { calculator: 1 }, confidence: 1 } }, source: "synthetic-delayed-success" });
await pending; h.render();
const afterOldResponse = { input: h.find("textarea").props.value, row: h.inspector(), selectedIndex: h.find("select").props.value };
if (afterOldResponse.row.prediction !== "calculator" || afterOldResponse.selectedIndex !== 3) throw Error("Stale-selection reproduction changed");
const blank = agentHarness("routing", result);
blank.find("textarea").props.onChange({ target: { value: "" } }); blank.render();
const blankRun = blank.find("RunButton").props.onClick();
blank.requests[0].resolve({ answers: { route: { value: "jev", probabilities: null } } }); await blankRun;
const selectedProbabilities = result.rows.map((r: any) => r.probabilities[r.prediction]);
const output = {
  method: "Decoded original and published records, inspected exact local recorded request bodies, executed actual routing callbacks with mocked React and a deferred response; no browser/model calls. Rule baseline was written after fixture inspection and is diagnostic only.",
  hashes: { component: createHash("sha256").update(readApp("src/agent-experiments.tsx")).digest("hex"), published: createHash("sha256").update(readApp("results/routing.jsonl")).digest("hex"), requests: createHash("sha256").update(readFileSync(wirePath)).digest("hex") },
  evidence: { rows: result.rows.length, uniqueTexts: new Set(result.rows.map((r: any) => r.text)).size, correct: result.rows.filter((r: any) => r.prediction === r.target).length, classCounts: Object.fromEntries(labels.map(label => [label, result.rows.filter((r: any) => r.target === label).length])), originalCompleted: original.result.rows.filter((r: any) => !r.error).length, recovered: result.rows.filter((r: any) => r.recovery).length, originalTransport: result.transport, recoveryAttempts: result.recovery.attempts, uniqueRecordedRequestBodies: uniqueRequests.length, probabilityExactlyOne: selectedProbabilities.filter((p: number) => p === 1).length, probabilitiesNotConfidence: result.rows.filter((r: any) => r.confidence !== r.probabilities[r.prediction]).length },
  fixtureDiagnostic: { matches: ruleRows.filter((r: any) => r.target === r.predicted).length, rules: diagnosticRules.map(([route, pattern]) => ({ route, pattern: pattern.source })), rows: ruleRows, caveat: "Post-inspection lexical rules do not measure held-out generalization." },
  protocol: { recorded: wire, live: h.requests[0], liveCriteriaDiffer: JSON.stringify(wire.questions.route.criteria) !== JSON.stringify(h.routes), targetSent: uniqueRequests.some(r => typeof r.request.state !== "string" || /"target"\s*:/.test(JSON.stringify(r.request.state))), handlerCostOrAvailabilitySupplied: false, abstentionOption: Object.keys(h.routes).some(k => /ask|none|uncertain|clarify/.test(k)), actualRequestsDuringOneRoutingEvaluation: h.requests.length },
  staleSelection: { initial, beforeOldResponse, afterOldResponse, note: "The request card continues to show the old result's own text, but the active dropdown/input remain on another case. This is a replacement of the selected result, not falsification of its stored input." },
  emptyInput: { submittedState: blank.requests[0].state, choiceCount: Object.keys(blank.requests[0].questions.route.criteria).length, note: "Synthetic response; no provider behavior inferred." },
};
// Functions on deferred request objects are intentionally omitted by JSON serialization.
writeFileSync(new URL("routing.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ rows: output.evidence.rows, correct: output.evidence.correct, ruleMatches: output.fixtureDiagnostic.matches, originalCompleted: output.evidence.originalCompleted, recovered: output.evidence.recovered, selectedIndexAfterOldResponse: afterOldResponse.selectedIndex, visiblePredictionAfterOldResponse: afterOldResponse.row.prediction }));
