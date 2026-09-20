export type Experiment = {
  id: string;
  data: string;
  title: string;
  category: string;
  description: string;
  hypothesis: string;
  measure: string;
  live?: string;
  glyph: string;
};
export const experiments: Experiment[] = [
  {
    id: "worlds",
    data: "visuals",
    title: "Living worlds",
    category: "Create",
    description: "A sentence becomes a moving, procedural scene.",
    hypothesis: "Can independent judgments coordinate a coherent visual world?",
    measure:
      "Renderable scene rate; human visual preference remains unmeasured.",
    live: "scene",
    glyph: "world",
  },
  {
    id: "pixels",
    data: "visuals",
    title: "Pixels in parallel",
    category: "Create",
    description: "Every pixel is a question. The picture is their answer.",
    hypothesis:
      "Can independent color choices produce recognizable tiny images?",
    measure:
      "Inspect all 64 distributions. Pixel independence can break global shape.",
    live: "pixel",
    glyph: "pixels",
  },
  {
    id: "ui",
    data: "ui",
    title: "Interfaces by intent",
    category: "Create",
    description: "Choose a layout, fields, density, and visual emphasis.",
    hypothesis: "Can a fixed component vocabulary express what a user needs?",
    measure: "Authored layout targets and layout stability after a revision.",
    live: "ui",
    glyph: "ui",
  },
  {
    id: "logos",
    data: "logos",
    title: "A mark, many ways",
    category: "Create",
    description: "A small design grammar becomes an editable identity.",
    hypothesis: "Can semantic choices guide a useful vector design space?",
    measure:
      "Valid SVG composition; aesthetic preference has no automated oracle.",
    live: "logo",
    glyph: "logo",
  },
  {
    id: "music",
    data: "music",
    title: "Eight notes",
    category: "Create",
    description: "Mood becomes scale, rhythm, and a playable melody.",
    hypothesis:
      "What does a classifier sound like when code gives it an instrument?",
    measure:
      "Valid pitches and durations. Musical quality needs listener ratings.",
    live: "music",
    glyph: "music",
  },
  {
    id: "beverage",
    data: "beverage",
    title: "Find my drink",
    category: "Decide",
    description: "Turn a vague craving into an order worth confirming.",
    hypothesis: "Can typed choices resolve several preferences together?",
    measure: "Accuracy against a fictional menu, plus ambiguous requests.",
    live: "beverage",
    glyph: "drink",
  },
  {
    id: "journeys",
    data: "beverage",
    title: "Adaptive journeys",
    category: "Create",
    description: "The next screen depends on what the user still needs.",
    hypothesis: "Can a small decision model guide a bounded user flow?",
    measure: "Inspect clarify, temperature, dairy, and workflow judgments.",
    live: "beverage",
    glyph: "flow",
  },
  {
    id: "decisions",
    data: "decisions",
    title: "Decisions you can adjust",
    category: "Decide",
    description: "Ask for evidence once. Change priorities instantly.",
    hypothesis: "Can separate judgments make subjective tradeoffs inspectable?",
    measure:
      "Weighted utility, Pareto dominance, and an uncertainty heuristic.",
    live: "decision",
    glyph: "balance",
  },
  {
    id: "games",
    data: "games",
    title: "A tiny world to navigate",
    category: "Agents",
    description: "Reactive and memory-assisted policies meet MiniGrid.",
    hypothesis:
      "How far can a bounded semantic policy go with partial observations?",
    measure: "Seed-matched success, steps, invalid moves, and failures.",
    glyph: "game",
  },
  {
    id: "routing",
    data: "routing",
    title: "The right model for the job",
    category: "Agents",
    description:
      "Route user intent to a small model, a tool, or deeper reasoning.",
    hypothesis: "Can cheap routing avoid unnecessary expensive calls?",
    measure:
      "Authored route accuracy. Downstream success is a separate question.",
    live: "routing",
    glyph: "flow",
  },
  {
    id: "verify",
    data: "verify",
    title: "Did the agent finish?",
    category: "Agents",
    description: "Compare a completion claim with the visible evidence.",
    hypothesis:
      "Can an independent check catch missing verification and scope violations?",
    measure: "Five independent trace templates; repetitions are disclosed.",
    live: "verify",
    glyph: "check",
  },
  {
    id: "search",
    data: "search",
    title: "Find the useful passage",
    category: "Agents",
    description:
      "Select a source and keep the evidence that answers the question.",
    hypothesis: "Can many small relevance judgments improve retrieval?",
    measure: "Known-source selection and gold evidence retention.",
    live: "search",
    glyph: "search",
  },
  {
    id: "context",
    data: "search",
    title: "Keep the context useful",
    category: "Agents",
    description:
      "Filter irrelevant tool output before it reaches the next model.",
    hypothesis: "How much can we remove without losing the answer?",
    measure:
      "Characters retained, evidence recall, and an injected distraction.",
    live: "search",
    glyph: "filter",
  },
  {
    id: "micro",
    data: "micro",
    title: "One very small agent",
    category: "Agents",
    description: "Route, use one bounded tool, then check the answer.",
    hypothesis: "Can a few typed decisions carry a complete tiny workflow?",
    measure: "Visible tool trace and support judgment. No external actions.",
    glyph: "flow",
  },
  {
    id: "classify",
    data: "classify",
    title: "The classification bench",
    category: "Measure",
    description: "Banking77 and CLINC150, with a local baseline.",
    hypothesis: "Where does Jev add value over a trained TF-IDF classifier?",
    measure:
      "Accuracy, macro F1, Brier score, calibration, and paired intervals.",
    glyph: "bars",
  },
  {
    id: "judge",
    data: "judge",
    title: "A judge on the witness stand",
    category: "Measure",
    description: "JudgeBench pairs with independently established labels.",
    hypothesis: "Does the judge choose correctness over presentation?",
    measure: "Pairwise accuracy, atomic checks, and swapped answer order.",
    glyph: "balance",
  },
  {
    id: "robustness",
    data: "robustness",
    title: "Same meaning, new wrapper",
    category: "Measure",
    description:
      "Reorder options, add noise, repeat, and inject a distraction.",
    hypothesis: "Which changes alter a decision that should stay the same?",
    measure: "Paired fixture variants; attacks are reported separately.",
    glyph: "pixels",
  },
  {
    id: "latency",
    data: "latency",
    title: "The economics of many questions",
    category: "Measure",
    description: "Vary state size and the number of parallel judgments.",
    hypothesis: "How does end-to-end latency scale with question count?",
    measure: "p50, p95, request failures, and actual gateway cost metadata.",
    glyph: "bars",
  },
  {
    id: "optimize",
    data: "optimize",
    title: "Jev improves Jev",
    category: "Train",
    description: "GEPA, OPRO, hill climbing, and random prompt search.",
    hypothesis:
      "Does reflection beat simple search at the same evaluation budget?",
    measure:
      "Validation-only optimization, followed by frozen held-out evaluation.",
    glyph: "curve",
  },
  {
    id: "teach",
    data: "teach",
    title: "A teacher that fits in your pocket",
    category: "Train",
    description: "Label examples, then train a small local classifier.",
    hypothesis: "Can uncertainty-based acquisition buy better labels?",
    measure:
      "Equal label budgets, teacher agreement, and independent test accuracy.",
    glyph: "dots",
  },
  {
    id: "reward",
    data: "reward",
    title: "A reward becomes a policy",
    category: "Train",
    description: "Jev rewards train actual local policy weights.",
    hypothesis:
      "Does optimizing a semantic reward improve independently checked behavior?",
    measure:
      "Teacher reward versus oracle accuracy, with real gradient updates.",
    glyph: "curve",
  },
  {
    id: "replica",
    data: "replica",
    title: "A different kind of Kev",
    category: "Train",
    description: "Transfer shared-prefix decisions to SmolLM2-360M.",
    hypothesis:
      "Does Kev’s decision architecture travel to another small backbone?",
    measure:
      "Before/after held-out accuracy and packed-versus-separate agreement.",
    glyph: "branch",
  },
  {
    id: "language",
    data: "language",
    title: "A writer and an editor",
    category: "Compose",
    description: "A local language model writes; Jev selects and steers.",
    hypothesis: "Can a cheap judge make a local writer more useful?",
    measure:
      "Candidate preference plus official IFEval checks when run locally.",
    live: "language",
    glyph: "text",
  },
  {
    id: "vision",
    data: "vision",
    title: "Eyes, then judgment",
    category: "Compose",
    description: "A local vision model describes an image for text-only Jev.",
    hypothesis:
      "Can perception and decisions be separated without losing evidence?",
    measure:
      "Inspect the intermediate caption. Errors can come from either model.",
    live: "vision",
    glyph: "eye",
  },
  {
    id: "adapters",
    data: "adapters",
    title: "A schema that makes decisions",
    category: "Compose",
    description: "Pydantic, Zod, Serde/Schemars, and Go typed adapters.",
    hypothesis:
      "Can the same semantic contract work naturally across languages?",
    measure:
      "Schema compilation, validation, retained distributions, and rejection tests.",
    live: "adapter",
    glyph: "code",
  },
];
export const categories = [
  "All experiments",
  "Create",
  "Decide",
  "Agents",
  "Measure",
  "Train",
  "Compose",
];
export const ideaGarden = [
  [
    "Semantic operating system",
    "Thousands of cheap watchers notice changed assumptions, stale evidence, and newly relevant tasks. A larger model wakes only when a watcher has a reason.",
  ],
  [
    "A world that listens",
    "A local simulation exposes a vocabulary of weather, ecology, and character intentions. Jev turns visitor language into small state changes every frame budget allows.",
  ],
  [
    "Adaptive accessibility",
    "Classify the current task and missing context, then choose a simpler navigation path, a different explanation, or a smaller form. The user stays in control.",
  ],
  [
    "A personal evidence firewall",
    "Tag every incoming claim with its source, relevance, and uncertainty. Preserve provenance in code; let a slower model investigate consequential disagreements.",
  ],
  [
    "Taste as a trainable object",
    "Use explicit human comparisons to audit Jev’s initial rewards. Train a local taste model that learns where the human and the generic judge disagree.",
  ],
  [
    "A reversible interface laboratory",
    "Generate a constrained set of workflows, simulate known user goals through each, then use human completion time to select what actually works.",
  ],
  [
    "A swarm of skeptical readers",
    "Ask hundreds of separate questions of a proposal: hidden assumptions, missing groups, conflicting constraints. Cluster their evidence before a reasoning model synthesizes it.",
  ],
  [
    "Music with a semantic conductor",
    "A local synthesizer handles sound. Jev continuously chooses tension, density, and phrase direction from a story, while a human controls harmony and timing.",
  ],
];
