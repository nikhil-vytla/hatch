import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readRecord } from "../../experience-prototypes/scripts/records";
import { agentHarness, app, readApp } from "./routing.harness";

const doc = readRecord(new URL("../results/verify.jsonl", app));
const rows = doc.result.rows;
const logPath = new URL(`../runs/${doc.manifest.id}/requests.jsonl`, app);
const logs = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
const successful = logs.filter(r => r.http_status === 200 && r.response?.answers);
const groups = [...Map.groupBy(rows, (r: any) => JSON.stringify(r.state)).values()].map((group: any) => ({
  ids: group.map((r: any) => r.id), state: group[0].state, target: group[0].target,
  predictions: group.map((r: any) => r.prediction), uniquePredictions: new Set(group.map((r: any) => r.prediction)).size,
  selectedProbabilities: group.map((r: any) => r.probabilities[r.prediction]),
  probabilityRange: Math.max(...group.map((r: any) => r.probabilities[r.prediction])) - Math.min(...group.map((r: any) => r.probabilities[r.prediction])),
  confidenceValues: group.map((r: any) => r.confidence),
  evidenceScores: group.map((r: any) => successful.find(w => w.tag === `verifier/${r.id}`)?.response.answers.evidence.noul),
}));
const h = agentHarness("verify", doc.result);
const pending = h.find("RunButton").props.onClick();
h.find("select").props.onChange({ target: { value: "4" } }); h.render();
const before = { input: h.find("textarea").props.value, row: h.inspector(), index: h.find("select").props.value };
h.requests[0].resolve({ answers: { verdict: { value: "verified", probabilities: { verified: 1 } } }, source: "synthetic-delayed-success" });
await pending; h.render();
const after = { input: h.find("textarea").props.value, row: h.inspector(), index: h.find("select").props.value };
if (after.index !== 4 || after.row.prediction !== "verified") throw Error("Expected stale verified result");
const malformedText = '{"task":"Review without edits","trace":"Edited a file"';
const malformed = agentHarness("verify", doc.result);
malformed.find("textarea").props.onChange({ target: { value: malformedText } }); malformed.render();
const malformedRun = malformed.find("RunButton").props.onClick();
malformed.requests[0].resolve({ answers: { verdict: { value: "needs_check", probabilities: null } } }); await malformedRun;
const array = agentHarness("verify", doc.result);
array.find("textarea").props.onChange({ target: { value: "[]" } }); array.render();
const arrayRun = array.find("RunButton").props.onClick();
array.requests[0].resolve({ answers: { verdict: { value: "needs_check", probabilities: null } } }); await arrayRun;
const recorded = successful[0].request;
const output = {
  method: "Complete published record and exact local wire-response inspection; actual verifier callback execution via the original offline harness. Synthetic delayed/malformed responses make no claim about new model judgments. No browser or API calls.",
  hashes: { component: createHash("sha256").update(readApp("src/agent-experiments.tsx")).digest("hex"), record: createHash("sha256").update(readFileSync(new URL("../results/verify.jsonl", app))).digest("hex"), wire: createHash("sha256").update(readFileSync(logPath)).digest("hex") },
  coverage: { recordedRows: rows.length, correct: rows.filter((r: any) => r.target === r.prediction).length, independentInputs: groups.length, repetitionsPerInput: groups.map(g => g.ids.length), groupsWithIdentityChange: groups.filter(g => g.uniquePredictions > 1).length, groupsWithScoreDrift: groups.filter(g => g.probabilityRange > 0).length, classCounts: Object.fromEntries([...new Set(rows.map((r: any) => r.target))].map(label => [label, rows.filter((r: any) => r.target === label).length])), groups, transport: doc.result.transport },
  discardedJudgments: { wireSuccesses: successful.length, primitiveAnswers: successful.reduce((n: number, r: any) => n + Object.keys(r.response.answers).length, 0), evidenceScoresInWire: successful.filter(r => r.response.answers.evidence).length, publishedRowsWithEvidenceScore: rows.filter((r: any) => r.evidence != null || r.answers?.evidence != null).length },
  protocol: { recordedQuestions: recorded.questions, liveQuestions: h.requests[0].questions, labelsInModelState: successful.some(r => Object.hasOwn(r.request.state, "target")), currentNote: doc.result.note, publishedIndependentTemplates: doc.result.independent_templates, componentReferencesTemplateCount: /independent_templates/.test(readApp("src/agent-experiments.tsx")) },
  staleSelection: { before, after, caveat: "The output retains its old task/trace; the active selector and editor refer to another example." },
  inputHandling: { malformedInput: malformedText, submittedMalformedState: malformed.requests[0].state, submittedArrayState: array.requests[0].state, note: "Malformed JSON silently becomes trace text with an invented default completion claim; valid arrays bypass task/trace/claim shape validation. No provider outcome tested." },
};
if (groups.length !== 5 || output.discardedJudgments.evidenceScoresInWire !== 20 || output.discardedJudgments.publishedRowsWithEvidenceScore !== 0) throw Error("Recorded coverage changed");
writeFileSync(new URL("verify.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ rows: rows.length, uniqueStates: groups.length, identityChanges: output.coverage.groupsWithIdentityChange, scoreDriftGroups: output.coverage.groupsWithScoreDrift, evidenceScoresDiscarded: 20, staleIndex: after.index, staleVerdict: after.row.prediction }));
