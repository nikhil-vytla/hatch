/**
 * The arena's published data: one small index describing every benchmark card,
 * with headline results and their uncertainty, plus lazily loaded chunks.
 * Built by data/build.ts from the recordings; parsed by the site at the boundary.
 */
import { z } from "zod";

const id = z.string().min(1);

export const swatchSchema = z.object({ light: z.string(), dark: z.string() });

export const metricSchema = z.object({
  id,
  label: z.string(),
  unit: z.enum(["%", "ms", "s", "lines", "pieces", "count", ""]),
  better: z.enum(["higher", "lower"]),
  axis: z.enum(["accuracy", "calibration", "speed", "cost", "robustness", "outcome"]),
  /** One sentence: what the number means and how it was measured. */
  help: z.string(),
  /** A fixed scale shared by every contestant, so bars stay put when the lineup changes. */
  domain: z.tuple([z.number(), z.number()]).optional(),
  /** Timing metrics do not apply to code players and are omitted for them. */
  timing: z.boolean().optional(),
});

/**
 * A value with its spread. Judgement sets carry a 95% case-bootstrap interval;
 * games with a handful of seeds carry one value per seed instead of an interval.
 */
export const estimateSchema = z.object({
  value: z.number(),
  n: z.number(),
  lo: z.number().optional(),
  hi: z.number().optional(),
  perItem: z.array(z.object({ item: z.string(), value: z.number() })).optional(),
  method: z.enum(["bootstrap-case", "per-seed", "count", "none"]),
  /** Share of the n items this contestant actually covers, when partial. */
  coverage: z.object({ covered: z.number(), of: z.number() }).optional(),
});

export const contestantSchema = z.object({
  id,
  name: z.string(),
  short: z.string(),
  kind: z.enum(["hosted", "local", "code"]),
  /** The model behind it, e.g. "typesafe-ai/jev"; absent for code players. */
  model: z.string().optional(),
  /** How it is asked or how it plays, e.g. "judge each spot". */
  policy: z.string().optional(),
  color: swatchSchema,
  default: z.boolean(),
  runSets: z.array(id),
});

export const runSetSchema = z.object({
  id,
  label: z.string(),
  recordedAt: z.string(),
  source: z.enum(["recorded", "computed"]),
  /** Canonical protocol; runs are comparable only when these hashes match. */
  protocol: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  protocolHash: z.string(),
  standing: z.enum(["valid", "availability-only"]),
  files: z.array(z.string()),
  note: z.string().optional(),
});

const byContestant = z.record(z.string(), z.record(z.string(), estimateSchema));

export const lensSchema = z.enum([
  "table",
  "bars",
  "scatter",
  "per-item",
  "reliability",
  "board",
  "case",
]);

export const cardSchema = z.object({
  id,
  title: z.string(),
  question: z.string(),
  /** The authors' reading of the default lineup, stated once and attributed. */
  insight: z.string().optional(),
  family: z.enum(["game", "judgement-set", "robustness"]),
  /** What "right" means, so copy never says accuracy when it means agreement. */
  reference: z.enum(["world-outcome", "soft-teacher", "authored-labels", "self-consistency"]),
  metrics: z.array(metricSchema),
  /** The metric a card ranks by unless the reader changes it. */
  primary: id,
  /** Two metrics for the trade-off view: x, then y. */
  tradeoff: z.tuple([id, id]).optional(),
  contestants: z.array(contestantSchema),
  /** contestant → metric → estimate */
  results: byContestant,
  /** facet → value → contestant → metric → estimate (e.g. workflow, question type) */
  slices: z.record(z.string(), z.record(z.string(), byContestant)).optional(),
  items: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  /** Display names for slice facets, e.g. { workflow: "Cases" }. */
  facetLabels: z.record(z.string(), z.string()).optional(),
  /** Generated from the data: metric · protocol · items · dates · coverage. */
  provenance: z.string(),
  notes: z.string().optional(),
  chunks: z.object({
    preds: z.record(z.string(), z.string()).optional(),
    targets: z.string().optional(),
    cases: z.string().optional(),
    replay: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    rows: z.string().optional(),
  }),
  lenses: z.array(lensSchema),
  protocolGroups: z.array(z.object({ hash: z.string(), label: z.string(), runSets: z.array(id) })),
});

export const arenaIndexSchema = z.object({
  schema: z.literal("arena.index/1"),
  generatedAt: z.string(),
  runSets: z.array(runSetSchema),
  cards: z.array(cardSchema),
});

export type Id = string;

export type Swatch = z.infer<typeof swatchSchema>;

export type MetricDef = z.infer<typeof metricSchema>;

export type Estimate = z.infer<typeof estimateSchema>;

export type CardContestant = z.infer<typeof contestantSchema>;

export type ContestantKind = CardContestant["kind"];

export type Contestant = Omit<CardContestant, "default" | "runSets">;

export type RunSet = z.infer<typeof runSetSchema>;

export type Lens = z.infer<typeof lensSchema>;

export type Card = z.infer<typeof cardSchema>;

export type ArenaIndex = z.infer<typeof arenaIndexSchema>;
