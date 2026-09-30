export type Experiment = {
  id: string;
  data: string;
  title: string;
  category: string;
  description: string;
  question: string;
  accent: string;
  kind: string;
};
const e = (
  id: string,
  data: string,
  title: string,
  category: string,
  description: string,
  question: string,
  kind = id,
): Experiment => ({
  id,
  data,
  title,
  category,
  description,
  question,
  kind,
  accent:
    category === "Creative tools"
      ? "coral"
      : category === "Agents & tooling"
        ? "sage"
        : category === "Training & local"
          ? "blue"
          : "gold",
});
export const experiments = [
  e("materials", "", "Material sandbox", "Games & simulations", "Paint a world. Rewrite one material. Preserve another future.", "Can a typed rule make an instruction visible in a local simulation?"),
  e(
    "paste",
    "paste",
    "Smart paste",
    "Productivity",
    "A whole page copied. Exactly the right thing pasted.",
    "Can a decision model match facts to fields and recognize when it needs help?",
  ),
  e(
    "ui",
    "ui",
    "Generative interfaces",
    "Creative tools",
    "Build it. Use it. Change your mind.",
    "Can Jev assemble and revise a working interface without losing your edits?",
  ),
  e(
    "games",
    "games",
    "Key & door",
    "Games & simulations",
    "Watch an agent find the key, the door, and the way out.",
    "Does remembering what happened help an agent navigate?",
  ),
  e(
    "music",
    "music-v2",
    "Music arranger",
    "Creative tools",
    "One motif, many ways to make it move.",
    "Can typed musical decisions become a coherent arrangement?",
  ),
  e(
    "semantic-table",
    "semantic-table",
    "Semantic spreadsheet",
    "Productivity",
    "Ask a question of every row. Inspect every answer.",
    "Can semantic columns reduce the work of reviewing messy records?",
  ),
  e(
    "beverage",
    "cafe",
    "Café Jev",
    "Productivity",
    "A craving becomes a choice, one useful question at a time.",
    "Can we match preferences without inventing menu facts?",
  ),
  e(
    "routing",
    "routing",
    "Model Routing Lab",
    "Agents & tooling",
    "Inspect a route, set your preferences, and delegate a bounded task.",
    "Can task classification improve model selection under fixed permissions and spending limits?",
  ),
  e(
    "verify",
    "verify",
    "Agent verifier",
    "Agents & tooling",
    "A completion claim, put under the microscope.",
    "Does the trace actually support what the agent says it did?",
  ),
  e(
    "search",
    "search",
    "Search reranker",
    "Agents & tooling",
    "Read the evidence behind the search result.",
    "Which source actually answers the question?",
  ),
  e(
    "classify",
    "classify",
    "Intent recognition",
    "Benchmarks",
    "Actual requests, predicted intents, and the mistakes between.",
    "When does Jev beat a simple classifier, and where does it miss?",
  ),
  e(
    "handoff",
    "classify",
    "When to ask a person",
    "Benchmarks",
    "Set how sure Jev must be to act. See the reviews it saves and the mistakes it lets through.",
    "When should software act on Jev's answer, and when should it ask a person?",
  ),
  e(
    "judge",
    "judgment-reliability",
    "JudgeBench",
    "Benchmarks",
    "Read both answers. Compare order, repeats and scoring methods.",
    "How reliable are Jev's judgments across the full JudgeBench dataset?",
  ),
  e(
    "rewardbench2",
    "rewardbench2",
    "RewardBench 2",
    "Benchmarks",
    "Jev scores supplied answers without seeing their preference labels.",
    "Can Jev recognize the preferred answers across six kinds of judgment?",
  ),
  e(
    "snake",
    "arcade",
    "Arcade: Snake and Orbital rescue",
    "Games & simulations",
    "Two small games, played move by move by Jev and by a greedy rule.",
    "Does Jev do anything in these games that a greedy rule can't?",
  ),
  e(
    "local-models",
    "local-models",
    "Decision models on a Mac",
    "Training & local",
    "Train small typed readouts, measure transfer, and inspect the exports.",
    "Where do small local decision models work, and where do they fail?",
  ),
  e("tetris", "tetris-framing", "Tetris: play and branch", "Games & simulations", "Gravity keeps going. Take control, rewind, and try another future.", "What changes when Jev chooses actions, landings or a plan?"),
  e("drawing-framing", "drawing-framing", "Pixel questions", "Creative tools", "One canvas, four ways to ask what belongs there.", "How do intensity, membership, formulas and sequential context change a drawing?"),
  e("visual-search", "visual-search", "The visual archive", "Creative tools", "Search 204 public-domain artworks by subject, mood and detail.", "What can Jev find through museum metadata and captions?"),
  e("wardrobe", "wardrobe", "A change of clothes", "Creative tools", "A spoken edit becomes a wardrobe choice, then a moving image.", "Can small semantic decisions keep a video try-on coherent across edits?"),
  e("icon-studio", "icon-studio", "A symbol for an idea", "Creative tools", "Find an icon by meaning, then try it in a real interface.", "Can Jev choose a useful visual metaphor from 1,703 library icons?"),
  e("crowd", "live-worlds", "The square at five", "Games & simulations", "A small town keeps moving while its residents make up their minds.", "Can a sentence change many independent decisions in a living world?"),
  e("ghost-brush", "live-worlds", "Ghost Brush", "Creative tools", "Draw a gesture. Give it a feeling. Follow another line.", "Can a typed style judgment turn a procedural brush into a semantic instrument?"),
];
export const categories = [
  "All",
  "Productivity",
  "Creative tools",
  "Games & simulations",
  "Agents & tooling",
  "Benchmarks",
  "Training & local",
];
export const lookup = (id: string) =>
  experiments.find((e) => e.id === id) ?? experiments[0];

/**
 * Scenes taken out of the catalog in the 29 Sep 2026 review. Old links land on a notice that
 * says why and where to go; each scene's recorded run stays published for download.
 */
export type Retired = { title: string; reason: string; record: string; instead?: { href: string; label: string } };

export const retired: Record<string, Retired> = {
  worlds: {
    title: "Living scenes",
    reason: "The renders rarely matched their briefs and nothing measured them; the square at five does living worlds better.",
    record: "visuals",
    instead: { href: "#experiment/crowd", label: "The square at five" },
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
    reason: "A small template fixture where the labels were trivially right; neither sampling method helped.",
    record: "teach",
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
    reason: "An interesting reward-versus-accuracy shape on a fixture too small to stand alone.",
    record: "reward",
  },
};

export const retiredScene = (id: string): Retired | undefined => (Object.hasOwn(retired, id) ? retired[id] : undefined);
