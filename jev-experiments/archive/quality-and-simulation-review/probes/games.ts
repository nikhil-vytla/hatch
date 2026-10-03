// Read-only evidence probe. Run from repo root with Bun. No browser or model calls.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const result = readRecord(new URL("results/games.jsonl", root)).result;
const episodes = result.episodes;
const observation = (frame: any) => frame?.observation ?? frame?.state ?? result.observations[frame?.state_id];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actions = (episode: any) => episode.trace.filter((frame: any) => frame.action);
const front = (state: any) => state.visible_grid.at(-2)[Math.floor(state.visible_grid[0].length / 2)];
const groups = [...new Set<string>(episodes.map((e: any) => e.env))].flatMap(env =>
  [...new Set<string>(episodes.map((e: any) => e.policy))].map(policy => {
    const rows = episodes.filter((e: any) => e.env === env && e.policy === policy);
    return {
      env, policy, episodes: rows.length,
      wins: rows.filter((e: any) => e.success).length,
      labCutoffs: rows.filter((e: any) => !e.success && !e.errors && e.steps === e.max_steps).length,
      interrupted: rows.filter((e: any) => e.errors).length,
      actionRows: rows.reduce((sum: number, e: any) => sum + actions(e).length, 0),
      cacheHits: rows.flatMap(actions).filter((f: any) => f.cache_hit).length,
      distinctInitialObservations: new Set(rows.map((e: any) => hash(observation(e.trace[0])))).size,
      distinctActionTraces: new Set(rows.map((e: any) => hash(e.trace.map((f: any) => f.action)))).size,
      meanActionsCompletedEpisodes: rows.filter((e: any) => !e.errors).reduce((sum: number, e: any) => sum + actions(e).length, 0) / rows.filter((e: any) => !e.errors).length,
    };
  })
);
const successes = episodes.filter((e: any) => e.success);
const modelActions = episodes.filter((e: any) => e.policy.startsWith("jev")).flatMap(actions);
const interrupted = episodes.filter((e: any) => e.errors).map((e: any) => ({
  env: e.env, policy: e.policy, seed: e.seed, declaredSteps: e.steps,
  actionsTaken: actions(e).length, errorRows: e.trace.filter((f: any) => f.error).length,
  lastError: e.trace.at(-1).error,
}));
const misleadingToggle = episodes.flatMap((e: any) => actions(e).filter((f: any) => f.action === "open_door").map((f: any) => ({
  env: e.env, policy: e.policy, seed: e.seed, step: f.step, front: front(observation(f)), carrying: observation(f).carrying,
}))).filter((f: any) => f.front.includes("open") || !f.carrying);

const source = read("experience-prototypes/src/games.tsx");
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }) })
  .transformSync(source.slice(source.indexOf("export function GameGrid")))
  .replace(/\bexport\s+/g, "");
const slots: any[] = [];
let cursor = 0;
const context: any = {
  h: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
  useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => slots[i] = typeof value === "function" ? value(slots[i]) : value]; },
  useEffect: () => {}, useMemo: (fn: () => unknown) => fn(),
  matchMedia: () => ({ matches: true }),
  motion: { div: "motion.div", span: "motion.span" },
  ...Object.fromEntries(["Play", "Pause", "SkipBack", "SkipForward", "KeyRound", "DoorClosed", "Flag", "ArrowUp", "Pane", "Field", "Button", "Pills", "Stat", "State"].map(name => [name, name])),
};
vm.runInNewContext(code + "\nthis.grid = GameGrid; this.games = Games;", context);
const gridFor = (cell: string) => {
  const grid = Array.from({ length: 7 }, () => Array(7).fill("empty"));
  grid[5][3] = cell;
  return context.grid({ state: { visible_grid: grid } });
};
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const render = () => { cursor = 0; return context.games({ result }); };
let tree = render();
const initialEpisode = nodes(tree).find(n => n.type === "State").props.value;
const traceForDefault = episodes.find((e: any) => e.policy === initialEpisode.episode.policy && e.env === "MiniGrid-DoorKey-5x5-v0" && e.seed === initialEpisode.episode.seed).trace;
nodes(tree).find(n => n.type === "input" && n.props.type === "range").props.onChange({ target: { value: String(traceForDefault.length - 1) } });
tree = render();
const finalInspector = nodes(tree).find(n => n.type === "State").props.value;

const output = {
  method: "Decoded all published episodes. Actual GameGrid/Games functions executed with mocked React elements/hooks; no real browser, environment steps, or model calls. Counts and rendered element equality do not establish visual usability or general planning accuracy.",
  sourceHashes: Object.fromEntries(["experience-prototypes/src/games.tsx", "src/jev_lab/games.py", "results/games.jsonl"].map(path => [path, createHash("sha256").update(read(path)).digest("hex")])),
  counts: { episodes: episodes.length, successes: successes.length, labCutoffs: episodes.filter((e: any) => !e.success && !e.errors && e.steps === e.max_steps).length, interruptions: interrupted.length, traceRows: episodes.reduce((sum: number, e: any) => sum + e.trace.length, 0), observations: result.observations.length, jevActionRows: modelActions.length, jevCacheHits: modelActions.filter((f: any) => f.cache_hit).length, jevCacheShare: modelActions.filter((f: any) => f.cache_hit).length / modelActions.length, publishedMemoizedStates: result.memoized_states },
  groups,
  interrupted,
  terminalEvidence: {
    successesEndingWithForwardIntoVisibleGoal: successes.filter((e: any) => { const f = e.trace.at(-1); return f.action === "forward" && front(observation(f)) === "goal" && f.reward > 0; }).length,
    episodesWithExplicitTerminationField: episodes.filter((e: any) => Object.hasOwn(e, "terminated") || Object.hasOwn(e, "truncated") || Object.hasOwn(e, "stop_reason")).length,
    framesWithPostActionObservation: episodes.flatMap((e: any) => e.trace).filter((f: any) => Object.hasOwn(f, "next_state") || Object.hasOwn(f, "next_observation")).length,
    defaultReplayAtEnd: { policy: finalInspector.episode.policy, seed: finalInspector.episode.seed, success: finalInspector.episode.success, action: finalInspector.action.action, reward: finalInspector.action.reward, frontStillGoal: front(finalInspector.observation) === "goal", inspectorObservationKeys: Object.keys(finalInspector.observation) },
  },
  doorDisplay: { lockedVsOpenElementTreesEqual: hash(gridFor("yellow door locked")) === hash(gridFor("yellow door open")), yellowVsRedElementTreesEqual: hash(gridFor("yellow door locked")) === hash(gridFor("red door locked")) },
  actionSemantics: { openDoorOnAlreadyOpenCount: misleadingToggle.filter((f: any) => f.front.includes("open")).length, openDoorWithoutKeyCount: misleadingToggle.filter((f: any) => !f.carrying).length, examples: misleadingToggle.slice(0, 4) },
  labLimits: { recorded: [...new Set(episodes.map((e: any) => e.max_steps))], nativeMinigrid310: { "MiniGrid-Empty-5x5-v0": 4 * 5 ** 2, "MiniGrid-DoorKey-5x5-v0": 10 * 5 ** 2 }, source: "Installed MiniGrid 3.1.0 env constructors and matching official v3.1.0 source; no new environment execution." },
  transport: result.transport,
};
writeFileSync(new URL("games.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ ...output, transport: undefined }, null, 2));
