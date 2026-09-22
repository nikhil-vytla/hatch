import { expect, test } from "bun:test";
import ts from "../experience-prototypes/node_modules/typescript/lib/typescript.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { initialSession, reduce } from "../live-worlds/ghost-brush/session";
import { lexicalRank, requestFor } from "../live-worlds/ghost-brush/model";

const sourceRoot = process.env.JEV_LEGACY_SOURCE ?? resolve(import.meta.dir, "../experience-prototypes/src");
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit); }
  visit(root); if (!found) throw Error("Maintained callback changed; inspect the lifecycle probe."); return found;
}
function scope(file: string, name: string, context: Record<string, any>) {
  const source = ts.createSourceFile(file, readFileSync(resolve(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const sandbox = createContext({ AbortController, URL, ...context });
  function compile(node: ts.Node) {
    runInContext(ts.transpileModule(`globalThis.extracted = ${node.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, sandbox);
    return sandbox.extracted as (...args: any[]) => any;
  }
  return {
    sandbox,
    method(name: string) {
      const node = find(component, node => ts.isFunctionDeclaration(node) && node.name?.text === name || ts.isVariableDeclaration(node) && node.name.getText(source) === name);
      return compile(ts.isVariableDeclaration(node) ? node.initializer! : node);
    },
    effect(markers: string[], emptyDeps = false) {
      const call = find(component, node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && markers.some(marker => node.arguments[0].getText(source).includes(marker)) && (!emptyDeps || node.arguments[1]?.getText(source) === "[]")) as ts.CallExpression;
      return compile(call.arguments[0]);
    },
  };
}
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setters(state: Record<string, any>, names: string[]) { return Object.fromEntries(names.map(name => [`set${name[0].toUpperCase()}${name.slice(1)}`, (next: any) => { state[name] = typeof next === "function" ? next(state[name]) : next; }])); }
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("Icon Studio returns idle with its draft, pins and completed comparison intact", () => {
  const state = { busy: false, live: { complete: true }, title: "edited", pinned: ["moon"] };
  const controller = { current: null as AbortController | null }, generation = { current: 0 };
  const s = scope("icon-studio.tsx", "IconStudio", { ...setters(state, ["busy"]), controller, generation, result: { library: { sha256: "fixture" } }, fetch: () => new Promise(() => {}) });
  const setup = s.effect(["generation.current++"]), cleanup = setup();
  state.busy = true; controller.current = new AbortController(); const old = controller.current;
  cleanup(); setup(); expect(old.signal.aborted).toBe(true); expect(state).toEqual({ busy: false, live: { complete: true }, title: "edited", pinned: ["moon"] });
});

test("an Icon Studio answer after hiding cannot finish a tournament or clear replacement busy state", async () => {
  const state: any = { busy: false, progress: 0 }, first = deferred(), second = deferred(); let calls = 0;
  const context: any = { ...setters(state, ["busy", "error", "notice", "progress", "live", "selected", "mode"]), generation: { current: 0 }, controller: { current: null }, getApiKey: () => true, library: {}, icons: [], title: "draft", context: "context", performance: { now: () => 0 }, shards: () => [[]], shardQuestion: () => ({}), finalQuestion: () => ({}), finalists: () => [], run: () => ++calls === 1 ? first.promise : second.promise, result: { library: { sha256: "fixture" } }, fetch: () => new Promise(() => {}) };
  const s = scope("icon-studio.tsx", "IconStudio", context), setup = s.effect(["generation.current++"]), cleanup = setup(), match = s.method("match");
  const old = match(); cleanup(); setup(); const current = match(); first.resolve({ answers: {} }); await old;
  expect(state.busy).toBe(true); expect(state.live).toBeNull(); second.resolve({ answers: {} }); await current;
  expect(state.busy).toBe(false); expect(state.live.status).toBe("complete"); expect(calls).toBe(2);
});

test("Arcade pauses on return, rejects an abort-ignoring move, and allows a fresh move", async () => {
  const state: any = { busy: false, playing: false, local: { status: "playing", tick: 7 }, liveRows: [{ saved: true }], index: 3 };
  const first = deferred(), second = deferred(); let calls = 0;
  const s = scope("arcade.tsx", "Arcade", { ...setters(state, ["busy", "playing", "error", "liveRows", "index", "local"]), busy: false, latest: { current: state.local }, epoch: { current: 0 }, abort: { current: null }, getApiKey: () => true, question: () => ({}), run: () => ++calls === 1 ? first.promise : second.promise, advance: (old: any) => ({ ...old, tick: old.tick + 1 }) });
  const setup = s.effect(["epoch.current++"], true), cleanup = setup(), tick = s.method("tick");
  state.playing = true; const old = tick(); cleanup(); setup(); expect(state.busy).toBe(false); expect(state.playing).toBe(false); expect(state.local.tick).toBe(7); expect(state.index).toBe(3);
  const current = tick(); first.resolve({ answers: { action: { value: "move" } } }); await old;
  expect(state.busy).toBe(true); expect(state.liveRows).toHaveLength(1); second.resolve({ answers: { action: { value: "move" } } }); await current;
  expect(state.local.tick).toBe(8); expect(state.liveRows).toHaveLength(2); expect(state.busy).toBe(false);
});

test("DrawingFraming retains partial pixels and reveal position while a hidden batch becomes inert", async () => {
  const state: any = { busy: false, animating: true, reveal: 128, selected: 91, live: null }, first = deferred(), second = deferred(); let calls = 0;
  const s = scope("outcome-framing.tsx", "DrawingFraming", { ...setters(state, ["busy", "animating", "error", "live"]), generation: { current: 0 }, abort: { current: null }, getApiKey: () => true, method: "membership", c: { id: "crescent" }, target: null, SIZE: 16, drawingPayload: () => ({ state: {}, questions: {} }), intensity: () => 0.5, drawingMetrics: () => ({}), run: () => ++calls === 1 ? first.promise : second.promise });
  s.sandbox.cancel = s.method("cancel"); const setup = s.effect(["generation.current++", "return()=>cancel()"], true), cleanup = setup(), draw = s.method("draw");
  const pending = draw(); first.resolve({ answers: {} }); await flush(); expect(state.live.values).toHaveLength(64);
  state.animating = true; cleanup(); setup(); const kept = structuredClone(state.live); second.resolve({ answers: {} }); await pending;
  expect(state.busy).toBe(false); expect(state.animating).toBe(false); expect(state.live).toEqual(kept); expect(state.reveal).toBe(128); expect(state.selected).toBe(91); expect(calls).toBe(2);
});

test("Games preserves the retained replay step and resets only for a changed episode selection", () => {
  const state: any = { step: 0, playing: true };
  const s = scope("games.tsx", "Games", { ...setters(state, ["step", "playing"]), replaySelection: { current: null }, policy: "jev_memory", env: "fixture", seed: 1 });
  const setup = s.effect(["setStep(0)"]); setup(); state.step = 9; setup(); expect(state.step).toBe(9);
  s.sandbox.seed = 2; setup(); expect(state.step).toBe(0);
  s.effect(["setPlaying(false)"], true)()(); expect(state.playing).toBe(false);
});

test("JudgeBench retains revealed/opened reading and local choice on return, then gates a new case", () => {
  const state: any = {}, memory = new Map([["/chunks/a.json", { pair_id: "a" }], ["/chunks/b.json", { pair_id: "b" }]]);
  const s = scope("judgment-reliability.tsx", "JudgeBench", { ...setters(state, ["pair", "error", "revealed", "opened", "expanded", "swap", "vote"]), readingSelection: { current: null }, pairId: "a", entry: { chunk: "a.json" }, result: { chunk_base: "/chunks" }, memory, readVote: () => ({ stored: true }), location: { href: "https://fixture.invalid/#/judge" }, history: { replaceState() {} } });
  const setup = s.effect(["setPair(null)"]), cleanup = setup(); Object.assign(state, { revealed: true, opened: true, expanded: true, swap: true, vote: { local: "A" } });
  cleanup(); setup(); expect(state).toMatchObject({ revealed: true, opened: true, expanded: true, swap: true, vote: { local: "A" }, pair: { pair_id: "a" } });
  s.sandbox.pairId = "b"; s.sandbox.entry = { chunk: "b.json" }; setup(); expect(state).toMatchObject({ revealed: false, opened: false, expanded: false, swap: false, vote: { stored: true }, pair: { pair_id: "b" } });
});

function cafe() {
  const state: any = { busy: false, preparing: false, draft: "oat milk", scene: { recipe: "saved" }, history: [{ recipe: "older" }] }, response = deferred(); let commits = 0, timerCallback: (() => void) | undefined, cleared = false;
  const s = scope("cafe-jev.tsx", "Beverage", { ...setters(state, ["busy", "preparing", "error", "draft"]), current: { current: { session: 1, revision: 0 } }, request: { current: null }, timer: { current: null }, clearTimeout: () => { cleared = true; }, setTimeout: (callback: () => void) => { timerCallback = callback; return 1; }, scene: { transcript: [{ id: 1, text: "tea" }], inventory: {}, explicit: {} }, draft: "oat milk", getApiKey: () => true, isCurrent: (a: any, b: any) => a.session === b.session && a.revision === b.revision, publicState: (input: any) => input, modelQuestions: () => ({}), run: () => response.promise, interpret: () => ({ preferences: {}, suggested: {}, question: null, errors: [] }), commit: () => { commits++; }, recipe: {}, blockers: [], reducedMotion: false });
  s.sandbox.invalidate = s.method("invalidate");
  return { state, response, s, commits: () => commits, timerCallback: () => timerCallback?.(), cleared: () => cleared };
}

test("Cafe abort-ignoring replies cannot commit after hide/show or clear the preserved draft", async () => {
  const h = cafe(), setup = h.s.effect(["request.current?.abort()", "return () => invalidate()"], true), cleanup = setup();
  const pending = h.s.method("askJev")(); const controller = h.s.sandbox.request.current; cleanup(); setup(); h.response.resolve({ answers: {} }); await pending;
  expect(controller.signal.aborted).toBe(true); expect(h.commits()).toBe(0); expect(h.state).toMatchObject({ busy: false, preparing: false, draft: "oat milk", scene: { recipe: "saved" }, history: [{ recipe: "older" }] });
});

test("Cafe confirmation timer is cancelled and its captured callback cannot confirm after return", () => {
  const h = cafe(); h.s.sandbox.draft = ""; const setup = h.s.effect(["request.current?.abort()", "return () => invalidate()"], true), cleanup = setup();
  h.s.method("confirm")(); expect(h.state.preparing).toBe(true); cleanup(); setup(); h.timerCallback();
  expect(h.cleared()).toBe(true); expect(h.state.preparing).toBe(false); expect(h.commits()).toBe(0); expect(h.state.scene).toEqual({ recipe: "saved" });
});

function wardrobe() {
  const state: any = { busy: false, listening: false, videoStatus: "off", falKey: "fixture-only", text: "edited draft", outfit: { edited: true }, history: [{ kept: true }], recording: { complete: true }, pipeline: { complete: true } };
  const response = deferred(); const actions: string[] = []; let recognitionInstance: any;
  class Speech { onresult: any; onerror: any; onend: any; constructor() { recognitionInstance = this; } start() {} stop() {} abort() { actions.push("recognition-abort"); } }
  const s = scope("wardrobe.tsx", "Wardrobe", { ...setters(state, ["busy", "listening", "videoStatus", "falKey", "text", "transcriptSource", "recording", "pipeline"]), mounted: { current: true }, ticket: { current: { session: 1, revision: 0 } }, request: { current: null }, recognition: { current: null }, speaking: { current: true }, videoEpoch: { current: 0 }, videoSession: { current: null }, media: { current: null }, videoClock: { current: null }, remoteVideo: { current: { srcObject: {}, pause: () => actions.push("remote-pause") } }, playback: { current: { pause: () => actions.push("playback-pause") } }, clearInterval: () => actions.push("clear-clock"), window: { SpeechRecognition: Speech, speechSynthesis: true, addEventListener() {}, removeEventListener() {} }, speechSynthesis: { cancel: () => actions.push("speech-cancel") }, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, fetch: () => new Promise(() => {}), getApiKey: () => true, text: "edited draft", transcriptSource: "typed", outfitRef: { current: state.outfit }, editState: () => ({}), editQuestions: () => ({}), currentTicket: (a: any, b: any) => a.session === b.session && a.revision === b.revision, run: () => response.promise, accept: () => actions.push("accept"), say: () => actions.push("say"), listening: false });
  s.sandbox.invalidate = s.method("invalidate"); s.sandbox.disconnect = s.method("disconnect");
  return { state, response, actions, s, recognition: () => recognitionInstance };
}

test("Wardrobe stops media and speech, clears transient flags, and preserves outfit/draft/evidence", () => {
  const h = wardrobe(), setup = h.s.effect(["mounted.current = true"]), cleanup = setup(), stopRecording = h.s.effect(["const video = playback.current"])(); h.s.method("listen")(); const speech = h.recognition(), lateTranscript = speech.onresult;
  Object.assign(h.state, { busy: true, videoStatus: "live" }); h.s.sandbox.request.current = new AbortController(); const request = h.s.sandbox.request.current;
  h.s.sandbox.videoSession.current = { close: () => h.actions.push("video-close") }; h.s.sandbox.media.current = { getTracks: () => [{ stop: () => h.actions.push("track-stop") }] }; h.s.sandbox.videoClock.current = 1;
  cleanup(); stopRecording(); setup(); lateTranscript({ results: [[{ transcript: "late replacement" }]] });
  expect(request.signal.aborted).toBe(true); expect(h.state).toMatchObject({ busy: false, listening: false, videoStatus: "off", falKey: "", text: "edited draft", outfit: { edited: true }, history: [{ kept: true }], recording: { complete: true }, pipeline: { complete: true } });
  for (const action of ["recognition-abort", "speech-cancel", "playback-pause", "remote-pause", "video-close", "track-stop", "clear-clock"]) expect(h.actions).toContain(action);
  expect(h.s.sandbox.recognition.current).toBeNull(); expect(h.s.sandbox.media.current).toBeNull(); expect(h.s.sandbox.videoSession.current).toBeNull();
});

test("Wardrobe cannot accept an old request after returning or clear its preserved draft", async () => {
  const h = wardrobe(), setup = h.s.effect(["mounted.current = true"]), cleanup = setup(); const pending = h.s.method("submit")(); cleanup(); setup();
  h.response.resolve({ answers: {} }); await pending; expect(h.actions).not.toContain("accept"); expect(h.state.busy).toBe(false); expect(h.state.text).toBe("edited draft");
});

test("Wardrobe pauses and releases the retained video after Activity detaches its DOM ref", () => {
  const h = wardrobe(), cleanup = h.s.effect(["mounted.current = true"])();
  const video = h.s.sandbox.remoteVideo.current;
  h.s.sandbox.remoteVideo.current = null;
  cleanup();
  expect(h.actions).toContain("remote-pause");
  expect(video.srcObject).toBeNull();
});

test("Wardrobe pauses a later-mounted recording even after its DOM ref is detached", () => {
  const h = wardrobe();
  const video = h.s.sandbox.playback.current;
  h.s.sandbox.playback.current = null;
  const setup = h.s.effect(["const video = playback.current"]);
  setup()();
  expect(h.actions).not.toContain("playback-pause");
  h.s.sandbox.playback.current = video;
  const cleanup = setup();
  h.s.sandbox.playback.current = null;
  cleanup();
  expect(h.actions).toContain("playback-pause");
});

test("an old Wardrobe asset load cannot replace completed evidence after effect recreation", async () => {
  const h = wardrobe(), old = deferred(); h.s.sandbox.fetch = () => old.promise;
  const setup = h.s.effect(["mounted.current = true"]), cleanup = setup(); cleanup(); h.s.sandbox.fetch = () => new Promise(() => {}); setup();
  old.resolve({ ok: true, headers: { get: () => "application/json" }, json: async () => ({ obsolete: true }) }); await flush();
  expect(h.state.recording).toEqual({ complete: true }); expect(h.state.pipeline).toEqual({ complete: true });
});

test("a failed Wardrobe asset refresh preserves the completed recording and pipeline", async () => {
  const h = wardrobe(); h.s.sandbox.fetch = async () => ({ ok: false }); h.s.effect(["mounted.current = true"])(); await flush();
  expect(h.state.recording).toEqual({ complete: true }); expect(h.state.pipeline).toEqual({ complete: true });
});

function brush() {
  const response = deferred(); const state: any = { session: initialSession(), keyboardPen: { down: true, x: 10, y: 20 } };
  const s = scope("ghost-brush.tsx", "GhostBrush", { ...setters(state, ["keyboardPen", "keyError"]), session: state.session, inFlight: { current: null }, serial: { current: 0 }, prompt: "quiet blue fabric", getApiKey: () => true, requestFor, lexicalRank, parseRanking: () => lexicalRank("golden dust"), run: () => response.promise });
  s.sandbox.dispatch = (action: any) => { state.session = reduce(state.session, action); s.sandbox.session = state.session; };
  return { state, response, s, dispatch: s.sandbox.dispatch };
}

test("Ghost Brush invalidates its reducer token, keeps the active stroke, and rejects a late answer", async () => {
  const h = brush(); h.dispatch({ type: "begin", point: { x: 10, y: 20, pressure: 0.5 } }); h.dispatch({ type: "move", point: { x: 40, y: 50, pressure: 0.5 } });
  const setup = h.s.effect(["controller.abort()", "pending?.controller.abort()"], true), cleanup = setup(), pending = h.s.method("interpret")("jev"); const oldBrush = h.state.session.brushId;
  cleanup(); setup(); h.response.resolve({ answers: {} }); await pending;
  expect(h.state.session.request).toBeNull(); expect(h.state.session.brushId).toBe(oldBrush); expect(h.state.session.strokes).toHaveLength(1); expect(h.state.session.active).toBeNull(); expect(h.state.keyboardPen.down).toBe(false);
  expect(h.state.session.receipts[0].events.at(-1).status).toBe("discarded"); expect(h.state.session.receipts[0].response).toBeUndefined();
});

test("Ghost Brush preserves and applies a completed queued choice when hiding lifts the pen", () => {
  const h = brush(); h.dispatch({ type: "begin", point: { x: 10, y: 20, pressure: 0.5 } });
  const token = { id: 1, epoch: 1, revision: 1 }, ranking = lexicalRank("golden dust");
  h.dispatch({ type: "request", token, source: "lexical", request: requestFor("golden dust") }); h.dispatch({ type: "resolve", token, ranking, response: { complete: true } });
  const cleanup = h.s.effect(["controller.abort()", "pending?.controller.abort()"], true)(); cleanup();
  expect(h.state.session.strokes).toHaveLength(1); expect(h.state.session.brushId).toBe(ranking[0].id); expect(h.state.session.queued).toBeNull(); expect(h.state.session.receipts[0].response).toEqual({ complete: true }); expect(h.state.session.receipts[0].events.at(-1).status).toBe("applied");
});
