// Offline source/record audit. Captures Canvas commands, not browser pixels.
// Run from root: bun jev-experiments/quality-and-simulation-review/probes/worlds.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const doc = readRecord(new URL("results/visuals.jsonl", app));
const result = doc.result;
const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }) });
const compile = (source: string) => transpiler.transformSync(source).replace(/\bexport\s+/g, "");
const canvasCode = compile(read("src/motion-art.tsx").replace(/^import .*\n/, ""));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function renderCommands(parameters: Record<string, string>, timeMs = 13000, paused = false) {
  const commands: any[] = [], effects: Array<() => void> = [], frames: Array<(time: number) => void> = [];
  const ctx = new Proxy({}, {
    set(target: any, name: string, value: any) { target[name] = value; commands.push(["set", name, value]); return true; },
    get(target: any, name: string) {
      if (name in target) return target[name];
      if (name === "createRadialGradient") return (...args: any[]) => { commands.push([name, ...args]); return { addColorStop: (...args: any[]) => commands.push(["colorStop", ...args]) }; };
      return (...args: any[]) => commands.push([name, ...args]);
    },
  });
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 700, height: 500 }) };
  const context: any = {
    h: () => null,
    useRef: () => ({ current: canvas }),
    useEffect: (fn: () => void) => effects.push(fn),
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    requestAnimationFrame: (fn: (time: number) => void) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    ResizeObserver: class { constructor(_fn: any) {} observe() {} disconnect() {} },
  };
  vm.runInNewContext(canvasCode + "\nthis.render = MotionArt;", context);
  context.render({ parameters, paused });
  effects.forEach(fn => fn());
  commands.length = 0;
  frames[0](timeMs);
  return {
    hash: hash(commands),
    arcs: commands.filter(c => c[0] === "arc"),
    ellipses: commands.filter(c => c[0] === "ellipse"),
    particles: commands.filter(c => c[0] === "translate").map(c => ({ x: c[1], y: c[2] })),
    commands: commands.length,
  };
}

const creative = read("src/creative.tsx");
const worldsCode = compile(creative.slice(creative.indexOf("export function Worlds"), creative.indexOf("const objectTypes")));
let resolveRun!: (r: any) => void, requestState: any, requestQuestions: any;
const slots: any[] = [];
let cursor = 0;
const context: any = {
  h: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
  useState: (initial: any) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (value: any) => slots[index] = typeof value === "function" ? value(slots[index]) : value];
  },
  useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
  choice: (instructions: string, options: string[]) => ({ type: "choice", instructions, criteria: Object.fromEntries(options.map(s => [s, s])) }),
  pretty: (value: unknown) => String(value),
  run: (state: any, questions: any) => { requestState = state; requestQuestions = questions; return new Promise(resolve => resolveRun = resolve); },
  ...Object.fromEntries(["MotionArt", "Button", "Play", "Pause", "Pane", "Field", "RunButton", "ErrorText", "State"].map(s => [s, s])),
};
vm.runInNewContext(worldsCode + "\nthis.worlds = Worlds;", context);
const render = () => { cursor = 0; return context.worlds({ result }); };
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const find = (tree: any, type: string) => nodes(tree).find(n => n.type === type);
let tree = render();
const pending = find(tree, "RunButton").props.onClick();
find(tree, "select").props.onChange({ target: { value: "1" } });
render();
resolveRun({ answers: Object.fromEntries(Object.keys(requestQuestions).map(k => [k, { value: result.scenes[0].scene[k] }])), source: "live" });
await pending;
tree = render();

const runtimeKeys = Object.keys(requestQuestions);
const unsupportedPlans = result.scenes.flatMap((row: any, i: number) => {
  const unsupported = Object.entries(row.scene).filter(([key, value]) => runtimeKeys.includes(key) && !Object.hasOwn(requestQuestions[key].criteria, String(value)));
  return unsupported.length ? [{ index: i, brief: row.brief, unsupported: Object.fromEntries(unsupported) }] : [];
});
const commandDifferences = result.scenes.map((row: any, i: number) => {
  const full = renderCommands(row.scene);
  const projected = renderCommands(Object.fromEntries(runtimeKeys.map(k => [k, row.scene[k]])));
  return { index: i, fullHash: full.hash, withoutShapesHash: projected.hash, differs: full.hash !== projected.hash };
});
const first = result.scenes[0], desert = result.scenes[2], growth = result.scenes[18];
const active13 = renderCommands(first.scene, 13000), paused13 = renderCommands(first.scene, 13000, true), active4 = renderCommands(first.scene, 4000);
const summarizeScene = (row: any) => {
  const draws = renderCommands(row.scene);
  return { brief: row.brief, scene: row.scene, particleCount: draws.particles.length, ellipseCount: draws.ellipses.length, moonOrSunCircle: draws.arcs.find((a: any[]) => a[1] === 532 && a[2] === 120 && a[3] === 24) ?? null };
};
const growthSamples = [0, 20000, 40000].map(timeMs => {
  const commands = renderCommands(growth.scene, timeMs);
  return { timeMs, firstParticle: commands.particles[0], firstParticleRadius: commands.arcs[1]?.[3] };
});
const output = {
  method: "Offline actual React callback harness and actual MotionArt drawing code with a recording Canvas stub. Canvas command differences are not rendered screenshot or perceptual comparisons. No browser or model calls.",
  sourceHashes: Object.fromEntries(["src/creative.tsx", "src/motion-art.tsx", "results/visuals.jsonl"].map(path => [path, createHash("sha256").update(read(path)).digest("hex")])),
  evidence: { scenes: result.scenes.length, choices: result.scenes.reduce((sum: number, row: any) => sum + Object.keys(row.answers).length, 0), recovered: result.scenes.filter((row: any) => row.recovery).length, checks: result.checks, humanPreference: result.human_preference, availability: result.availability },
  currentLiveQuestions: requestQuestions,
  recordedQuestionKeys: Object.keys(first.answers),
  unsupportedRecordedPlans: unsupportedPlans,
  droppedShapeDecisions: result.scenes.length * 4,
  allRecordedFramesDifferWithoutShapes: commandDifferences.every((r: any) => r.differs),
  frameComparisons: commandDifferences,
  recordedExamples: [first, desert].map(summarizeScene),
  pause: { activeAt13Seconds: active13.hash, pausedAt13Seconds: paused13.hash, activeAt4Seconds: active4.hash, pauseChangesFrame: active13.hash !== paused13.hash, pausedEqualsFixed4Seconds: paused13.hash === active4.hash, firstParticleBefore: active13.particles[0], firstParticleAfter: paused13.particles[0] },
  growth: { brief: growth.brief, samples: growthSamples },
  lateResponse: { submittedBrief: requestState, selectedRecordedIndex: find(tree, "select").props.value, draftBrief: find(tree, "textarea").props.value, displayedBrief: find(tree, "h2").props.children[0], displayedSource: find(tree, "State").props.value.source },
};
writeFileSync(new URL("worlds.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ ...output, frameComparisons: undefined, currentLiveQuestions: undefined }, null, 2));
