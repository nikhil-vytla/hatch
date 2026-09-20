// Offline actual-renderer/callback audit. No browser, endpoint calls, or app edits.
// Run from repo root: bun jev-experiments/quality-and-simulation-review/probes/pixels.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";

const app = new URL("../../experience-prototypes/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const source = read("src/creative.tsx");
const result = readRecord(new URL("results/visuals.jsonl", app)).result;
const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }) });
const code = transpiler.transformSync(source.slice(source.indexOf("const objectTypes"), source.indexOf("export function Music"))).replace(/\bexport\s+/g, "");
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const choice = (instructions: string, options: string[]) => ({ type: "choice", instructions, criteria: Object.fromEntries(options.map(value => [value, value])) });
const judge = (instructions: string) => ({ type: "noul", instructions });
const base: any = { choice, judge };
vm.runInNewContext(code + "\nthis.paint = paintPixels; this.questions = pixelQuestions; this.initial = initialPixelPlan; this.kinds = objectTypes;", base);

function raster(plan: any, mode: string, time = 0) {
  const bytes = new Uint8Array(64 * 64 * 4), rects: any[] = [], reads = new Set<string>();
  const fill = (x: number, y: number, w: number, h: number, rgba: number[]) => {
    for (let yy = Math.max(0, y); yy < Math.min(64, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(64, x + w); xx++) bytes.set(rgba, (yy * 64 + xx) * 4);
  };
  const ctx = {
    fillStyle: "#000000", imageSmoothingEnabled: true,
    clearRect(x: number, y: number, w: number, h: number) { fill(x, y, w, h, [0, 0, 0, 0]); },
    fillRect(x: number, y: number, w: number, h: number) {
      const s = this.fillStyle.slice(1), rgba = [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
      rgba.push(s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255);
      rects.push({ x, y, w, h, color: this.fillStyle });
      if (rgba[3]) fill(x, y, w, h, rgba);
    },
  };
  const canvas = { width: 64, height: 64, getContext: () => ctx };
  base.paint(canvas, new Proxy(plan, { get(target, key) { if (typeof key === "string") reads.add(key); return target[key]; } }), mode, time);
  const clipped = rects.filter(r => r.color !== "#00000000" && (r.x < 0 || r.y < 0 || r.x + r.w > 64 || r.y + r.h > 64));
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), reads: [...reads], rects, clipped };
}

function harness() {
  const slots: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, dirty = false, pendingResolve: any, request: any, frames: Array<() => void> = [], paintCalls = 0;
  const canvas = { width: 64, height: 64, getContext: () => ({ clearRect() {}, fillRect() {} }), toDataURL: () => "data:image/png;base64,stub" };
  const context: any = {
    choice, judge,
    h: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: any) => { const next = typeof v === "function" ? v(slots[i]) : v; if (next !== slots[i]) dirty = true; slots[i] = next; }]; },
    useRef: () => { const i = cursor++; return slots[i] ??= { current: canvas }; },
    useEffect: (fn: () => void, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old[j])) { slots[i] = deps; effects.push(fn); } },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    run: (state: any, questions: any) => { request = { state, questions }; return new Promise(resolve => pendingResolve = resolve); },
    performance: { now: () => 1000 }, matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    ...Object.fromEntries(["Pills", "Pane", "Field", "LockKeyhole", "RunButton", "Button", "Download", "ErrorText", "State"].map(name => [name, name])),
  };
  vm.runInNewContext(code + "\nthis.component = Pixels; paintPixels = () => { this.painted(); };", context);
  context.painted = () => paintCalls++;
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
  let tree: any;
  const render = () => {
    for (let i = 0; i < 5; i++) {
      dirty = false; cursor = 0; tree = context.component({ result });
      const pendingEffects = effects.splice(0); pendingEffects.forEach(fn => fn());
      if (!dirty) break;
    }
    return tree;
  };
  const find = (type: string) => nodes(tree).find(n => n.type === type);
  render();
  return { render, find, nodes: () => nodes(tree), request: () => request, resolve: (r: any) => pendingResolve(r), inspector: () => find("State").props.value, paintCount: () => paintCalls, flushFrame: () => frames.shift()?.(), queuedFrames: () => frames.length };
}
const responseFor = (plan: any) => ({ answers: Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, { value: base.kinds.includes(key) ? Number(value) : value }])), source: "live", latency_ms: 10 });

const stale = harness();
const stalePending = stale.find("RunButton").props.onClick();
stale.find("Pills").props.onChange("sprites"); stale.render();
stale.resolve(responseFor(result.compositions[0].plan)); await stalePending; stale.render();

const lock = harness();
const lockPending = lock.find("RunButton").props.onClick();
lock.nodes().find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }); lock.render();
lock.resolve(responseFor({ ...result.compositions[0].plan, palette: "warm" })); await lockPending; lock.render();

const versions = harness();
versions.find("textarea").props.onChange({ target: { value: "Make a warm scene." } }); versions.render();
const versionPending = versions.find("RunButton").props.onClick();
versions.resolve(responseFor({ ...result.compositions[0].plan, palette: "warm" })); await versionPending; versions.render();
versions.nodes().find(n => n.type === "button").props.onClick(); versions.render();

const loop = harness();
const paintsBefore = loop.paintCount();
for (let i = 0; i < 6; i++) loop.flushFrame();

const readings = result.compositions.map((c: any) => {
  const r = raster(c.plan, c.mode);
  return { mode: c.mode, questionCount: Object.keys(base.questions(c.mode)).length, answers: Object.keys(c.answers).length, usedFields: r.reads, unreadAnswers: Object.keys(c.answers).filter(key => !r.reads.includes(key)), selectedObjects: base.kinds.filter((key: string) => c.plan[key]), frameHash: r.hash, fillRectCalls: r.rects.length, changesAtOneSecond: raster(c.plan, c.mode, 1).hash !== r.hash, latencyMs: c.latency_ms };
});
const placementChecks = base.kinds.flatMap((kind: string) => [12, 24, 32, 44, 52].flatMap(x => [12, 24, 36, 44, 52].map(y => {
  const r = raster({ palette: "night", [kind]: true, [kind + "_x"]: x, [kind + "_y"]: y }, "sprites");
  return { kind, x, y, clippedRectangles: r.clipped.length };
})));
const pattern = result.compositions.find((c: any) => c.mode === "patterns");
const alteredPattern = { ...pattern.plan, weather: "rain", ...Object.fromEntries(base.kinds.flatMap((kind: string) => [[kind, true], [kind + "_x", "12"], [kind + "_y", "12"]])) };
const moon = raster({ palette: "night", moon: true, moon_x: 32, moon_y: 24 }, "sprites");

// PNG writer for this renderer's integer, opaque-or-transparent fillRect output.
function png(bytes: Uint8Array, w: number, h: number) {
  const crc = (b: Uint8Array) => { let c = -1; for (const v of b) { c ^= v; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ -1) >>> 0; };
  const chunk = (name: string, data: Uint8Array) => { const tag = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([tag, data]))); return Buffer.concat([size, tag, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6;
  const scan = Buffer.alloc(h * (w * 4 + 1)); for (let y = 0; y < h; y++) scan.set(bytes.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scan)), chunk("IEND", new Uint8Array())]);
}
const panels = [
  ...result.compositions.map((c: any) => ({ label: "Recorded " + c.mode + ", time 0", frame: raster(c.plan, c.mode).bytes })),
  { label: "Prepared initial scene, time 0", frame: raster(base.initial, "scenes").bytes },
  { label: "Legal robot_y=12 placement clips top", frame: raster({ palette: "garden", robot: true, robot_x: 32, robot_y: 12 }, "sprites").bytes },
  { label: "Moon sprite cutout paints opaque background", frame: moon.bytes },
];
const sheet = new Uint8Array(768 * 512 * 4);
for (let i = 0; i < panels.length; i++) for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const src = (Math.floor(y / 4) * 64 + Math.floor(x / 4)) * 4, dst = ((Math.floor(i / 3) * 256 + y) * 768 + (i % 3) * 256 + x) * 4;
  sheet.set(panels[i].frame.subarray(src, src + 4), dst);
}
writeFileSync(new URL("pixels.png", import.meta.url), png(sheet, 768, 512));

const output = {
  method: "Actual paintPixels and Pixels functions executed offline. Integer fillRect/clearRect software rasterizer mirrors the operations used by this renderer; React callbacks use mocked hooks/elements and deferred responses. Contact sheet is not a browser screenshot. No endpoint/model calls.",
  sourceHashes: { "src/creative.tsx": digest(source), "results/visuals.jsonl": digest(read("results/visuals.jsonl")) },
  evidence: { compositions: result.compositions.length, compositionAnswers: result.compositions.reduce((s: number, c: any) => s + Object.keys(c.answers).length, 0), oldPixelRows: result.pixels.length, oldPixelSuccesses: result.pixels.filter((p: any) => p.answers).length, oldPixelAnswers: result.pixels.reduce((s: number, p: any) => s + Object.keys(p.answers ?? {}).length, 0), legacyRenderedByCurrentComponent: false, humanPreference: result.human_preference, enclosingChecks: result.checks },
  readings,
  unusedAnswers: readings.reduce((s: number, r: any) => s + r.unreadAnswers.length, 0),
  patternInvariant: { allOtherFieldsChanged: true, samePixels: raster(pattern.plan, "patterns").hash === raster(alteredPattern, "patterns").hash },
  geometry: { testedPlacements: placementChecks.length, clippedPlacements: placementChecks.filter((p: any) => p.clippedRectangles).length, clippedByObject: Object.fromEntries(base.kinds.map((kind: string) => [kind, placementChecks.filter((p: any) => p.kind === kind && p.clippedRectangles).length])), examples: placementChecks.filter((p: any) => p.clippedRectangles).slice(0, 6), moonCutoutPixelAt36_20: Array.from(moon.bytes.subarray((20 * 64 + 36) * 4, (20 * 64 + 36) * 4 + 4)) },
  staleResponse: { submittedMode: stale.request().state.mode, currentMode: stale.find("Pills").props.value, currentBrief: stale.find("textarea").props.value, displayedObjects: base.kinds.filter((key: string) => stale.inspector().plan[key]) },
  lockDuringRequest: { checked: lock.nodes().find(n => n.type === "input" && n.props.type === "checkbox").props.checked, paletteAtRequest: lock.request().state.current.palette, paletteAfterResponse: lock.inspector().plan.palette, lockIncludedInRequest: Object.hasOwn(lock.request().state, "locked") },
  versionSelection: { selectedPlanPalette: versions.inspector().plan.palette, inspectorRunPalette: versions.inspector().run.answers.palette.value, visibleBrief: versions.find("textarea").props.value },
  reducedMotion: { paintCallsFromSixCallbacks: loop.paintCount() - paintsBefore, stillHasQueuedFrames: loop.queuedFrames() > 0 },
  contactSheet: { path: "probes/pixels.png", dimensions: [768, 512], order: "Left to right, top row then bottom row", panels: panels.map(p => p.label) },
};
writeFileSync(new URL("pixels.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
