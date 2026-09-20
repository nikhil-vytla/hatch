// Offline audit of the actual Changes component. No browser or provider calls.
// Run: bun jev-experiments/quality-and-simulation-review/probes/changes.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const source = read("src/new-experiments.tsx");
const recordDocument = readRecord(new URL("results/changes.jsonl", app));
const record = recordDocument.result;
const componentSource = source.slice(source.indexOf("export const impactFacts"));
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__auditElement" } }) })
  .transformSync(componentSource).replace(/\bexport\s+/g, "");
const fixtures: any = {};
vm.runInNewContext(code + "\nthis.facts = impactFacts; this.conclusions = conclusions;", fixtures);
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

function harness(input = record) {
  const slots: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, dirty = false, tree: any, request: any, resolve: any;
  const context: any = {
    __auditElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; dirty ||= next !== slots[i]; slots[i] = next; }]; },
    useEffect: (fn: () => void, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old[j])) { slots[i] = deps; effects.push(fn); } },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    judge: (instructions: string) => ({ type: "noul", instructions }),
    run: (state: any, questions: any) => { request = { state, questions }; return new Promise(r => resolve = r); },
    motion: { div: "motion.div" },
    ...Object.fromEntries(["Pane", "Field", "RunButton", "ErrorText", "State", "ArrowRight", "Link2"].map(name => [name, name])),
  };
  vm.runInNewContext(code + "\nthis.component = Changes;", context);
  const nodes = (value: any): any[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
  const render = () => { for (let i = 0; i < 4; i++) { dirty = false; cursor = 0; tree = context.component({ record: input }); effects.splice(0).forEach(fn => fn()); if (!dirty) break; } return tree; };
  const all = () => nodes(tree), find = (type: string) => all().find(n => n.type === type);
  const labels = () => all().filter(n => n.type === "span" && n.props.className === "badge").map(n => n.props.children.join(""));
  render();
  return { render, all, find, labels, request: () => request, resolve: (r: any) => resolve(r), inspector: () => find("State").props.value };
}

const initial = harness();
const initialLabels = initial.labels();
const pending = initial.find("RunButton").props.onClick();
const originalRequest = initial.request();
initial.find("select").props.onChange({ target: { value: "date" } }); initial.render();
initial.find("input").props.onChange({ target: { value: "October 20, 2026" } }); initial.render();
const beforeResolution = { labels: initial.labels(), inspector: initial.inspector() };
initial.resolve(record); await pending; initial.render();

const dependencyVerdicts = (state: any) => Object.fromEntries(state.conclusions.map((c: any) => [c.id, c.depends.some((field: string) => state.before[field] !== state.after[field])]));
const payloadOnlyVerdicts = dependencyVerdicts(originalRequest.state);
const expectedForCurrentDraft = dependencyVerdicts(initial.inspector());
const observedAfterLateResponse = Object.fromEntries(fixtures.conclusions.map((c: any, i: number) => [c.id, initial.labels()[i] === "Needs another look"]));
const mismatches = fixtures.conclusions.filter((c: any) => observedAfterLateResponse[c.id] !== expectedForCurrentDraft[c.id]).map((c: any) => c.id);
assert(mismatches.length === 2 && mismatches.includes("travel") && mismatches.includes("reminder"), "Expected stale travel/reminder judgments");

const partial = harness({ ...record, answers: { travel: record.answers.travel } });
assert(partial.labels().filter((label: string) => label === "Still supported").length === 3, "Expected three synthetic missing answers displayed as supported");
const blank = harness();
blank.find("select").props.onChange({ target: { value: "capacity" } }); blank.render();
const blankRun = blank.find("RunButton").props.onClick();
blank.resolve(record); await blankRun;
const noOp = harness();
noOp.find("input").props.onChange({ target: { value: fixtures.facts.venue } }); noOp.render();
const noOpRun = noOp.find("RunButton").props.onClick();
noOp.resolve(record); await noOpRun;
assert(JSON.stringify(noOp.request().state.before) === JSON.stringify(noOp.request().state.after), "Expected actual no-op request");

const graphOnlyGrid = Object.keys(fixtures.facts).map(field => ({ field, affected: fixtures.conclusions.filter((c: any) => c.depends.includes(field)).map((c: any) => c.id) }));
const recorder = read("scripts/record.ts");
const savedQuestion = recorder.match(/`Does conclusion \$\{c\.id\} need review because the facts changed\?`/)?.[0];
assert(savedQuestion, "Expected original recording question");
const publishedMatches = fixtures.conclusions.filter((c: any) => (record.answers[c.id].value >= 0.5) === payloadOnlyVerdicts[c.id]).length;
assert(publishedMatches === 4, "Expected all four recorded judgments to match the supplied graph baseline");

const output = {
  method: "Decoded the complete published record and executed the actual Changes JSX callbacks through Bun transpilation with mocked React hooks and a deferred run promise. No browser, API calls or app edits. Synthetic partial records test UI behavior, not provider behavior.",
  sourceHashes: Object.fromEntries(["src/new-experiments.tsx", "scripts/record.ts", "results/changes.jsonl", "publication.json"].map(path => [path, createHash("sha256").update(read(path)).digest("hex")])),
  coverage: { scenarios: 1, sourceFacts: Object.keys(fixtures.facts).length, conclusions: fixtures.conclusions.length, dependencyEdges: fixtures.conclusions.reduce((n: number, c: any) => n + c.depends.length, 0), judgments: Object.keys(record.answers).length, recordedChangedFields: ["venue"], unrecordedFields: ["date", "capacity"], initialLabels, latencyMs: record.latency_ms, attempts: record.attempts, recordManifest: recordDocument.manifest },
  leakage: { actualPayload: originalRequest, explicitDependenciesSent: originalRequest.state.conclusions.every((c: any) => Array.isArray(c.depends)), payloadOnlyVerdicts, recordedPredictions: Object.fromEntries(Object.entries(record.answers).map(([id, answer]: [string, any]) => [id, answer.value >= 0.5])), suppliedGraphBaselineMatches: publishedMatches, graphOnlyGrid, caveat: "This reconstructs the fixture answer from metadata already sent to Jev. It does not establish that Jev causally relied on those arrays." },
  staleResponse: { requestedAfter: originalRequest.state.after, currentAfter: initial.inspector().after, labelsBeforeOldResponse: beforeResolution.labels, oldRunStillInInspectorBeforeResolution: beforeResolution.inspector.run.answers.travel.value, labelsAfterOldResponse: initial.labels(), observedAfterLateResponse, expectedForCurrentDraft, mismatchedConclusionIds: mismatches },
  syntheticPartial: { suppliedAnswerIds: ["travel"], absentAnswerIds: ["calendar", "catering", "reminder"], labels: partial.labels(), caveat: "The published record is complete; the gateway validates response coverage. This is a missing-record UI probe, not evidence of a live incomplete response." },
  inputBoundaries: { emptyCapacitySubmitted: blank.request().state.after.capacity, noOpSubmitted: JSON.stringify(noOp.request().state.before) === JSON.stringify(noOp.request().state.after), blankRunButtonHasDisabledProp: Object.hasOwn(blank.find("RunButton").props, "disabled"), noOpRunButtonHasDisabledProp: Object.hasOwn(noOp.find("RunButton").props, "disabled"), caveat: "No model outputs were measured for blank or no-op changes." },
  provenance: { storedResultKeys: Object.keys(record), hasStoredState: Object.hasOwn(record, "state"), hasStoredQuestions: Object.hasOwn(record, "questions"), savedQuestion, liveQuestion: originalRequest.questions.travel.instructions, probabilitiesAndConfidenceNull: Object.values(record.answers).every((answer: any) => answer.probabilities === null && answer.confidence === null) },
};
writeFileSync(new URL("changes.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ scenarios: 1, recordedJudgments: 4, graphBaselineMatches: publishedMatches, staleMismatchIds: mismatches, syntheticMissingShownSupported: 3, blankSubmitted: true, noOpSubmitted: true, evidence: "probes/changes.json" }));
