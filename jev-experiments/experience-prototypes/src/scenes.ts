/**
 * Every scene on the site, one definition each: what the collection card says, which record the
 * page loads, how the page frames it and how it asks Jev. The home page, the router, the page
 * shell and the headline build read this; scene-views.tsx gives each scene its view. Adding a
 * scene is an entry here and one in scene-views.tsx. The type checker asks for the view, and for
 * the drawer or report text of a game or benchmark report. Plain data, so build scripts can
 * import it without React.
 */

/**
 * How the page shell frames a scene.
 * - `game`: play first, and About & evidence opens a drawer (formats/game-evidence.tsx).
 * - `report`: the view is a report that gives its own data and citation, so there is no record footer.
 * - `article`: the view is an article that frames itself.
 * - `plain`: the view as it is, with the evidence fold and the record footer.
 */
export type Format = "game" | "report" | "article" | "plain";

/** How a scene asks Jev, drawn small on its card: what goes in, and the typed answer that comes out. */
export type Diagram = { readonly from: readonly string[]; readonly to: string };

export type SceneDefinition = {
  id: string;
  title: string;
  category: string;
  description: string;
  question: string;
  /** The published record, /data/<record>.json, that the page loads and offers for download; null when the scene brings its own data. */
  record: string | null;
  /** Where the page fetches the record from instead, when the full record is too heavy to open. */
  loads?: string;
  /** A second record the view receives as `composition`; Download links to it instead. */
  companion?: string;
  format: Format;
  /** Put the headline strip after the scene instead of above it, so play starts first. */
  strip?: "after";
  /** The view shows where its record came from itself, so About leaves the provenance out. */
  ownProvenance?: true;
  diagram: Diagram;
};

const table = [
  {
    id: "paste",
    title: "Smart paste",
    category: "Productivity",
    description: "A whole page copied. Exactly the right thing pasted.",
    question: "Can a decision model match facts to fields and recognize when it needs help?",
    record: "paste",
    format: "plain",
    diagram: { from: ["copied page", "form"], to: "fact per field" },
  },
  {
    id: "ui",
    title: "Generative interfaces",
    category: "Creative tools",
    description: "Build it. Use it. Change your mind.",
    question: "Can Jev assemble and revise a working interface without losing your edits?",
    record: "ui",
    companion: "composed-ui",
    format: "plain",
    diagram: { from: ["request"], to: "layout choices" },
  },
  {
    id: "games",
    title: "Key & door",
    category: "Games & simulations",
    description: "Watch an agent find the key, the door, and the way out.",
    question: "Does remembering what happened help an agent navigate?",
    record: "games",
    format: "game",
    diagram: { from: ["what it sees"], to: "next move" },
  },
  {
    id: "music",
    title: "Music arranger",
    category: "Creative tools",
    description: "One motif, many ways to make it move.",
    question: "Can typed musical decisions become a coherent arrangement?",
    record: "music-v2",
    format: "plain",
    diagram: { from: ["motif"], to: "arrangement" },
  },
  {
    id: "semantic-table",
    title: "Semantic spreadsheet",
    category: "Productivity",
    description: "Ask a question of every row. Inspect every answer.",
    question: "Can semantic columns reduce the work of reviewing messy records?",
    record: "semantic-table",
    format: "plain",
    diagram: { from: ["each row"], to: "yes/no per column" },
  },
  {
    id: "beverage",
    title: "Café Jev",
    category: "Productivity",
    description: "A craving becomes a choice, one useful question at a time.",
    question: "Can we match preferences without inventing menu facts?",
    record: "cafe",
    format: "plain",
    diagram: { from: ["craving"], to: "next question" },
  },
  {
    id: "verify",
    title: "Agent verifier",
    category: "Agents & tooling",
    description: "A completion claim, put under the microscope.",
    question: "Does the trace actually support what the agent says it did?",
    record: "verify",
    format: "plain",
    diagram: { from: ["claim", "trace"], to: "supported?" },
  },
  {
    id: "search",
    title: "Search reranker",
    category: "Agents & tooling",
    description: "Read the evidence behind the search result.",
    question: "Which source actually answers the question?",
    record: "search",
    format: "plain",
    diagram: { from: ["query", "sources"], to: "which answers" },
  },
  {
    id: "classify",
    title: "Intent recognition",
    category: "Benchmarks",
    description: "Actual requests, predicted intents, and the mistakes between.",
    question: "When does Jev beat a simple classifier, and where does it miss?",
    record: "classify",
    format: "report",
    diagram: { from: ["request"], to: "1 of 77 intents" },
  },
  {
    id: "handoff",
    title: "When to ask a person",
    category: "Benchmarks",
    description: "Set how sure Jev must be to act. See the reviews it saves and the mistakes it lets through.",
    question: "When should software act on Jev's answer, and when should it ask a person?",
    record: "classify",
    format: "plain",
    diagram: { from: ["answer", "confidence"], to: "act or ask" },
  },
  {
    id: "decisions-in-ui",
    title: "Decisions in an interface",
    category: "Benchmarks",
    description: "Watch one box turn typing into a card, then set how sure Jev must be before it acts. An article.",
    question: "What do fast, calibrated decisions do inside a real UI?",
    record: "classify",
    format: "article",
    diagram: { from: ["keystrokes", "confidence"], to: "card or ask" },
  },
  {
    id: "open-decisions",
    title: "Open decisions",
    category: "Benchmarks",
    description: "SGLang turns any chat model into a decision model. Small open Qwens, on a laptop, on Jev's benchmarks.",
    question: "How close can a small open model get to Jev when asked the way SGLang asks it?",
    record: null,
    format: "report",
    diagram: { from: ["prompt"], to: "label odds" },
  },
  {
    id: "decoy",
    title: "The decoy",
    category: "Benchmarks",
    description: "Add an option nobody should pick. Watch it change which of the other two Jev prefers.",
    question: "Does an obviously worse option change Jev's choice between two good ones?",
    record: null,
    format: "article",
    diagram: { from: ["A", "B", "A′"], to: "choice" },
  },
  {
    id: "prose",
    title: "What moves a decision model?",
    category: "Benchmarks",
    description: "The same questions asked 78 ways. Rewording barely moves Jev; one kind of sentence does.",
    question: "Which changes to a question move Jev's answer, and which don't?",
    record: null,
    format: "article",
    diagram: { from: ["question", "78 rewordings"], to: "yes/no shift" },
  },
  {
    id: "spine",
    title: "Spine",
    category: "Benchmarks",
    description: "Argue with Jev. It should change its mind for evidence, never for pressure. Push it and watch the needle.",
    question: "Does Jev hold its answer against pressure, and still update when the facts change?",
    record: null,
    format: "game",
    diagram: { from: ["claim", "your push"], to: "hold or update" },
  },
  {
    id: "judge",
    title: "JudgeBench",
    category: "Benchmarks",
    description: "Read both answers. Compare order, repeats and scoring methods.",
    question: "How reliable are Jev's judgments across the full JudgeBench dataset?",
    record: "judgment-reliability",
    format: "report",
    diagram: { from: ["answer A", "answer B"], to: "which is better" },
  },
  {
    id: "rewardbench2",
    title: "RewardBench 2",
    category: "Benchmarks",
    description: "Jev scores supplied answers without seeing their preference labels.",
    question: "Can Jev recognize the preferred answers across six kinds of judgment?",
    record: "rewardbench2",
    // The full record holds every case's answer texts; the page opens a light index and fetches one case at a time.
    loads: "/rewardbench2/index.json",
    format: "report",
    diagram: { from: ["prompt", "answer"], to: "preferred?" },
  },
  {
    id: "eyes",
    title: "Eyes against state",
    category: "Games & simulations",
    description: "The same Snake game played from a screenshot and from the game's facts. See what seeing costs.",
    question: "What does it cost a decision model to look at the screen instead of reading the state?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["screenshot", "or facts"], to: "next move" },
  },
  {
    id: "count",
    title: "Count with me",
    category: "Games & simulations",
    description: "Guess how many are in the photo, then see a vision model, a detector and Jev try. The crowds get bigger.",
    question: "How well do models count, and where does it break as the crowd grows?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["photo", "or its boxes"], to: "how many" },
  },
  {
    id: "snake",
    title: "Arcade: Snake and Orbital rescue",
    category: "Games & simulations",
    description: "Two small games, played move by move by Jev and by a greedy rule.",
    question: "Does Jev do anything in these games that a greedy rule can't?",
    record: "arcade",
    format: "game",
    diagram: { from: ["board"], to: "next move" },
  },
  {
    id: "local-models",
    title: "Decision models on a Mac",
    category: "Training & local",
    description: "Train small typed readouts, measure transfer, and inspect the exports.",
    question: "Where do small local decision models work, and where do they fail?",
    record: "local-models",
    format: "report",
    ownProvenance: true,
    diagram: { from: ["state"], to: "typed answers" },
  },
  {
    id: "answer-key",
    title: "Who wrote the answer key?",
    category: "Benchmarks",
    description: "The same answers, graded against different references. Watch the ranking move.",
    question: "How much does a leaderboard depend on who wrote the answers?",
    record: "local-models",
    format: "report",
    diagram: { from: ["5 models' answers"], to: "whose key?" },
  },
  {
    id: "tetris",
    title: "Tetris: play and branch",
    category: "Games & simulations",
    description: "Gravity keeps going. Take control, rewind, and try another future.",
    question: "What changes when Jev chooses actions, landings or a plan?",
    record: "tetris-framing",
    format: "game",
    diagram: { from: ["board"], to: "landing" },
  },
  {
    id: "drawing-framing",
    title: "Pixel questions",
    category: "Creative tools",
    description: "One canvas, four ways to ask what belongs there.",
    question: "How do intensity, membership, formulas and sequential context change a drawing?",
    record: "drawing-framing",
    format: "plain",
    diagram: { from: ["canvas"], to: "pixel or shape" },
  },
  {
    id: "visual-search",
    title: "The visual archive",
    category: "Creative tools",
    description: "Search 208 open-access artworks from the Cleveland Museum of Art by subject, mood and detail.",
    question: "What can Jev find through museum metadata and captions?",
    record: "visual-search",
    format: "plain",
    diagram: { from: ["query", "artwork"], to: "relevance" },
  },
  {
    id: "wardrobe",
    title: "A change of clothes",
    category: "Creative tools",
    description: "A spoken edit becomes a wardrobe choice, then a moving image.",
    question: "Can small semantic decisions keep a video try-on coherent across edits?",
    record: "wardrobe",
    format: "plain",
    diagram: { from: ["spoken edit"], to: "outfit" },
  },
  {
    id: "icon-studio",
    title: "A symbol for an idea",
    category: "Creative tools",
    description: "Find an icon by meaning, then try it in a real interface.",
    question: "Can Jev choose a useful visual metaphor from 1,703 library icons?",
    record: "icon-studio",
    format: "plain",
    diagram: { from: ["idea"], to: "1 of 1,703 icons" },
  },
  {
    id: "rumour-mill",
    title: "The rumour mill",
    category: "Games & simulations",
    description: "Pin a rumour on one street. Watch 4,000 neighbours pass it on, or argue it down.",
    question: "How far does one sentence travel when everyone decides for themselves?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["rumour", "resident"], to: "share or argue" },
  },
  {
    id: "win-over",
    title: "Who can you win over?",
    category: "Games & simulations",
    description: "You're new in town with until 5 pm. Say anything; 48 residents judge it, and gossip does the rest.",
    question: "Can fast typed judgments make a town react to what you actually say?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["your line", "listener"], to: "intent · mood · move" },
  },
  {
    id: "ocean",
    title: "The reef",
    category: "Games & simulations",
    description: "120 fish, each deciding for itself. Heat the water and see who makes it.",
    question: "Does how fast a model decides change who survives?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["fish's view"], to: "next move" },
  },
  {
    id: "screen-sentry",
    title: "Screen sentry",
    category: "Agents & tooling",
    description: "Plant traps in a web page. A sentry checks every block so your AI helper finishes the job without being hijacked.",
    question: "Can a fast check on every block of a page stop an AI helper from following hidden instructions?",
    record: null,
    format: "game",
    strip: "after",
    diagram: { from: ["page block"], to: "hijack risk" },
  },
  {
    id: "who-said-that",
    title: "Who said that?",
    category: "Games & simulations",
    description: "Real meetings, real voices. Watch every line find its speaker, its conversation and its topic.",
    question: "Can typed decisions over voice, level and words sort a room into speakers and conversations, and show why?",
    record: null,
    format: "game",
    diagram: { from: ["a line", "lines before"], to: "continues · replies" },
  },
  {
    id: "ghost-brush",
    title: "Ghost Brush",
    category: "Creative tools",
    description: "Draw a gesture. Give it a feeling. Follow another line.",
    question: "Can a typed style judgment turn a procedural brush into a semantic instrument?",
    record: "live-worlds",
    format: "plain",
    diagram: { from: ["gesture", "feeling"], to: "brush style" },
  },
] as const satisfies readonly SceneDefinition[];

type Entry = (typeof table)[number];

/** A live scene's id. */
export type SceneId = Entry["id"];

/** The ids of the scenes in a format, so a format's per-scene text can be required for each of them. */
export type SceneIdIn<F extends Format> = Extract<Entry, { format: F }>["id"];

export type Scene = SceneDefinition & { id: SceneId };

/** The live scenes, in the collection's order. */
export const scenes: readonly Scene[] = table;

export const categories = [
  "All",
  "Productivity",
  "Creative tools",
  "Games & simulations",
  "Agents & tooling",
  "Benchmarks",
  "Training & local",
];

const byId = new Map<string, Scene>(scenes.map((s) => [s.id, s]));

/** The live scene with this id, if there is one. */
export const liveScene = (id: string): Scene | undefined => byId.get(id);

/** The live scene with this id, else the first one, for titles on routes that may be stale. */
export const lookup = (id: string): Scene => byId.get(id) ?? scenes[0];

/**
 * Scenes taken out of the catalog in the 29 Sep 2026 review. Old links land on a notice that
 * says why and where to go; each scene's recorded run stays published for download.
 */
export type Retired = {
  title: string;
  reason: string;
  /** The published record to download; absent when the scene never had one. */
  record?: string;
  /** When it left the catalog, if not in the 29 Sep 2026 review. */
  retiredOn?: string;
  instead?: { href: string; label: string };
};

export const retired: Record<string, Retired> = {
  routing: {
    title: "Model Routing Lab",
    reason: "Its sliders moved configured quality, price and latency values, not measured ones, so it could not show what routing on Jev's labels actually buys. The note keeps the recorded comparison.",
    record: "routing",
    retiredOn: "2 Oct 2026",
    instead: { href: "#/notes/four-classifiers-one-route", label: "Four classifiers, one route" },
  },
  crowd: {
    title: "The square at five",
    reason: "Twelve residents decided only when you posted a notice, and most kept their plans. Its free in-browser model now runs a town that judges everything you say.",
    record: "live-worlds",
    retiredOn: "30 Sep 2026",
    instead: { href: "#experiment/win-over", label: "Who can you win over?" },
  },
  materials: {
    title: "Material sandbox",
    reason: "It opened paused, and Jev's part was one recorded rule behind a tab. The home page now leads with a toy where you work against Jev directly.",
    retiredOn: "30 Sep 2026",
    instead: { href: "#/", label: "Fool Jev" },
  },
  worlds: {
    title: "Living scenes",
    reason: "The renders rarely matched their briefs and nothing measured them. Who can you win over? is the living world now.",
    record: "visuals",
    instead: { href: "#experiment/win-over", label: "Who can you win over?" },
  },
  pixels: {
    title: "Pixel studio",
    reason: "It named a comparison with independent pixel choices but never showed it, and Jev only toggled library objects.",
    record: "visuals",
    instead: { href: "#experiment/drawing-framing", label: "Pixel questions" },
  },
  logos: {
    title: "Logo studio",
    reason: "A smaller version of the icon search that showed one of five recorded briefs.",
    record: "logos",
    instead: { href: "#experiment/icon-studio", label: "A symbol for an idea" },
  },
  decisions: {
    title: "Preference explorer",
    reason: "Jev gave twelve fixed scores and the rest was arithmetic; Decide asks for choices blind, with votes and baselines.",
    record: "decisions",
    instead: { href: "#/decide", label: "Decide" },
  },
  micro: {
    title: "Micro-agent team",
    reason: "Two recorded examples, and the search half of the pipeline was never shown working.",
    record: "micro",
    instead: { href: "#experiment/beverage", label: "Café Jev" },
  },
  vision: {
    title: "Vision to action",
    reason: "A single recorded example over an outdated screenshot of this site.",
    record: "vision",
  },
  latency: {
    title: "Batching & latency",
    reason: "Its p95 times measured the gateway's rate-limit retries (about 10 s), not the cost of batching questions.",
    record: "latency",
  },
  adapters: {
    title: "Typed schema adapters",
    reason: "One recorded call and a static code sample.",
    record: "adapters",
    instead: { href: "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/adapters", label: "The adapters' source" },
  },
  "benchmark-atlas": {
    title: "The next experiments",
    reason: "A list of plans, several of them since built; the roadmap keeps it current.",
    record: "research-map",
    instead: { href: "https://github.com/nikhil-vytla/hatch/blob/main/jev-experiments/roadmap/MAP.md", label: "The roadmap" },
  },
  journeys: {
    title: "Adaptive forms",
    reason: "The same menu and states as Café Jev, which asks its questions better.",
    record: "journeys",
    instead: { href: "#experiment/beverage", label: "Café Jev" },
  },
  context: {
    title: "Context filter",
    reason: "Its allowance slider changed nothing on the recorded cases; the search reranker shows the same judgments.",
    record: "search",
    instead: { href: "#experiment/search", label: "Search reranker" },
  },
  teach: {
    title: "Active labeling",
    reason:
      "A small template fixture where the labels were trivially right; neither sampling method helped. It trained a classifier on Jev's labels, which TypeSafe's terms forbid, so its code and record were removed on 1 Oct 2026.",
  },
  robustness: {
    title: "Decision stability",
    reason: "Merged into Intent recognition, which now shows how often each change flips the answer.",
    record: "robustness",
    instead: { href: "#experiment/classify", label: "Intent recognition · Stability" },
  },
  optimize: {
    title: "Prompt evolution",
    reason: "Merged into Intent recognition: no search method beat the unchanged prompt on the held-out cases.",
    record: "optimize",
    instead: { href: "#experiment/classify", label: "Intent recognition · Prompt search" },
  },
  replica: {
    title: "SmolLM decision model",
    reason: "Folded into Decision models on a Mac as an earlier pilot; it trained on dataset labels, not Jev's answers.",
    record: "replica",
    instead: { href: "#experiment/local-models", label: "Decision models on a Mac" },
  },
  orbital: {
    title: "Orbital rescue",
    reason: "Now a tab in the Arcade scene beside Snake; Jev chose the greedy rule's move on nearly every step.",
    record: "arcade",
    instead: { href: "#experiment/snake", label: "Arcade: Snake and Orbital rescue" },
  },
  undo: {
    title: "Intent-based undo",
    reason: "Now a tab in the Semantic spreadsheet scene, beside the other one-request judgments.",
    record: "undo",
    instead: { href: "#experiment/semantic-table", label: "Semantic spreadsheet · Intent-based undo" },
  },
  changes: {
    title: "Change impact",
    reason: "Now a tab in the Semantic spreadsheet scene, re-recorded without the answer key in Jev's input.",
    record: "changes",
    instead: { href: "#experiment/semantic-table", label: "Semantic spreadsheet · Change impact" },
  },
  reward: {
    title: "Learning from rewards",
    reason:
      "An interesting reward-versus-accuracy shape on a fixture too small to stand alone. It trained a policy on Jev's rewards, which TypeSafe's terms forbid, so its code and record were removed on 1 Oct 2026.",
  },
};

export const retiredScene = (id: string): Retired | undefined => (Object.hasOwn(retired, id) ? retired[id] : undefined);
