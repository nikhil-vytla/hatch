/**
 * The arena's published data: one small index describing every benchmark card,
 * with headline results and their uncertainty, plus lazily loaded chunks.
 * Built by data/build.ts from the recordings; read by data/client.ts.
 */
export type Id = string;

export type MetricDef = {
  id: Id;
  label: string;
  unit: "%" | "ms" | "s" | "lines" | "pieces" | "count" | "";
  better: "higher" | "lower";
  axis: "accuracy" | "calibration" | "speed" | "cost" | "robustness" | "outcome";
  /** One sentence shown on hover: what the number means and how it was measured. */
  help: string;
};

/**
 * A value with its spread. Judgement sets carry a 95% case-bootstrap interval;
 * games with a handful of seeds carry one value per seed instead of an interval.
 */
export type Estimate = {
  value: number;
  n: number;
  lo?: number;
  hi?: number;
  perItem?: { item: string; value: number }[];
  method: "bootstrap-case" | "per-seed" | "count" | "none";
  /** Share of the n items this contestant actually covers, when partial. */
  coverage?: { covered: number; of: number };
};

export type ContestantKind = "hosted" | "local" | "code";

export type Contestant = {
  id: Id;
  name: string;
  short: string;
  kind: ContestantKind;
  /** The model behind it, e.g. "typesafe-ai/jev"; absent for code players. */
  model?: string;
  /** How it is asked or how it plays, e.g. "judge each spot". */
  policy?: string;
  color: string;
};

export type RunSet = {
  id: Id;
  label: string;
  recordedAt: string;
  source: "recorded" | "computed";
  /** Canonical protocol; runs are comparable only when these hashes match. */
  protocol: Record<string, string | number | boolean>;
  protocolHash: string;
  standing: "valid" | "availability-only";
  files: string[];
  note?: string;
};

export type CardContestant = Contestant & { default: boolean; runSets: Id[] };

export type Card = {
  id: Id;
  title: string;
  question: string;
  family: "game" | "judgement-set" | "robustness";
  /** What "right" means, so copy never says accuracy when it means agreement. */
  reference: "world-outcome" | "soft-teacher" | "authored-labels" | "self-consistency";
  metrics: MetricDef[];
  /** The metric a card ranks by unless the reader changes it. */
  primary: Id;
  contestants: CardContestant[];
  /** contestant → metric → estimate */
  results: Record<Id, Record<Id, Estimate>>;
  /** facet → value → contestant → metric → estimate (e.g. workflow, question type) */
  slices?: Record<string, Record<string, Record<Id, Record<Id, Estimate>>>>;
  items?: { id: string; label: string }[];
  /** Display names for slice facets, e.g. { workflow: "Cases" }. */
  facetLabels?: Record<string, string>;
  /** Generated from the data: metric · protocol · items · dates · coverage. */
  provenance: string;
  notes?: string;
  chunks: {
    /** contestant → per-decision predictions, aligned with `targets` */
    preds?: Record<Id, string>;
    targets?: string;
    cases?: string;
    /** contestant → item → replay */
    replay?: Record<Id, Record<string, string>>;
    rows?: string;
  };
  lenses: ("table" | "bars" | "scatter" | "per-item" | "reliability" | "board" | "case")[];
  protocolGroups: { hash: string; label: string; runSets: Id[] }[];
};

export type ArenaIndex = {
  schema: "arena.index/1";
  generatedAt: string;
  runSets: RunSet[];
  cards: Card[];
};
