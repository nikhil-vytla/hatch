/**
 * Everything the site publishes under public/, one entry each, in build order. The publication
 * module (publication.ts) writes these, gzips the ones marked `gzip`, refuses any file in public/
 * no entry owns and indexes them all for CI. Scenes name their record in src/scenes.ts; the
 * publication test checks every one of those records is here.
 *
 * Adding a study is usually one entry: a record, plus a `path` with `copy` or `write` when it
 * publishes files of its own. A new `gzip` path also goes in vercel.json's rule; the test says so.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Entry, Projection } from "./publication";
import { availability, banking77, clinc150, judgeBench, priorContentAudit, rewardBench } from "./provenance";
import { projectRewardBenchDocument, splitRewardBench } from "./benchmark-publication";
import { assertPublicationSource } from "../../rewardbench2/publication-source";
import { prepareJudgmentReliability } from "../../judgment-reliability/prepare";
import { preparePublicHarnessEvidence } from "../../roadmap/integration/publication-projection";
import { buildArena } from "../../packages/arena/src/data/build";
import { buildDecide } from "../../packages/arena/src/decide/build";
import { buildDecoy } from "../../packages/arena/prose/decoy-build";
import { buildFool } from "../../packages/arena/src/fool/build";
import { buildSpine } from "../../packages/arena/spine/build";
import { buildEyes } from "../../live-worlds/eyes/build";
import { buildCount } from "../../live-worlds/count/build";
import { buildOpenDecisions } from "../../packages/arena/open-decisions/build";

/** RewardBench 2's published copy withholds four candidate texts; verification compares against the same projection. */
const withheldText: Projection = {
  name: "projectRewardBenchDocument",
  project: projectRewardBenchDocument,
  derivation: assertPublicationSource,
};

const record = (id: string, source: string, more: Partial<Entry["record"] & object> = {}): Entry => ({
  id,
  record: { source, ...more },
});

export const manifest: readonly Entry[] = [
  {
    id: "routing-evidence",
    path: "routing-evidence",
    write: ({ lab, out }) => preparePublicHarnessEvidence(lab, out("routing-evidence")),
  },
  record("adapters", "../results/adapters.jsonl"),
  record("beverage", "../results/beverage.jsonl"),
  record("changes", "results/changes.jsonl"),
  record("classify", "results/classify.jsonl", { steps: [banking77(), clinc150, priorContentAudit("classify")] }),
  record("cloudcheck", "results/cloudcheck.jsonl"),
  record("composed-ui", "results/composed-ui.jsonl"),
  record("decisions", "../results/decisions.jsonl"),
  record("deployment-check", "../results/deployment-check.jsonl"),
  record("evidence-audit", "results/evidence-audit.jsonl"),
  record("games", "../results/games.jsonl"),
  record("history", "../results/history.jsonl"),
  record("index", "../results/index.jsonl"),
  record("journeys", "results/journeys.jsonl"),
  record("judge", "results/judge.jsonl", { steps: [judgeBench, priorContentAudit("judge")] }),
  {
    id: "rewardbench2",
    record: { source: "../rewardbench2/results.jsonl", steps: [rewardBench], projection: withheldText },
    // The page loads a light index and fetches one case's answer texts at a time.
    path: "rewardbench2",
    gzip: true,
    write({ out }) {
      const split = splitRewardBench(JSON.parse(readFileSync(out("data/rewardbench2.json"), "utf8")));
      const dir = out("rewardbench2");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(resolve(dir, "cases"), { recursive: true });
      writeFileSync(resolve(dir, "index.json"), JSON.stringify(split.index) + "\n");
      for (const c of split.cases) writeFileSync(resolve(dir, "cases", c.name), c.body + "\n");
    },
  },
  record("latency", "../results/latency.jsonl"),
  record("logos", "../results/logos.jsonl"),
  record("micro", "../results/micro.jsonl"),
  record("music", "../results/music.jsonl", { steps: [availability] }),
  record("optimize", "../results/optimize.jsonl", { steps: [banking77()] }),
  record("paste", "results/paste.jsonl"),
  record("replica", "../results/replica.jsonl", { steps: [banking77()] }),
  record("robustness", "results/robustness.jsonl", {
    steps: [banking77("BANKING77 requests with authored distractors, reordered choices, repetitions, and prompt-injection variants.")],
  }),
  record("routing", "results/routing.jsonl"),
  record("search", "../results/search.jsonl", { steps: [availability] }),
  record("semantic-table", "results/semantic-table.jsonl"),
  record("ui", "../results/ui.jsonl", { steps: [availability] }),
  record("undo", "results/undo.jsonl"),
  record("verify", "../results/verify.jsonl", { steps: [availability] }),
  record("vision", "../results/vision.jsonl"),
  record("visuals", "results/visuals.jsonl"),
  record("arcade", "../local-models-and-games/arcade/results.jsonl"),
  record("research-map", "../local-models-and-games/research-map.jsonl"),
  record("local-models", "../local-models-and-games/apple/results.jsonl"),
  record("music-v2", "../music-arranger-v2/music-v2.jsonl"),
  record("cafe", "../cafe-jev/cafe.jsonl"),
  {
    id: "judgment-reliability",
    // Builds its record from the committed evidence, with hashed case chunks beside it.
    record: {
      source: "../judgment-reliability/results.jsonl",
      build: { name: "prepareJudgmentReliability", run: ({ out }) => prepareJudgmentReliability(out("judgment-reliability")) },
    },
    path: "judgment-reliability",
    gzip: true,
  },
  record("tetris-framing", "../outcome-framing/tetris.jsonl"),
  record("drawing-framing", "../outcome-framing/drawing.jsonl"),
  {
    id: "outcome-framing",
    path: "outcome-framing",
    gzip: true,
    copy: [{ from: "../outcome-framing/events.jsonl", to: "events.jsonl", record: true }],
  },
  {
    id: "visual-search",
    record: { source: "../visual-search/results.jsonl" },
    path: "visual-search",
    gzip: true,
    copy: [
      { from: "../visual-search/collection.jsonl", to: "collection.jsonl" },
      { from: "../visual-search/events.jsonl", to: "evidence.jsonl", record: true },
    ],
  },
  {
    id: "wardrobe",
    record: { source: "../wardrobe-lab/wardrobe.jsonl" },
    path: "wardrobe",
    copy: [
      { from: "../wardrobe-lab/recording.json", to: "recording.json" },
      { from: "../wardrobe-lab/assets", to: "." },
      { from: "../wardrobe-lab/spoken-recording.json", to: "spoken-recording.json" },
      { from: "../wardrobe-lab/spoken-pipeline.json", to: "spoken-pipeline.json" },
    ],
  },
  {
    id: "icon-studio",
    record: { source: "../icon-studio/results.jsonl" },
    path: "icon-studio",
    gzip: true,
    write({ lab, out }) {
      const build = spawnSync("bun", [resolve(lab, "icon-studio/collection.ts"), out("icon-studio")], { stdio: "inherit" });
      if (build.status !== 0) throw new Error("Icon collection preparation failed.");
    },
    copy: [{ from: "../icon-studio/events.jsonl", to: "evidence.jsonl" }],
  },
  record("live-worlds", "../live-worlds/manifest.jsonl"),
  {
    id: "research",
    path: "research",
    copy: [
      { from: "../README.md", to: "README.md" },
      { from: "../SOURCES.md", to: "SOURCES.md" },
      { from: "../IDEA_GARDEN.md", to: "IDEA_GARDEN.md" },
      { from: "README.md", to: "EXPERIENCE_PROTOTYPES.md" },
      { from: "extension/README.md", to: "COMPANION.md" },
    ],
  },
  // Frozen pages from archived investigations, committed here so the build never reads archive/.
  { id: "quality-review", path: "research/quality-review", committed: true },
  { id: "show-me-realtime", path: "research/show-me-realtime.html", committed: true },
  {
    id: "companion",
    path: "companion.zip",
    // Zip entries carry file times, so the index lists this file without hashing it.
    volatile: ["companion.zip"],
    write({ app, out }) {
      spawnSync("zip", ["-q", "-r", out("companion.zip"), "."], { cwd: resolve(app, "extension") });
    },
  },
  { id: "companion-demo", path: "companion-demo", committed: true },
  { id: "who-said-that", path: "who-said-that", committed: true },
  { id: "capabilities", path: "capabilities.html", committed: true },
  { id: "favicon", path: "favicon.svg", committed: true },
  // The builders below read recordings and public/data, so they run after the records.
  {
    id: "arena",
    path: "arena",
    gzip: true,
    // Its index carries the build time.
    volatile: ["arena/index.json"],
    write: ({ out }) => buildArena(out("arena")),
  },
  { id: "decide", path: "decide", gzip: true, write: ({ lab, out }) => buildDecide(resolve(lab, "packages/arena"), out("decide")) },
  { id: "decoy", path: "decoy", write: ({ lab, out }) => buildDecoy(resolve(lab, "packages/arena/prose"), out("decoy")) },
  { id: "fool", path: "fool", write: ({ lab, out }) => buildFool(resolve(lab, "packages/arena"), out("fool")) },
  { id: "spine", path: "spine", write: ({ lab, out }) => buildSpine(resolve(lab, "packages/arena/spine"), out("spine")) },
  {
    id: "open-decisions",
    path: "open-decisions",
    write: ({ lab, app, out }) => buildOpenDecisions(resolve(lab, "packages/arena"), app, out("open-decisions")),
  },
  {
    id: "ocean",
    // The reef's recorded Jev run, still gzipped: the page decompresses it in the browser.
    path: "ocean",
    copy: [{ from: "../live-worlds/ocean/recordings/jev-heatwave.jsonl.gz", to: "jev-heatwave.jsonl.gz" }],
  },
  // Eyes against state: recorded vision-model Snake runs and the facts lane, after arcade.json.
  { id: "eyes", path: "eyes", write: ({ lab, app, out }) => buildEyes(lab, app, out("eyes")) },
  // Count with me: COCO images, their truths and the three deciders' recorded answers.
  { id: "count", path: "count", write: ({ lab, out }) => buildCount(lab, out("count")) },
];

/**
 * Recordings committed gzipped that no entry reads directly: the judgment-reliability build and
 * the spine builder read them. compress-records.ts refreshes these with the manifest's own.
 */
export const builderRecordings = [
  "judgment-reliability/events.jsonl",
  "judgment-reliability/cases.jsonl",
  "packages/arena/spine/recordings/spine.jsonl",
];
