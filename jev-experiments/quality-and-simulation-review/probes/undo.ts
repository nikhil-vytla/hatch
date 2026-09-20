// Offline audit. Run from the repository root with Bun. No browser or model calls.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readRecord } from "../../experience-prototypes/scripts/records";

const root = new URL("../../../", import.meta.url);
const app = new URL("../../experience-prototypes/", import.meta.url);
const sourcePath = "jev-experiments/experience-prototypes/src/new-experiments.tsx";
const gitRead = (path: string) => {
  const r = Bun.spawnSync(["git", "show", `4c0c40d:${path}`], { cwd: root.pathname });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};
const currentSource = readFileSync(new URL("src/new-experiments.tsx", app), "utf8");
const baselineSource = gitRead(sourcePath);
const extract = (text: string) => text.slice(text.indexOf("export const initialDesign"), text.indexOf("export const impactFacts"));
const source = extract(baselineSource);
const currentBlockUnchanged = source === extract(currentSource);
const evidencePath = "jev-experiments/experience-prototypes/results/undo.jsonl";
const evidenceText = readFileSync(new URL("results/undo.jsonl", app), "utf8");
assert.equal(evidenceText, gitRead(evidencePath), "Published Undo evidence changed from audit baseline");
const document = readRecord(new URL("results/undo.jsonl", app));
const record = document.result;
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__auditElement" } }) }).transformSync(source).replace(/\bexport\s+/g, "");
const fixture: any = {};
vm.runInNewContext(code + "\nthis.initial = initialDesign; this.history = edits;", fixture);
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const history = clone(fixture.history);

function harness(input: any = record, syntheticHistory?: any[]) {
  const slots: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, dirty = false, tree: any, request: any, resolve: any;
  const context: any = {
    __auditElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; if (next !== slots[i]) dirty = true; slots[i] = next; }]; },
    useEffect: (fn: () => void, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old[j])) { slots[i] = deps; effects.push(fn); } },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    run: (state: any, questions: any) => { request = clone({ state, questions }); return new Promise(r => resolve = r); },
    judge: (instructions: string) => ({ type: "noul", instructions }),
    motion: { div: "motion.div", h2: "motion.h2", button: "motion.button" },
    ...Object.fromEntries(["Pane", "Field", "RunButton", "Button", "Undo2", "Check", "ArrowRight", "ErrorText", "State"].map(name => [name, name])),
  };
  vm.runInNewContext(code + "\nthis.component = UndoExperiment; this.replaceHistory = value => edits.splice(0, edits.length, ...value);", context);
  if (syntheticHistory) context.replaceHistory(clone(syntheticHistory));
  const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" ? [v, ...nodes(v.props?.children)] : [];
  const render = () => { for (let i = 0; i < 4; i++) { dirty = false; cursor = 0; tree = context.component({ record: input }); effects.splice(0).forEach(fn => fn()); if (!dirty) break; } return tree; };
  const all = () => nodes(tree), find = (type: string) => all().find(n => n.type === type);
  render();
  return { render, all, find, inspector: () => clone(find("State").props.value), select: (id: string) => { all().find(n => n.type === "button" && n.props.key === id).props.onClick(); render(); }, apply: () => { find("Button").props.onClick(); render(); }, query: (value: string) => { find("textarea").props.onChange({ target: { value } }); render(); }, request: () => request, resolve: (value: any) => resolve(value) };
}

const startup = harness();
const initial = startup.inspector();
startup.apply();
const applied = startup.inspector();
startup.apply();
const restored = startup.inspector();
assert.deepEqual(applied.selected, ["e1", "e3"]);
assert.equal(applied.design.accent, fixture.initial.accent);
assert.equal(applied.design.background, fixture.initial.background);
assert.equal(applied.design.layout, "list");
assert.equal(applied.design.title, "Your next chapter");
assert.deepEqual(restored.design, initial.design);

let subsetMatches = 0, restoreMatches = 0;
for (let mask = 0; mask < 32; mask++) {
  const h = harness(null), selected = history.filter((_: any, i: number) => mask & (1 << i)).map((e: any) => e.id);
  selected.forEach(h.select);
  if (selected.length) h.apply();
  // Independent specification: replay only retained assignments from the initial document.
  const expected = { ...fixture.initial };
  history.filter((e: any) => !selected.includes(e.id)).forEach((e: any) => expected[e.field] = e.after);
  if (isDeepStrictEqual(h.inspector().design, expected)) subsetMatches++;
  if (selected.length) h.apply();
  if (isDeepStrictEqual(h.inspector().design, initial.design)) restoreMatches++;
}
assert.equal(subsetMatches, 32); assert.equal(restoreMatches, 32);

const selectedAfterApply = harness(); selectedAfterApply.apply();
const beforeSelectionEdit = selectedAfterApply.inspector();
selectedAfterApply.select("e4");
const afterSelectionEdit = selectedAfterApply.inspector();
assert.equal(afterSelectionEdit.applied, false);
assert.equal(afterSelectionEdit.design.accent, "#607fa0");

const requestAfterApply = harness(); requestAfterApply.apply();
const beforeRerun = requestAfterApply.inspector();
const samePending = requestAfterApply.find("RunButton").props.onClick();
requestAfterApply.resolve(record); await samePending; requestAfterApply.render();
const afterRerun = requestAfterApply.inspector();
assert.deepEqual(afterRerun.design, initial.design);

const staleSelection = harness();
staleSelection.query("Undo only the title change. Keep every other change.");
const selectedBeforeClick = staleSelection.inspector().selected;
staleSelection.apply();
assert.equal(staleSelection.inspector().design.title, "Your next chapter");

const stale = harness();
const pending = stale.find("RunButton").props.onClick();
stale.query("Undo only the title change. Keep every other change.");
stale.select("e1"); stale.select("e3"); stale.select("e4");
const manualBeforeReply = stale.inspector();
stale.resolve(record); await pending; stale.render();
const afterReply = stale.inspector();
stale.apply();
const afterStaleApply = stale.inspector();
assert.deepEqual(manualBeforeReply.selected, ["e4"]);
assert.deepEqual(afterReply.selected, ["e1", "e3"]);

const repeatedHistory = [
  { id: "agent-a", field: "accent", before: "red", after: "blue", description: "Agent changed accent to blue", actor: "agent" },
  { id: "user-b", field: "accent", before: "blue", after: "green", description: "User changed accent to green", actor: "user" },
];
const overlap = harness(null, repeatedHistory);
overlap.select("agent-a"); overlap.apply();
const earlierOnly = overlap.inspector().design.accent;
const overlapAll = harness(null, repeatedHistory);
overlapAll.select("agent-a"); overlapAll.select("user-b"); overlapAll.apply();
const allOverlapping = overlapAll.inspector().design.accent;
assert.equal(earlierOnly, "red"); assert.equal(allOverlapping, "blue");

const fieldBaseline = history.filter((e: any) => ["accent", "background"].includes(e.field)).map((e: any) => e.id);
const output = {
  method: "Bun executes the frozen 4c0c40d Undo component through mocked React hooks/elements and deferred model results. Decoded the original published record with shared readRecord. No browser, provider calls, app changes, or claim of general model accuracy. Synthetic overlapping-field cases test an extension limit absent from the current UI.",
  baselineCommit: "4c0c40d", currentUndoBlockUnchanged: currentBlockUnchanged,
  sourceHashes: { originalUndoBlock: createHash("sha256").update(source).digest("hex"), publishedEvidence: createHash("sha256").update(evidenceText).digest("hex") },
  evidence: { manifest: document.manifest, requests: 1, decisions: Object.keys(record.answers).length, answers: record.answers, selected: initial.selected, fieldBaseline, baselineMatches: JSON.stringify(fieldBaseline) === JSON.stringify(initial.selected), latencyMs: record.latency_ms, serviceLatencyMs: record.service_latency_ms, attempts: record.attempts, retries: record.retries, costUsd: record.cost_usd, source: record.source, independentLabelsRetained: false, requestRetained: Object.hasOwn(record, "state") || Object.hasOwn(record, "questions") },
  fixedFixture: { fields: history.map((e: any) => e.field), distinctFields: new Set(history.map((e: any) => e.field)).size, actorsRetained: history.some((e: any) => "actor" in e), initial, applied, restored, subsetMatches, restoreMatches, totalSubsets: 32, designEditControlCount: startup.all().filter(n => ["input", "select"].includes(n.type) || n.props.contentEditable).length, previewActionButtonsWithHandlers: startup.all().filter(n => n.type === "motion.button" && n.props.onClick).length },
  selectionAfterApply: { before: beforeSelectionEdit, after: afterSelectionEdit },
  rerunAfterApply: { before: beforeRerun, after: afterRerun },
  queryEditWithoutRerun: { oldSelectionStillApplicable: selectedBeforeClick, after: staleSelection.inspector() },
  staleReply: { request: stale.request(), manualBeforeReply, afterReply, afterApply: afterStaleApply },
  syntheticOverlappingFields: { history: repeatedHistory, scope: "Extension fixture, not reachable through current noneditable UI", undoEarlierOnly: { expectedUnderPreserveLaterAssignmentPolicy: "green", actual: earlierOnly }, undoBoth: { expected: "red", actual: allOverlapping } },
};
writeFileSync(new URL("undo.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ currentUndoBlockUnchanged: currentBlockUnchanged, decisions: output.evidence.decisions, selected: initial.selected, subsetMatches, restoreMatches, staleRequest: afterReply.request, staleSelected: afterReply.selected, overlappingEarlier: earlierOnly, overlappingBoth: allOverlapping }, null, 2));
