// Offline audit of the checked-in source. No browser or provider calls.
// Run from the repo root: bun jev-experiments/quality-and-simulation-review/probes/paste.ts
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { decodeRecord } from "../../experience-prototypes/scripts/records";
import { validate } from "../../experience-prototypes/server/gateway";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const source = read("src/new-experiments.tsx");
const excerpt = source.slice(source.indexOf("export const pasteSources"), source.indexOf("export const supportRows"));
const compiled = new Bun.Transpiler({
  loader: "tsx",
  tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }),
}).transformSync(excerpt).replace(/\bexport\s+/g, "");

function instance(record: any, run = async () => ({ answers: {} })) {
  let slots: any[] = [], cursor = 0, effects: Array<() => void> = [];
  const context: any = {
    h: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => slots[index] = typeof value === "function" ? value(slots[index]) : value];
    },
    useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => void, deps: unknown[]) => {
      const index = cursor++;
      if (!slots[index] || deps.some((d, i) => d !== slots[index][i])) effects.push(fn);
      slots[index] = deps;
    },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    choice: (instructions: string, criteria: any) => ({ type: "choice", instructions, criteria }),
    run,
    motion: { button: "motion.button", div: "motion.div" },
    ...Object.fromEntries(["AnimatePresence", "Pills", "Download", "Pane", "ArrowRight", "Field", "Plus", "Button", "Check", "Undo2", "RunButton", "ErrorText", "Notice", "State"].map(x => [x, x])),
  };
  vm.runInNewContext(compiled + "\nthis.audit = { Paste, extractFacts, pasteFields, pasteSources, pasteQuestions };", context);
  const render = () => {
    cursor = 0;
    const tree = context.audit.Paste({ record });
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
    return tree;
  };
  render();
  return { render, api: context.audit };
}
const nodes = (tree: any): any[] => Array.isArray(tree)
  ? tree.flatMap(nodes)
  : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const find = (tree: any, type: string, label?: string) => {
  const result = nodes(tree).find(n => n.type === type && (label === undefined || n.props.label === label));
  if (!result) throw new Error(`No ${type} ${label ?? ""}`);
  return result;
};
const state = (tree: any) => find(tree, "State").props.value;
const field = (tree: any, label: string) => find(find(tree, "Field", label), "input");
const button = (tree: any, word: string) => nodes(tree).find(n => n.type === "Button" && JSON.stringify(n.props.children).includes(word));
const recorded = { rows: [{ preset: "Conference", answers: { f0: { value: "fact0" } } }] };
const published = decodeRecord(read("results/paste.jsonl"));
const base = instance(published.result);
const allRecordedAnswers = published.result.rows.flatMap((row: any) => Object.values(row.answers));
const recordedMappings = published.result.rows.map((row: any) => {
  const facts = base.api.extractFacts(row.source_text);
  return {
    preset: row.preset,
    latencyMs: row.latency_ms,
    retries: row.retries,
    fields: Object.entries(row.answers).map(([key, answer]: [string, any]) => ({
      field: base.api.pasteFields[row.preset][Number(key.slice(1))],
      selected: answer.value,
      fact: facts.find((fact: any) => fact.id === answer.value) ?? null,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    })),
  };
});

const overwrite = instance(recorded);
let tree = overwrite.render();
field(tree, "Event title").props.onChange({ target: { value: "Manual title" } });
tree = overwrite.render();
button(tree, "Fill suggestions").props.onClick();
tree = overwrite.render();
const overwritten = state(tree).filled.f0;
field(tree, "Event title").props.onChange({ target: { value: "Manual edit after accept" } });
tree = overwrite.render();
button(tree, "Undo").props.onClick();
tree = overwrite.render();
const afterUndo = state(tree).filled.f0;

const cross = instance(recorded);
tree = cross.render();
field(tree, "Event title").props.onChange({ target: { value: "Unrelated conference title" } });
tree = cross.render();
button(tree, "Fill suggestions").props.onClick();
tree = cross.render();
find(tree, "select").props.onChange({ target: { value: "Contact" } });
tree = cross.render();
button(tree, "Undo").props.onClick();
tree = cross.render();
const crossPreset = { fields: state(tree).fields, filled: state(tree).filled };

let resolveRun!: (result: any) => void;
const late = instance({ rows: [] }, () => new Promise(resolve => resolveRun = resolve));
tree = late.render();
const request = find(tree, "RunButton").props.onClick();
find(tree, "textarea").props.onChange({ target: { value: "Event: Changed while request was running" } });
late.render();
resolveRun({ answers: { f0: { value: "fact0" } }, source: "live" });
await request;
tree = late.render();
button(tree, "Fill suggestions").props.onClick();
tree = late.render();
const staleResponse = state(tree);

async function extensionPayload(text: string, count: number) {
  let listener: any, payload: any;
  const data: any = { endpoint: "https://example.test", apiKey: "test-fixture", source: text };
  const chrome = {
    runtime: { id: "probe", onInstalled: { addListener() {} }, onMessage: { addListener(fn: any) { listener = fn; } } },
    storage: { local: { async setAccessLevel() {}, async remove() {}, async get() { return data; }, async set(value: any) { Object.assign(data, value); } } },
    contextMenus: { onClicked: { addListener() {} }, create() {} },
    action: { setBadgeText() {} },
  };
  vm.runInNewContext(read("extension/background.js"), {
    chrome, URL,
    fetch: async (_url: any, init: any) => {
      payload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: {} }) };
    },
  });
  await new Promise(resolve => listener({
    type: "suggest",
    fields: Array.from({ length: count }, (_, i) => ({ id: `field${i}`, label: `Destination ${i}`, type: "text" })),
  }, { id: "probe", tab: {} }, resolve));
  let validation = "accepted";
  try { validate(payload); } catch (e) { validation = (e as Error).message; }
  return { bytes: Buffer.byteLength(JSON.stringify(payload)), validation, facts: payload.state.source, payload };
}
const largeSource = Array.from({ length: 80 }, (_, i) => `Fact ${i}: ${"x".repeat(80)}`).join("\n");
const large = await extensionPayload(largeSource, 24);
const truncation = await extensionPayload(Array.from({ length: 81 }, (_, i) => `Fact ${i}: Value ${i}`).join("\n"), 1);
const malformed = await extensionPayload("https://northstar.example\n9:30 AM\nMaya Chen works at Northstar Studio. Her email is maya@example.com.", 1);
const results = {
  method: "Offline Bun execution of actual React component source with a minimal hook/element harness and actual extension background source with a mocked Chrome API and fetch. This is not a browser run or a model evaluation.",
  published: {
    status: published.manifest.status,
    rows: published.result.rows.length,
    decisions: allRecordedAnswers.length,
    abstentions: allRecordedAnswers.filter((a: any) => a.value === "none").length,
    minimumConfidence: Math.min(...allRecordedAnswers.map((a: any) => a.confidence)),
    initialSuggestions: state(base.render()).suggestions,
    mappings: recordedMappings,
  },
  authoredPresets: Object.entries(base.api.pasteSources).map(([name, value]) => ({ name, facts: base.api.extractFacts(value).length, fields: base.api.pasteFields[name].length })),
  appParsing: base.api.extractFacts("https://northstar.example\n9:30 AM\nMaya Chen works at Northstar Studio. Her email is maya@example.com."),
  overwrite: { manualValueBefore: "Manual title", afterFillAll: overwritten },
  undo: { manualValueAfterAccept: "Manual edit after accept", valueAfterUndo: afterUndo },
  crossPresetUndo: crossPreset,
  staleResponse: { sourceSent: base.api.pasteSources.Conference, currentFacts: staleResponse.facts, suggestions: staleResponse.suggestions, accepted: staleResponse.filled },
  extensionPayloadLimit: { sourceBytes: Buffer.byteLength(largeSource), fields: 24, facts: large.facts.length, payloadBytes: large.bytes, validation: large.validation },
  extensionTruncation: { suppliedLines: 81, retained: truncation.facts.length, finalRetained: truncation.facts.at(-1), explicitTruncationField: Object.keys(truncation.payload.state).some(k => /trunc|omit/i.test(k)) },
  extensionParsing: malformed.facts,
};
const output = new URL("paste.json", import.meta.url);
writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
