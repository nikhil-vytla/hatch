// Offline audit of actual component callbacks and installed TanStack row models.
// Run from root: bun jev-experiments/quality-and-simulation-review/probes/semantic-table.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { createTable, getCoreRowModel, getSortedRowModel } from "../../experience-prototypes/node_modules/@tanstack/table-core/build/lib/index.mjs";
import { readRecord } from "../../experience-prototypes/scripts/records";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const source = read("src/new-experiments.tsx");
const record = readRecord(new URL("results/semantic-table.jsonl", app)).result;
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__auditElement" } }) })
  .transformSync(source.slice(source.indexOf("export const supportRows"), source.indexOf("export const initialDesign")))
  .replace(/\bexport\s+/g, "");
const fixtures: any = {};
vm.runInNewContext(code + "\nthis.rows = supportRows;", fixtures);

function harness(input = record) {
  const slots: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, dirty = false, tree: any, table: any, tableOptions: any, request: any, resolve: any, exported: any;
  const context: any = {
    __auditElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; if (next !== slots[i]) dirty = true; slots[i] = next; }]; },
    useEffect: (fn: () => void, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old[j])) { slots[i] = deps; effects.push(fn); } },
    useMemo: (fn: () => any, deps: any[]) => { const i = cursor++; if (!(i in slots)) slots[i] = fn(); return slots[i]; },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    useReactTable: (options: any) => {
      tableOptions = options;
      table = createTable({ ...options, state: {}, onStateChange() {}, renderFallbackValue: null });
      table.setOptions((old: any) => ({ ...old, state: { ...table.initialState, ...options.state } }));
      return table;
    },
    getCoreRowModel, getSortedRowModel,
    flexRender: (render: any, props: any) => typeof render === "function" ? render(props) : render,
    judge: (instructions: string) => ({ type: "noul", instructions }),
    percent: (n: number) => `${Math.round(n * 100)}%`,
    run: (state: any, questions: any) => { request = { state, questions }; return new Promise(r => resolve = r); },
    download: (_name: string, value: any) => exported = value,
    motion: { tr: "motion.tr" },
    ...Object.fromEntries(["Pane", "Field", "RunButton", "Notice", "Button", "Download", "ErrorText", "State"].map(name => [name, name])),
  };
  vm.runInNewContext(code + "\nthis.component = SemanticTable;", context);
  const nodes = (value: any): any[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
  const render = () => { for (let i = 0; i < 4; i++) { dirty = false; cursor = 0; tree = context.component({ record: input }); effects.splice(0).forEach(fn => fn()); if (!dirty) break; } return tree; };
  const all = () => nodes(tree), find = (type: string) => all().find(n => n.type === type);
  render();
  return { render, all, find, request: () => request, resolve: (r: any) => resolve(r), exported: () => exported, inspector: () => find("State").props.value, rowModel: () => table.getRowModel().rows.map((r: any) => ({ tableId: r.id, domainId: r.original.id, score: r.original.score, correction: r.original.correction })), tableOptions: () => tableOptions };
}

const corrected = harness();
const initialRowIds = corrected.rowModel();
corrected.all().find(n => n.type === "button" && n.props.className === "table-excerpt").props.onClick(); corrected.render();
corrected.find("select").props.onChange({ target: { value: "Already resolved" } }); corrected.render();
corrected.all().find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }); corrected.render();
const correctedVisible = corrected.rowModel();
corrected.find("Button").props.onClick();
const correctedExport = corrected.exported();
corrected.all().find(n => n.type === "input" && n.props["aria-label"] === "Question for each row").props.onChange({ target: { value: "Is a successful refund evidenced?" } }); corrected.render();

const stale = harness();
const pending = stale.find("RunButton").props.onClick();
stale.all().find(n => n.type === "input" && n.props["aria-label"] === "Question for each row").props.onChange({ target: { value: "Is a successful refund evidenced?" } }); stale.render();
stale.resolve({ ...record, source: "live" }); await pending; stale.render();
stale.find("Button").props.onClick();

const partial = harness({ ...record, answers: { "01": record.answers["01"], "02": record.answers["02"] } });
partial.all().find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }); partial.render();

const evidenceRows = fixtures.rows.map((row: any) => ({ id: row.id, text: row.text, promisedFixture: row.promised, completedFixture: row.completed, derivedFixtureTarget: row.promised && !row.completed, score: record.answers[row.id].value, predictedMatch: record.answers[row.id].value >= 0.5 }));
const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
for (const r of evidenceRows) confusion[r.derivedFixtureTarget ? (r.predictedMatch ? "tp" : "fn") : (r.predictedMatch ? "fp" : "tn")]++;

const output = {
  method: "Decoded published evidence, executed actual SemanticTable callbacks with mocked React hooks/elements, and used installed TanStack Table 8.21.3 core row models. No browser, model calls, or app edits; callback tests do not establish general semantic accuracy.",
  sourceHashes: Object.fromEntries(["src/new-experiments.tsx", "scripts/record.ts", "results/semantic-table.jsonl"].map(path => [path, createHash("sha256").update(read(path)).digest("hex")])),
  evidence: { rows: evidenceRows.length, judgments: Object.keys(record.answers).length, derivedFixtureMatches: confusion.tp + confusion.tn, confusion, latencyMs: record.latency_ms, attempts: record.attempts, payloadRetainedInPublishedResult: Object.hasOwn(record, "state") || Object.hasOwn(record, "questions"), evidenceRows },
  actualRequest: { rowCount: Object.keys(stale.request().state.conversations).length, questionCount: Object.keys(stale.request().questions).length, stateKeys: Object.keys(stale.request().state), allRowsShareState: true, firstQuestion: stale.request().questions["01"].instructions, goldAnnotationKeysSent: /"(?:promised|completed)"\s*:/.test(JSON.stringify(stale.request().state)), payloadBytes: Buffer.byteLength(JSON.stringify(stale.request())) },
  corrections: { changedRow: correctedExport.rows.find((r: any) => r.id === "01"), visibleAfterAlreadyResolved: correctedVisible.map((r: any) => r.domainId), exportRetainsRawScore: correctedExport.rows.find((r: any) => r.id === "01").score, correctionAfterQueryChange: corrected.inspector().rows.find((r: any) => r.id === "01").correction ?? null },
  emptyFilteredQueryChange: { onlyMatchesStillChecked: corrected.all().find(n => n.type === "input" && n.props.type === "checkbox").props.checked, visibleRows: corrected.rowModel().length, notEvaluatedUnderlyingRows: corrected.inspector().rows.filter((r: any) => r.score === undefined).length },
  staleQuery: { requestedQuestion: stale.request().questions["01"].instructions, visibleQuestion: stale.inspector().question, oldQuestionScoreNowVisible: stale.inspector().rows[0].score, exportQuestion: stale.exported().question, exportFirstScore: stale.exported().rows[0].score },
  rowIdentity: { before: initialRowIds, filtered: correctedVisible, explicitGetRowId: typeof corrected.tableOptions().getRowId === "function", headerClickHandlers: corrected.all().filter(n => n.type === "th" && n.props.onClick).length, currentSelectionUsesDomainId: true },
  incompleteRecordFixture: { total: partial.inspector().rows.length, evaluated: partial.inspector().rows.filter((r: any) => r.score !== undefined).length, visibleMatched: partial.rowModel().length, unknownHidden: partial.inspector().rows.filter((r: any) => r.score === undefined).length, note: "Synthetic missing-answer record for a UI coverage check. Actual published record contains all eight answers; live gateway rejects incomplete responses." },
};
writeFileSync(new URL("semantic-table.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
