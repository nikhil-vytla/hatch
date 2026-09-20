// Offline probe of current component callbacks, records, and installed composer.
// Run from repo root: bun jev-experiments/quality-and-simulation-review/probes/ui.ts
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";
import { uiInitial, exampleSpec, uiCandidates, uiCatalog } from "../../experience-prototypes/src/ui-catalog";
import { experimental_composeSpec } from "../../experience-prototypes/node_modules/@json-render/core/dist/index.js";
import { compose } from "../../experience-prototypes/server/compose";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const published = readRecord(new URL("results/composed-ui.jsonl", app));
const cloud = readRecord(new URL("results/cloudcheck.jsonl", app));
const legacy = readRecord(new URL("../../results/ui.jsonl", new URL("src/", app))).result;
const component = read("src/generated-ui.tsx");
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }) })
  .transformSync(component.slice(component.indexOf("function Input"))).replace(/\bexport\s+/g, "");

function harness(record: any, fetcher: any = async () => { throw Error("Unexpected fetch"); }) {
  const slots: any[] = [];
  let cursor = 0, effects: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const context: any = {
    uiCatalog, uiInitial, exampleSpec,
    h: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => slots[index] = typeof value === "function" ? value(slots[index]) : value];
    },
    useRef: (initial: any) => {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect: (fn: () => void, deps: unknown[]) => {
      const index = cursor++;
      if (!slots[index] || deps.some((d, i) => d !== slots[index][i])) effects.push(fn);
      slots[index] = deps;
    },
    useRun: () => ({ busy: false, error: "", execute: async (fn: () => any) => { try { return await fn(); } catch (e) { context.lastError = String(e); } } }),
    defineRegistry: () => ({ registry: {} }),
    motion: { div: "motion.div", section: "motion.section", h2: "motion.h2", p: "motion.p", i: "motion.i", button: "motion.button", article: "motion.article" },
    getApiKey: () => "test-only",
    fetch: fetcher,
    AbortController, TextDecoder,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    ...Object.fromEntries(["Renderer", "StateProvider", "ActionProvider", "VisibilityProvider", "Sparkles", "Check", "GitBranch", "RotateCcw", "Pane", "Field", "Button", "RunButton", "Pills", "Notice", "State", "ErrorText"].map(x => [x, x])),
  };
  vm.runInNewContext(code + "\nthis.audit = { GeneratedUI, StateObserver };", context);
  const render = () => {
    cursor = 0;
    const tree = context.audit.GeneratedUI({ record });
    const pending = effects;
    effects = [];
    pending.forEach(effect => effect());
    return tree;
  };
  render();
  return { render, context, intervals };
}
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const find = (tree: any, type: any) => nodes(tree).find(n => n.type === type);
const version = (tree: any) => nodes(tree).find(n => n.type === "button" && n.props.children.some((x: any) => x?.type === "GitBranch"));
const state = (tree: any) => find(tree, "State").props.value;
const sourceLabel = (tree: any) => nodes(tree).find(n => n.type === "span" && n.props.className === "badge").props.children[0];
const button = (tree: any, label: string) => nodes(tree).find(n => n.type === "Button" && JSON.stringify(n.props.children).includes(label));

const h = harness(published.result);
let tree = h.render();
const providerBefore = find(tree, "StateProvider").props;
find(tree, h.context.audit.StateObserver).props.onState({ ...uiInitial, name: "User-edited draft" });
version(tree).props.onClick();
tree = h.render();
const providerAfter = find(tree, "StateProvider").props;
find(tree, "ActionProvider").props.handlers.shortlist({ name: "Sunlit studio" });
tree = h.render();
const shortlistNotice = find(tree, "Notice").props.children;
const runtimeStateAfterShortlist = h.context.audit ? find(tree, "StateProvider").props.initialState : null;

const encoder = new TextEncoder();
let streamController!: ReadableStreamDefaultController<Uint8Array>;
let sentBody: any, sentSignal: AbortSignal;
const late = harness(published.result, async (_url: any, init: any) => {
  sentBody = JSON.parse(init.body); sentSignal = init.signal;
  return { ok: true, body: new ReadableStream({ start(controller) { streamController = controller; } }) };
});
tree = late.render();
const pending = find(tree, "RunButton").props.onClick();
await Promise.resolve();
find(tree, "Pills").props.onChange("apartments");
late.render();
const apartmentsBefore = state(late.render()).spec;
streamController.enqueue(encoder.encode(JSON.stringify({ type: "complete", stopReason: "finish", spec: published.result.rows[0].spec }) + "\n"));
streamController.close();
await pending;
tree = late.render();
const crossDomain = {
  requestedDomain: sentBody.domain,
  currentDomain: find(tree, "Pills").props.value,
  abortedOnDomainSwitch: sentSignal!.aborted,
  beforeSwitchResultTypes: Object.values(apartmentsBefore.elements).map((e: any) => e.type),
  afterLateResultTypes: Object.values(state(tree).spec.elements).map((e: any) => e.type),
  label: sourceLabel(tree),
};

const partial = harness(published.result, async () => ({
  ok: true,
  body: new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(JSON.stringify({ type: "step", spec: published.result.rows[0].spec, step: { choice: "fixture-step" } }) + "\n"));
    controller.close();
  } }),
}));
tree = partial.render();
await find(tree, "RunButton").props.onClick();
tree = partial.render();
const prematureEnd = { label: sourceLabel(tree), versionLabels: nodes(tree).filter(n => n.type === "button" && n.props.children.some((x: any) => x?.type === "GitBranch")).map(n => n.props.children), notice: find(tree, "Notice")?.props.children ?? null };

const strategies = [];
for (const strategy of ["batched", "batch"]) {
  try {
    for await (const _event of compose({ prompt: "Finish", domain: "settings", strategy }, new AbortController().signal, "test-only")) {}
    strategies.push({ strategy, error: null });
  } catch (error) { strategies.push({ strategy, error: (error as Error).message }); }
}

const evaluatorInputs: any[] = [];
let composedFinal: any;
for await (const event of experimental_composeSpec({
  catalog: uiCatalog, candidates: uiCandidates("settings"), initialSpec: exampleSpec,
  initialState: { ...uiInitial, name: "Private edited marker" },
  prompt: "Keep this interface", strategy: "sequential",
  evaluate: async (request: any) => {
    evaluatorInputs.push({ state: request.state, questions: request.questions });
    return { answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]: [string, any]) => [id, { choice: id === "next" ? "finish" : Object.keys(question.criteria)[0] }])) };
  },
})) composedFinal = event;

const candidateCounts = ["settings", "apartments", "event"].map(domain => ({ domain, candidates: uiCandidates(domain).length }));
const currentRows = published.result.rows.map((r: any) => ({
  domain: r.domain, catalogVersion: r.catalog_version ?? null, stopReason: r.stopReason, nodes: Object.keys(r.spec.elements).length,
  steps: r.steps.length, elapsedMs: r.elapsedMs,
  hasTerminalStep: r.steps.some((s: any) => ["finish", "unavailable"].includes(s.choice)),
  candidateUseOverCurrentLimit: uiCandidates(r.domain).flatMap(c => {
    const count = r.steps.filter((s: any) => s.choice === c.id).length;
    return count > (c.maxUses ?? 1) ? [{ candidate: c.id, count, currentLimit: c.maxUses ?? 1 }] : [];
  }),
}));
const completeLegacy = legacy.rows.filter((r: any) => !r.error);
const output = {
  method: "Offline actual-component callback/hook harness, published-record decoding, actual installed composer with a deterministic mocked evaluator, and actual wrapper invalid-strategy validation. No browser or model calls.",
  candidateCounts, currentRows,
  previousAttempts: published.result.previous_attempts.map((r: any) => ({ domain: r.domain, stopReason: r.stopReason, steps: r.steps.length })),
  recordedCloudRevision: cloud.composition,
  versionReselection: { editedName: "User-edited draft", keyBefore: providerBefore.key, keyAfter: providerAfter.key, nextInitialName: providerAfter.initialState.name, externalStore: !!providerAfter.store },
  shortlist: { notice: shortlistNotice, hasShortlistInState: Object.hasOwn(runtimeStateAfterShortlist, "shortlist") },
  crossDomain,
  prematureEnd,
  strategies,
  composerStateBoundary: { preservedName: composedFinal.spec.state.name, evaluatorReceivedMarker: JSON.stringify(evaluatorInputs).includes("Private edited marker"), inputStateKeys: Object.keys(evaluatorInputs[0].state) },
  legacyEvidence: { planned: legacy.rows.length, completed: completeLegacy.length, layoutCorrect: completeLegacy.filter((r: any) => r.layout_correct).length, revisionPreserved: completeLegacy.filter((r: any) => r.revision_preserved_layout).length, storedLayoutAccuracy: legacy.layout_accuracy, storedRevisionStability: legacy.revision_stability },
};
writeFileSync(new URL("ui.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
