/**
 * Builds the arena's public data from the recordings: a small index with every
 * card's headline results and uncertainty, and lazily loaded chunks for
 * predictions, cases and replays. Recordings are read in place and never
 * modified. Run by experience-prototypes/scripts/prepare.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { score } from "../score";
import { PALETTE } from "./palette";
import { bootstrapGroups, bootstrapGroupsMany } from "../../../seeded/src/index";
import { heuristic, randomPlayer, TetrisArena, type Contestant as Player } from "../tetris";
import { perfectReader } from "../tetris-framings";
import { timedReplaySchema } from "./chunks";
import {
  arenaIndexSchema,
  type ArenaIndex,
  type Card,
  type CardContestant,
  type Estimate,
  type MetricDef,
  type RunSet,
} from "./schema";
import { readRecord } from "../../../../experience-prototypes/scripts/records";
import { latestById, readRows } from "../../../jev-client/src/recordings";
import { CASES, comparePreferences } from "../../../../cafe-jev/cases";
import {
  FIELDS,
  FIELD_LABELS,
  VALUES,
  candidates,
  constraintErrors,
  drinkName,
  interpret,
  type Field,
} from "../../../../cafe-jev/engine";
import { keywordAnswers, priorAnswers, tokensFor } from "../cafe-baselines";
import { oneBoxCard } from "./one-box-card";
import { OPEN_MODELS, openModel } from "../../open-decisions/models";

// ---------------------------------------------------------------- inputs
// Every recording and study file is parsed here. Where a chunk echoes its input,
// the schema's key order follows the file, so the chunk keeps the same bytes.

const studySchema = z.object({
  provenance: z.object({ revision: z.string(), license: z.string() }),
  hardware: z.string(),
  workflows: z.array(z.string()),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string().nullish(),
      case_latency_ms: z.object({ median: z.number() }).nullish(),
    }),
  ),
  cases: z.array(
    z.object({
      id: z.string(),
      workflow: z.string(),
      /** Shown as JSON on the case view, never interpreted. */
      state: z.unknown(),
      questions: z.array(
        z.object({
          key: z.string(),
          type: z.string(),
          instructions: z.string(),
          keys: z.array(z.string()),
          options: z.array(z.string()).optional(),
          target: z.array(z.number()),
          predictions: z.record(z.string(), z.array(z.number())),
        }),
      ),
    }),
  ),
});

type StudyQuestion = z.infer<typeof studySchema>["cases"][number]["questions"][number];

const wireAnswerSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: z.record(z.string(), z.number()).nullish(),
  confidence: z.number().nullish(),
});

/** One recorded turn exchange; echoed into the turns replay chunks. */
const turnsExchangeSchema = z.object({
  seed: z.number(),
  framing: z.string(),
  pieceId: z.number(),
  board: z.array(z.string()),
  ms: z.number(),
  response: z.looseObject({ answers: z.record(z.string(), wireAnswerSchema) }).optional(),
  error: z.string().optional(),
});

const turnsSummarySchema = z.object({
  games: z.array(
    z.object({
      seed: z.number(),
      lanes: z.array(
        z.object({
          framing: z.string(),
          name: z.string().optional(),
          lines: z.number(),
          pieces: z.number(),
          status: z.string(),
        }),
      ),
    }),
  ),
});

const realtimeDesignSchema = z.enum([
  "landing-choice",
  "spot-clean",
  "spot-clean-cached",
  "spot-clean-confident",
]);

type RealtimeDesign = z.infer<typeof realtimeDesignSchema>;

const realtimeRunSchema = z.object({
  games: z.array(
    z.object({
      seed: z.number(),
      design: realtimeDesignSchema,
      worldMs: z.number(),
      lines: z.number(),
      failed: z.number(),
      memoryHits: z.number().nullish(),
      /** Echoed into the timed replay chunks; the site parses them with the same schema. */
      events: timedReplaySchema.shape.events,
    }),
  ),
});

const cafeRecordSchema = z.object({
  manifest: z.object({ created: z.string() }),
  result: z.object({
    menuRevision: z.string(),
    rows: z.array(
      z.object({
        id: z.string(),
        response: z.object({
          answers: z.record(
            z.string(),
            z.object({
              value: z.string(),
              confidence: z.number().optional(),
              probabilities: z.record(z.string(), z.number()).optional(),
            }),
          ),
        }),
      }),
    ),
  }),
});

type CafeRow = z.infer<typeof cafeRecordSchema>["result"]["rows"][number];

const probabilityMap = z.record(z.string(), z.number());

/** Echoed into robustness.rows.json. */
const robustnessSchema = z.object({
  rows: z.array(
    z.object({
      seed: z.number(),
      pieceId: z.number(),
      sentences: z.array(z.string()),
      original: probabilityMap.nullish(),
      again: probabilityMap.nullish(),
      reversed: probabilityMap.nullish(),
      separate: probabilityMap.nullish(),
    }),
  ),
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const here = resolve(import.meta.dir, "../..");

const lab = resolve(here, "../..");

const recordings = resolve(here, "recordings");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const canonical = (o: RunSet["protocol"]) =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );

const readJsonl = <T>(path: string, schema: z.ZodType<T>) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => schema.parse(JSON.parse(l)));

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const COLORS = {
  jev: PALETTE.jev,
  jev2: PALETTE.jevTeal,
  jev3: PALETTE.jevOlive,
  jev4: PALETTE.jevMoss,
  laya: PALETTE.laya,
  laya2: PALETTE.layaIndigo,
  laya3: PALETTE.layaSlate,
  qwen: PALETTE.qwen,
  qwen2: PALETTE.qwenSand,
  qwen3: PALETTE.qwenPlum,
  smol: PALETTE.small,
  code: PALETTE.code,
  code2: PALETTE.codeMid,
  code3: PALETTE.codeLight,
};

function runSet(
  id: string,
  label: string,
  recordedAt: string,
  protocol: RunSet["protocol"],
  files: string[],
  extra: Partial<RunSet> = {},
): RunSet {
  return {
    id,
    label,
    recordedAt,
    source: "recorded",
    protocol,
    protocolHash: sha(canonical(protocol)).slice(0, 12),
    standing: "valid",
    files,
    ...extra,
  };
}

const perSeed = (values: { item: string; value: number }[], of?: number): Estimate => {
  const e: Estimate = {
    value: mean(values.map((v) => v.value)),
    n: values.length,
    perItem: values,
    method: "per-seed",
  };

  if (of && values.length < of) e.coverage = { covered: values.length, of };

  return e;
};

/** metric → estimate, for one contestant. */
type Estimates = Card["results"][string];

// ---------------------------------------------------------------- the typed-decisions study
const openRowSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  at: z.string().optional(),
  serverMs: z.number().optional(),
  answers: z.record(z.string(), z.looseObject({ probabilities: z.record(z.string(), z.number()).nullish() })).optional(),
});

/**
 * Adds the open models recorded through SGLang's decision method (open-decisions/record.ts typed)
 * to the study, each only when all of its cases answered. Returns their recording files and dates.
 */
function withOpenModels(doc: z.infer<typeof studySchema>) {
  const added: { id: string; file: string; recordedAt: string }[] = [];

  for (const m of OPEN_MODELS) {
    const file = `packages/arena/recordings/open-decisions.typed.${m.id}.jsonl`;
    const path = resolve(here, "../..", file);

    if (!existsSync(path)) continue;

    const rows = latestById(readRows<unknown>(path).map((r) => openRowSchema.parse(r)));

    if (doc.cases.some((c) => !rows.has(c.id))) continue;

    const id = `open.${m.id}`;
    const times = doc.cases.map((c) => rows.get(c.id)?.serverMs ?? 0).sort((a, b) => a - b);

    doc.models.push({
      id,
      name: `${m.name} (${m.quantisation}) · ${m.method}`,
      url: `https://huggingface.co/${m.repo}`,
      case_latency_ms: { median: times[Math.floor(times.length / 2)] },
    });

    for (const c of doc.cases)
      for (const q of c.questions) {
        const p = rows.get(c.id)?.answers?.[q.key]?.probabilities ?? {};

        q.predictions[id] = q.keys.map((k) => p[k] ?? 0);
      }

    const dates = [...rows.values()].map((r) => r.at ?? "").sort();

    added.push({ id, file, recordedAt: (dates.at(-1) ?? "").slice(0, 10) });
  }

  return added;
}

function studyCard(out: string): Card {
  const doc = studySchema.parse(
    readJson(resolve(here, "../../experience-prototypes/public/data/local-models.json")).result,
  );

  const openFiles = withOpenModels(doc);
  const models = doc.models;

  const kind = (id: string): CardContestant["kind"] =>
    id === "jev" ? "hosted" : id === "uniform" || id === "train-prior" ? "code" : "local";

  const color = (id: string) =>
    ({
      jev: COLORS.jev,
      "laya-tuned": COLORS.laya,
      "laya-coreml": COLORS.laya2,
      "laya-base": COLORS.laya3,
      "Qwen3-4B-Instruct-2507-4bit": COLORS.qwen,
      "Qwen3-0.6B-4bit": COLORS.qwen2,
      "Qwen3-0.6B-4bit-sequence": COLORS.qwen3,
      "SmolLM2-360M-Instruct": COLORS.smol,
      "train-prior": COLORS.code,
      uniform: COLORS.code3,
    })[id] ??
    openModel(id.replace(/^open\./, ""))?.color ??
    COLORS.code2;

  const rs = runSet(
    "2026-09-20-typed-decisions",
    "Typed Decisions test split, 10 models",
    "2026-09-20",
    {
      benchmark: "typed-decisions",
      split: "test",
      revision: doc.provenance.revision,
      reference: "mean-of-3-teacher-samples",
    },
    ["experience-prototypes/public/data/local-models.json"],
  );

  // The same cases, questions and reference, asked later through SGLang's decision method.
  const rsOpen = runSet(
    "2026-10-01-typed-decisions-open",
    `Typed Decisions test split, ${openFiles.length} open models via SGLang's decision method`,
    openFiles.map((o) => o.recordedAt).sort().at(-1) ?? "2026-10-01",
    {
      benchmark: "typed-decisions",
      split: "test",
      revision: doc.provenance.revision,
      reference: "mean-of-3-teacher-samples",
      method: "sglang-systemone-prompt-format-1",
    },
    openFiles.map((o) => o.file),
  );

  const metrics: MetricDef[] = [
    {
      id: "agreement",
      label: "Agrees with reference",
      unit: "%",
      better: "higher",
      axis: "accuracy",
      help: "Share of decisions whose top answer matches the reference's top answer. The reference is the mean of three samples from a ~4B teacher model, so this is agreement, not correctness; it saturates near 75%.",
    },
    {
      id: "ece",
      label: "Calibration error",
      unit: "",
      better: "lower",
      axis: "calibration",
      help: "Expected calibration error over ten confidence bins: how far stated confidence is from how often the top answer agrees with the reference.",
    },
    {
      id: "brier",
      label: "Brier score",
      unit: "",
      better: "lower",
      axis: "calibration",
      help: "Mean squared difference between the predicted and reference distributions, averaged over options.",
    },
    {
      id: "confidentWrong",
      label: "Confident but disagrees",
      unit: "%",
      better: "lower",
      axis: "calibration",
      help: "Share of decisions where the top answer has at least 70% probability but disagrees with the reference.",
    },
    {
      id: "latency",
      label: "Local time per case",
      unit: "ms",
      better: "lower",
      axis: "speed",
      help: "Median time for all five questions of a case, run sequentially on an Apple M4 Max. Hosted Jev latency includes the network and is not comparable, so it is not shown here.",
    },
  ];

  // Columnar targets, aligned row by row with every prediction chunk.
  const rows: { c: number; q: StudyQuestion; wf: string; type: string }[] = [];
  doc.cases.forEach((c, ci) =>
    c.questions.forEach((q) => rows.push({ c: ci, q, wf: c.workflow, type: q.type })),
  );

  const byCase = (filter: (r: (typeof rows)[number]) => boolean) => {
    const groups = new Map<number, number[]>();
    rows.forEach((r, i) => {
      if (filter(r)) groups.set(r.c, [...(groups.get(r.c) ?? []), i]);
    });

    return [...groups.values()];
  };

  // Per-decision facts computed once per model; resampling then only sums them.
  const facts = new Map<string, { hit: Uint8Array; conf: Float64Array; brier: Float64Array }>();

  for (const m of models) {
    const hit = new Uint8Array(rows.length),
      conf = new Float64Array(rows.length),
      brier = new Float64Array(rows.length);

    rows.forEach((r, i) => {
      const one = score([{ prediction: r.q.predictions[m.id], reference: r.q.target }]);
      hit[i] = one.agreement;
      conf[i] = one.meanConfidence;
      brier[i] = one.brier;
    });
    facts.set(m.id, { hit, conf, brier });
  }

  const stats = (id: string, sample: number[]) => {
    const f = facts.get(id);

    if (!f) throw new Error(`No per-decision facts for ${id}`);

    let hits = 0,
      br = 0,
      cw = 0;

    const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));

    for (const i of sample) {
      hits += f.hit[i];
      br += f.brier[i];

      if (!f.hit[i] && f.conf[i] >= 0.7) cw++;

      for (let b = 0; b < 10; b++)
        if (f.conf[i] > b * 0.1 && f.conf[i] <= (b + 1) * 0.1) {
          bins[b].n++;
          bins[b].conf += f.conf[i];
          bins[b].hit += f.hit[i];
          break;
        }
    }

    const n = sample.length || 1;

    const ece = bins.reduce(
      (e, b) => (b.n ? e + (b.n / n) * Math.abs(b.conf / b.n - b.hit / b.n) : e),
      0,
    );

    return { agreement: hits / n, brier: br / n, confidentWrong: cw / n, ece };
  };

  const estimate = (id: string, idx: number[][]) => {
    const point = stats(id, idx.flat()),
      n = idx.length;

    const intervals = bootstrapGroupsMany(idx, (s) => stats(id, s), 1000);
    const ci = (k: keyof typeof point) => intervals.get(k);
    const m = models.find((x) => x.id === id);

    const out: Estimates = {
      agreement: { value: point.agreement, n, ...ci("agreement"), method: "bootstrap-case" },
      ece: { value: point.ece, n, ...ci("ece"), method: "bootstrap-case" },
      brier: { value: point.brier, n, ...ci("brier"), method: "bootstrap-case" },
      confidentWrong: {
        value: point.confidentWrong,
        n,
        ...ci("confidentWrong"),
        method: "bootstrap-case",
      },
    };

    if (m?.case_latency_ms) out.latency = { value: m.case_latency_ms.median, n, method: "none" };

    return out;
  };

  const all = byCase(() => true);
  const results = Object.fromEntries(models.map((m) => [m.id, estimate(m.id, all)]));
  const slices: Card["slices"] = { workflow: {}, type: {} };

  for (const wf of doc.workflows)
    slices.workflow[wf] = Object.fromEntries(
      models.map((m) => [
        m.id,
        estimate(
          m.id,
          byCase((r) => r.wf === wf),
        ),
      ]),
    );

  for (const t of ["choice", "score", "noul"])
    slices.type[t] = Object.fromEntries(
      models.map((m) => [
        m.id,
        estimate(
          m.id,
          byCase((r) => r.type === t),
        ),
      ]),
    );
  // Chunks: targets and cases once; one small prediction file per model.
  mkdirSync(join(out, "preds"), { recursive: true });

  const targets = {
    schema: "arena.targets/1",
    rows: rows.map((r) => ({
      c: r.c,
      key: r.q.key,
      type: r.type,
      wf: r.wf,
      keys: r.q.keys,
      target: r.q.target.map((x) => round(x)),
    })),
  };

  writeFileSync(join(out, "typed-decisions.targets.json"), JSON.stringify(targets));
  writeFileSync(
    join(out, "typed-decisions.cases.json"),
    JSON.stringify({
      schema: "arena.cases/1",
      cases: doc.cases.map((c) => ({
        id: c.id,
        workflow: c.workflow,
        state: c.state,
        questions: c.questions.map((q) => ({
          key: q.key,
          type: q.type,
          instructions: q.instructions,
          keys: q.keys,
          options: q.options,
        })),
      })),
    }),
  );
  const preds: Record<string, string> = {};

  for (const m of models) {
    preds[m.id] = `preds/typed-decisions.${m.id}.json`;
    writeFileSync(
      join(out, preds[m.id]),
      JSON.stringify({
        schema: "arena.preds/1",
        contestant: m.id,
        p: rows.map((r) => r.q.predictions[m.id].map((x) => round(x))),
      }),
    );
  }

  const defaults = new Set([
    "jev",
    "laya-tuned",
    "Qwen3-4B-Instruct-2507-4bit",
    "train-prior",
    "uniform",
  ]);

  return {
    id: "typed-decisions",
    title: "Typed decisions over shared state",
    question:
      "Given one piece of state, how well do models answer five typed questions about it, and how honest is their confidence?",
    family: "judgement-set",
    reference: "soft-teacher",
    metrics,
    primary: "agreement",
    contestants: models.map((m) => ({
      id: m.id,
      name: m.name,
      short: m.name.split(" · ")[0],
      kind: kind(m.id),
      model: m.url ? m.name.split(" · ")[0] : undefined,
      policy: m.name.split(" · ")[1],
      color: color(m.id),
      default: defaults.has(m.id) || m.id === "open.qwen3-4b",
      runSets: [openFiles.some((o) => o.id === m.id) ? rsOpen.id : rs.id],
    })),
    results,
    slices,
    provenance: `Agreement with a soft reference · ${doc.cases.length} cases × 5 questions · Typed Decisions test split (${doc.provenance.license}, rev ${doc.provenance.revision.slice(0, 7)}) · local models on ${doc.hardware}, Jev via AI Gateway · recorded 20 Sep 2026 · 95% case-bootstrap intervals`,
    chunks: { preds, targets: "typed-decisions.targets.json", cases: "typed-decisions.cases.json" },
    lenses: ["bars", "room", "dial", "scatter", "reliability", "table", "case"],
    protocolGroups: [
      { hash: rs.protocolHash, label: rs.label, runSets: [rs.id] },
      ...(openFiles.length ? [{ hash: rsOpen.protocolHash, label: rsOpen.label, runSets: [rsOpen.id] }] : []),
    ],
  };
}

// ---------------------------------------------------------------- Tetris, turns
/** Code players are deterministic: cache their games under a hash of the engine and player source. */
const sourceHash = sha(
  [
    "../tetris-engine.ts",
    "../tetris.ts",
    "../tetris-framings.ts",
  ]
    .map((f) => readFileSync(resolve(import.meta.dir, f), "utf8"))
    .join("\n"),
).slice(0, 16);

const cacheDir = resolve(here, ".cache");

async function cached<T>(name: string, compute: () => T | Promise<T>): Promise<T> {
  const file = join(cacheDir, `${name}.${sourceHash}.json`);

  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const value = await compute();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(value));

  return value;
}

async function simulateTurns(player: () => Player, seeds: number[]) {
  const out: Record<number, { lines: number; pieces: number; over: boolean }> = {};

  for (const seed of seeds) {
    const a = new TetrisArena(seed, [player()], "turns", { pieceLimit: 40 });

    for (let i = 0; i < 40 && !a.over; i++) await a.turn();
    const g = a.lanes[0].game;
    out[seed] = { lines: g.lines, pieces: g.pieces, over: g.status === "over" };
  }

  return out;
}

function simulateRealtime(player: () => Player, seeds: number[]) {
  const out: Record<number, { lines: number; pieces: number; over: boolean; worldMs: number }> = {};

  for (const seed of seeds) {
    const a = new TetrisArena(seed, [player()], "realtime", { pieceLimit: 40 });

    while (!a.over && a.clockMs < 240_000) a.step();
    a.stop();
    const g = a.lanes[0].game;
    out[seed] = { lines: g.lines, pieces: g.pieces, over: g.status === "over", worldMs: a.clockMs };
  }

  return out;
}

const GAME_METRICS: MetricDef[] = [
  {
    id: "lines",
    label: "Lines cleared",
    unit: "lines",
    better: "higher",
    axis: "outcome",
    help: "Lines cleared in a 40-piece game, one dot per seed. Every contestant gets the same pieces in the same order.",
  },
  {
    id: "pieces",
    label: "Pieces placed",
    unit: "pieces",
    better: "higher",
    axis: "outcome",
    help: "Pieces placed before the 40-piece limit or topping out.",
  },
  {
    id: "toppedOut",
    label: "Games topped out",
    unit: "count",
    better: "lower",
    axis: "outcome",
    help: "Games that ended because the stack reached the top before 40 pieces.",
  },
  {
    id: "decisionMs",
    label: "Median decision time",
    unit: "ms",
    better: "lower",
    axis: "speed",
    help: "Median time from question to usable answer across the contestant's decisions. Code players make no model calls, so they have no time here.",
  },
];

async function turnsCard(out: string): Promise<Card> {
  const a = readJsonl(join(recordings, "tetris-framings.replay.jsonl"), turnsExchangeSchema),
    aSum = turnsSummarySchema.parse(readJson(join(recordings, "tetris-framings-summary.json")));

  const b = readJsonl(join(recordings, "turns-more-seeds.replay.jsonl"), turnsExchangeSchema),
    bSum = turnsSummarySchema.parse(readJson(join(recordings, "turns-more-seeds-summary.json")));

  const protocol = {
    game: "tetris",
    timing: "turns",
    pieceLimit: 40,
    lanes: "one per design, same arena",
    transport: "serial, patient retries",
    weakAnswers: "never retried",
  };

  const rsA = runSet(
    "2026-09-22-tetris-turns-a",
    "Turns · seeds 7, 19, 42",
    "2026-09-22",
    protocol,
    ["packages/arena/recordings/tetris-framings.replay.jsonl"],
  );

  const rsB = runSet(
    "2026-09-23-tetris-turns-b",
    "Turns · seeds 3, 11, 23, 31",
    "2026-09-23",
    protocol,
    ["packages/arena/recordings/turns-more-seeds.replay.jsonl"],
  );

  const rsCode = {
    ...runSet(
      "computed-tetris-turns-code",
      "Code players, computed at build",
      new Date().toISOString().slice(0, 10),
      protocol,
      [],
    ),
    source: "computed" as const,
  };

  const seeds = [7, 19, 42, 3, 11, 23, 31];

  const games: Record<
    string,
    Record<number, { lines: number; pieces: number; over: boolean; ms: number[] }>
  > = {};

  for (const [sum, rows] of [
    [aSum, a],
    [bSum, b],
  ] as const)
    for (const g of sum.games)
      for (const lane of g.lanes) {
        const framing = lane.framing;

        // Code lanes recorded beside Jev (e.g. "heuristic-0") are recomputed below.
        if (!framing || framing.startsWith("Code") || lane.name?.startsWith("Code")) continue;
        const id = `jev.${framing}`;
        (games[id] ??= {})[g.seed] = {
          lines: lane.lines,
          pieces: lane.pieces,
          over: lane.status === "over",
          ms: rows
            .filter((x) => x.seed === g.seed && x.framing === framing && !x.error)
            .map((x) => x.ms),
        };
      }

  const code = {
    "code.planner": await cached(`turns-planner-${seeds.join("-")}`, () =>
      simulateTurns(() => heuristic(0), seeds),
    ),
    "code.reader": await cached(`turns-reader-${seeds.join("-")}`, () =>
      simulateTurns(() => perfectReader(), seeds),
    ),
    "code.random": await cached(`turns-random-${seeds.join("-")}`, () =>
      simulateTurns(() => randomPlayer(1), seeds),
    ),
  };

  for (const [id, per] of Object.entries(code))
    games[id] = Object.fromEntries(Object.entries(per).map(([s, v]) => [s, { ...v, ms: [0] }]));
  const results: Card["results"] = {};

  for (const [id, per] of Object.entries(games)) {
    const covered = seeds.filter((s) => per[s]);
    results[id] = {
      lines: perSeed(
        covered.map((s) => ({ item: String(s), value: per[s].lines })),
        seeds.length,
      ),
      pieces: perSeed(
        covered.map((s) => ({ item: String(s), value: per[s].pieces })),
        seeds.length,
      ),
      toppedOut: {
        value: covered.filter((s) => per[s].over).length,
        n: covered.length,
        method: "count",
      },
      decisionMs: {
        value: median(covered.flatMap((s) => per[s].ms)),
        n: covered.flatMap((s) => per[s].ms).length,
        method: "none",
      },
    };
  }

  // Replay chunks: one per recorded contestant and seed.
  mkdirSync(join(out, "replay"), { recursive: true });
  const replay: Record<string, Record<string, string>> = {};

  for (const rows of [a, b])
    for (const x of rows) {
      const id = `jev.${x.framing}`,
        path = `replay/turns.${x.framing}.${x.seed}.json`;

      (replay[id] ??= {})[String(x.seed)] = path;
    }

  for (const [id, per] of Object.entries(replay))
    for (const [seed, path] of Object.entries(per)) {
      const framing = id.slice(4),
        rows = [...a, ...b].filter((x) => x.framing === framing && String(x.seed) === seed);

      writeFileSync(
        join(out, path),
        JSON.stringify({ schema: "arena.replay.turns/1", framing, seed: +seed, exchanges: rows }),
      );
    }

  const c = (
    id: string,
    name: string,
    short: string,
    kind: CardContestant["kind"],
    color: CardContestant["color"],
    def: boolean,
    runSets: string[],
    policy?: string,
  ): CardContestant => ({
    id,
    name,
    short,
    kind,
    color,
    default: def,
    runSets,
    model: kind === "hosted" ? "typesafe-ai/jev" : undefined,
    policy,
  });

  return {
    id: "tetris-turns",
    title: "Where should the piece land?",
    question:
      "Three ways of asking Jev the same Tetris question, with the world paused until every contestant answers.",
    family: "game",
    reference: "world-outcome",
    metrics: GAME_METRICS,
    primary: "lines",
    contestants: [
      c(
        "jev.spot-clean",
        "Jev · judge each spot",
        "Judge each spot",
        "hosted",
        COLORS.jev,
        true,
        [rsA.id, rsB.id],
        "one sentence per distinct spot, batched yes/no; code picks the best",
      ),
      c(
        "jev.spot-score",
        "Jev · rate each spot 0–3",
        "Rate each spot",
        "hosted",
        COLORS.jev3,
        false,
        [rsA.id],
        "one sentence per spot, 0–3 rating",
      ),
      c(
        "jev.landing-choice",
        "Jev · pick one landing",
        "Pick one landing",
        "hosted",
        COLORS.qwen,
        true,
        [rsA.id, rsB.id],
        "every landing as JSON features in one choice",
      ),
      c(
        "code.planner",
        "Code planner",
        "Code planner",
        "code",
        COLORS.code,
        true,
        [rsCode.id],
        "hand-written landing heuristic",
      ),
      c(
        "code.reader",
        "Perfect reader of the sentences",
        "Perfect reader",
        "code",
        COLORS.code2,
        false,
        [rsCode.id],
        "reads the spot sentences with a fixed rule; bounds what the words allow",
      ),
      c(
        "code.random",
        "Random landing",
        "Random",
        "code",
        COLORS.code3,
        false,
        [rsCode.id],
        "uniform over reachable landings",
      ),
    ],
    results,
    items: seeds.map((s) => ({ id: String(s), label: `Seed ${s}` })),
    provenance: `Lines cleared in 40-piece turn games · 7 seeds (7, 19, 42 on 22 Sep; 3, 11, 23, 31 on 23 Sep 2026) · one lane per design in the same arena · typesafe-ai/jev via AI Gateway · rating each spot recorded on 3 seeds only · code players computed at build`,
    chunks: { replay },
    lenses: ["bars", "per-item", "scatter", "table", "board"],
    protocolGroups: [
      { hash: rsA.protocolHash, label: "Turns, 40 pieces", runSets: [rsA.id, rsB.id, rsCode.id] },
    ],
  };
}

// ---------------------------------------------------------------- Tetris, real time
/** Designs that remember judgements ask only about some spots, so the board alone can't rebuild their requests. */
const REMEMBERS = new Set<RealtimeDesign>(["spot-clean-cached", "spot-clean-confident"]);

const requestRowSchema = z.object({
  seed: z.number(),
  framing: z.string(),
  pieceId: z.number(),
  board: z.array(z.string()),
  body: timedReplaySchema.shape.events.element.shape.body,
});

/**
 * The recorded events with the request each one sent, from the run's full request log
 * (`<run>.jsonl.gz`, one row per event in the same order). Events answered from memory have none.
 */
function withBodies(
  events: z.infer<typeof timedReplaySchema>["events"],
  replayFile: string,
  seed: number,
  design: RealtimeDesign,
) {
  const log = replayFile.replace(/\.replay\.json$/, ".jsonl.gz");

  const rows = gunzipSync(readFileSync(join(recordings, log)))
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => requestRowSchema.parse(JSON.parse(line)))
    .filter((x) => x.seed === seed && x.framing === design);

  if (rows.length !== events.length)
    throw new Error(
      `${log}: ${rows.length} requests for ${events.length} ${design} events on seed ${seed}`,
    );

  return events.map((e, i) => {
    const row = rows[i];

    if (row.pieceId !== e.pieceId || JSON.stringify(row.board) !== JSON.stringify(e.board))
      throw new Error(`${log}: request ${i} for ${design} on seed ${seed} is for another board`);

    return row.body ? { ...e, body: row.body } : e;
  });
}

async function realtimeCard(out: string): Promise<Card> {
  const load = (f: string) => realtimeRunSchema.parse(readJson(join(recordings, f)));

  const runs = [
    {
      file: "realtime.replay.json",
      retry: "fixed-400ms",
      date: "2026-09-22",
      id: "2026-09-22-tetris-realtime-a",
    },
    {
      file: "realtime-2.replay.json",
      retry: "backoff-0.4-4s",
      date: "2026-09-23",
      id: "2026-09-23-tetris-realtime-b",
    },
  ];

  const base = {
    game: "tetris",
    timing: "realtime",
    pieceLimit: 40,
    lanes: "one game per design",
    inFlight: 1,
    attempts: "2 within 4 s",
    superseded: "dropped",
  };

  const sets = runs.map((r) =>
    runSet(
      r.id,
      r.retry === "fixed-400ms"
        ? "Real time · retries every 400 ms"
        : "Real time · backs off 0.4–4 s",
      r.date,
      { ...base, retry: r.retry },
      [
        `packages/arena/recordings/${r.file}`,
        `packages/arena/recordings/${r.file.replace(/\.replay\.json$/, ".jsonl.gz")}`,
      ],
    ),
  );

  const code = await cached("realtime-planner-7-19-42", () =>
    simulateRealtime(() => heuristic(0), [7, 19, 42]),
  );

  const results: Card["results"] = {},
    replay: Record<string, Record<string, string>> = {};

  const contestants: CardContestant[] = [];

  const names = {
    "landing-choice": ["Jev · pick one landing", "Pick one landing"],
    "spot-clean": ["Jev · judge each spot", "Judge each spot"],
    "spot-clean-cached": ["Jev · judge each spot, remembering all", "Remember all"],
    "spot-clean-confident": ["Jev · judge each spot, remembering confident", "Remember confident"],
  } satisfies Record<RealtimeDesign, [string, string]>;

  const colors = {
    "landing-choice": COLORS.qwen,
    "spot-clean": COLORS.jev,
    "spot-clean-cached": COLORS.jev4,
    "spot-clean-confident": COLORS.jev2,
  } satisfies Record<RealtimeDesign, CardContestant["color"]>;

  /** The fixed-retry run gets its own colours, so the same design from two protocols never matches. */
  const fixedColors = {
    "landing-choice": COLORS.qwen,
    "spot-clean": COLORS.jev3,
    "spot-clean-cached": COLORS.laya3,
    "spot-clean-confident": COLORS.jev3,
  } satisfies Record<RealtimeDesign, CardContestant["color"]>;

  runs.forEach((r, ri) => {
    const doc = load(r.file),
      suffix = r.retry === "fixed-400ms" ? "fixed" : "backoff";

    const designs = [...new Set(doc.games.map((g) => g.design))];

    for (const d of designs) {
      const id = `jev.${d}@${suffix}`,
        games = doc.games.filter((g) => g.design === d);

      results[id] = {
        lines: perSeed(games.map((g) => ({ item: String(g.seed), value: g.lines }))),
        gameTime: perSeed(games.map((g) => ({ item: String(g.seed), value: g.worldMs / 1000 }))),
        failed: perSeed(games.map((g) => ({ item: String(g.seed), value: g.failed }))),
        decisionMs: {
          value: median(
            games.flatMap((g) =>
              g.events.flatMap((e) =>
                e.status === "applied" && e.latencyMs !== undefined ? [e.latencyMs] : [],
              ),
            ),
          ),
          n: games.length,
          method: "none",
        },
        memory: perSeed(games.map((g) => ({ item: String(g.seed), value: g.memoryHits ?? 0 }))),
      };

      for (const g of games) {
        const path = `replay/realtime.${d}.${suffix}.${g.seed}.json`;
        (replay[id] ??= {})[String(g.seed)] = path;
        writeFileSync(
          join(out, path),
          JSON.stringify({
            schema: "arena.replay.timed/1",
            retryPolicy: suffix,
            framing: d,
            seed: g.seed,
            events: REMEMBERS.has(d) ? withBodies(g.events, r.file, g.seed, d) : g.events,
          }),
        );
      }

      contestants.push({
        id,
        name: `${names[d][0]} · ${suffix === "fixed" ? "fixed retries" : "backoff"}`,
        // The earlier run's lanes carry their protocol so a mixed lineup stays legible.
        short: suffix === "fixed" ? `${names[d][1]} (fixed)` : names[d][1],
        kind: "hosted",
        model: "typesafe-ai/jev",
        policy: `${names[d][1].toLowerCase()}; ${suffix === "fixed" ? "re-asks every 400 ms after a failure" : "backs off 0.4–4 s after a failure"}`,
        color: suffix === "fixed" ? fixedColors[d] : colors[d],
        default: suffix === "backoff" && d !== "spot-clean-cached",
        runSets: [sets[ri].id],
      });
    }
  });
  results["code.planner"] = {
    lines: perSeed(Object.entries(code).map(([s, v]) => ({ item: s, value: v.lines }))),
    gameTime: perSeed(Object.entries(code).map(([s, v]) => ({ item: s, value: v.worldMs / 1000 }))),
    failed: perSeed(Object.keys(code).map((s) => ({ item: s, value: 0 }))),
    decisionMs: { value: 0, n: 3, method: "none" },
    memory: perSeed(Object.keys(code).map((s) => ({ item: s, value: 0 }))),
  };
  contestants.push({
    id: "code.planner",
    name: "Code planner",
    short: "Code planner",
    kind: "code",
    color: COLORS.code,
    default: true,
    runSets: [],
    policy: "hand-written landing heuristic, instant",
  });

  const metrics: MetricDef[] = [
    GAME_METRICS[0],
    {
      id: "gameTime",
      label: "Game time for 40 pieces",
      unit: "s",
      better: "lower",
      axis: "speed",
      help: "World time to place 40 pieces. Gravity never waits, so slow or failed answers stretch the game.",
    },
    {
      id: "failed",
      label: "Failed requests",
      unit: "count",
      better: "lower",
      axis: "cost",
      help: "Requests that failed and were asked again, almost all 429 rate limits.",
    },
    GAME_METRICS[3],
    {
      id: "memory",
      label: "Judgements reused",
      unit: "count",
      better: "higher",
      axis: "cost",
      help: "Spot judgements answered from memory instead of a request.",
    },
  ];

  return {
    id: "tetris-realtime",
    title: "Does the better question survive real time?",
    question:
      "The same designs with gravity running: slow answers cost pieces, and rate limits cost time.",
    family: "game",
    reference: "world-outcome",
    metrics,
    primary: "lines",
    contestants,
    results,
    items: [7, 19, 42].map((s) => ({ id: String(s), label: `Seed ${s}` })),
    provenance:
      "Lines cleared in 40-piece real-time games · seeds 7, 19, 42 · one game per design, one request in flight · two protocols: run 1 re-asks every 400 ms (22 Sep), run 2 backs off 0.4–4 s (23 Sep 2026) · typesafe-ai/jev via AI Gateway · code planner computed at build",
    chunks: { replay },
    lenses: ["bars", "per-item", "scatter", "table", "board"],
    protocolGroups: sets.map((s) => ({ hash: s.protocolHash, label: s.label, runSets: [s.id] })),
  };
}

// ---------------------------------------------------------------- Café Jev
/**
 * The 102 authored café cases. Jev's recorded answers and two code baselines go
 * through the same café engine. The reference is the authored expectation for
 * each case, written before the calls but not independently annotated.
 */
export function cafeCard(out: string): Card {
  const record = cafeRecordSchema.parse(readRecord(resolve(lab, "cafe-jev/cafe.jsonl"))),
    doc = record.result,
    recordedOn = record.manifest.created.slice(0, 10);

  const rows = doc.rows;

  const gold = (c: (typeof CASES)[number], f: Field) => {
    const e = c.expected[f];

    return e.status === "unknown" || e.status === "conflicting"
      ? e.status
      : `${e.status}_${e.value}`;
  };

  // A per-field prior fitted on these same cases: how often each token is the expected one.
  const fitPrior = (f: Field) => {
    const counts = Object.fromEntries(tokensFor(f).map((t) => [t, 0]));

    for (const c of CASES) counts[gold(c, f)]++;

    return Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n / CASES.length]));
  };

  const prior = new Map(FIELDS.map((f) => [f, fitPrior(f)]));

  const contestants = [
    {
      id: "jev",
      name: "Jev · recorded",
      short: "Jev",
      kind: "hosted" as const,
      model: "typesafe-ai/jev",
      policy: "seven typed preference questions plus a source turn each; code checks recipes",
      color: COLORS.jev,
    },
    {
      id: "code.keywords",
      name: "Keyword reader",
      short: "Keyword reader",
      kind: "code" as const,
      policy:
        "keyword and negation rules written after reading these cases and their expected answers; an optimistic ceiling for rules, not a held-out baseline; one-hot answers",
      color: COLORS.code,
    },
    {
      id: "code.prior",
      name: "Most common answer",
      short: "Most common answer",
      kind: "code" as const,
      policy:
        "answers each field with its most common expected token across these same cases; optimistic because it is fitted on the evaluation set",
      color: COLORS.code3,
    },
  ];

  const caseRows = CASES.map((c) => {
    const row = rows.find((r) => r.id === c.id);

    if (!row) throw new Error("A declared café case has no recorded row");

    return { c, row };
  });

  const answersFor = (id: string, c: (typeof CASES)[number], row: CafeRow) =>
    id === "jev"
      ? row.response.answers
      : id === "code.keywords"
        ? keywordAnswers(c.input)
        : priorAnswers(c.input, (f) => prior.get(f) ?? fitPrior(f));

  type Outcome = {
    exact: boolean;
    fields: number;
    feasibleExact: boolean;
    violation: boolean;
    suggested: string | null;
    tokens: Record<string, string>;
    dists: number[][];
  };

  const outcomes: Record<string, Outcome[]> = {};

  for (const ct of contestants)
    outcomes[ct.id] = caseRows.map(({ c, row }) => {
      const answers = answersFor(ct.id, c, row),
        decision = interpret({ answers }, c.input);

      const cmp = comparePreferences(decision.preferences, c.expected);
      const expectedFeasible = candidates(c.expected, c.input.inventory);

      const same = <T>(a: T[], b: T[]) =>
        JSON.stringify(a.map((r) => JSON.stringify(r)).sort()) ===
        JSON.stringify(b.map((r) => JSON.stringify(r)).sort());

      return {
        exact: cmp.exact,
        fields: FIELDS.filter((f) => cmp.perField[f]).length,
        feasibleExact: same(decision.feasible, expectedFeasible),
        violation: Boolean(
          decision.suggested &&
          constraintErrors(decision.suggested, c.expected, c.input.inventory).length,
        ),
        suggested: decision.suggested ? drinkName(decision.suggested) : null,
        tokens: Object.fromEntries(FIELDS.map((f) => [f, String(answers[f]?.value ?? "unknown")])),
        dists: FIELDS.map((f) => {
          const p = answers[f]?.probabilities ?? { [String(answers[f]?.value)]: 1 };

          return tokensFor(f).map((t) => Number(p[t] ?? 0));
        }),
      };
    });

  const metrics: MetricDef[] = [
    {
      id: "exact",
      label: "Understood every preference",
      unit: "%",
      better: "higher",
      axis: "accuracy",
      help: "Share of cases where all seven interpreted preferences (value and strength) match the authored expectation.",
    },
    {
      id: "fields",
      label: "Preferences right",
      unit: "%",
      better: "higher",
      axis: "accuracy",
      help: "Share of the seven preference fields per case that match the authored expectation after the café engine interprets the answer.",
    },
    {
      id: "feasible",
      label: "Right set of drinks",
      unit: "%",
      better: "higher",
      axis: "accuracy",
      help: "Share of cases where the interpreted preferences allow exactly the drinks the authored expectation allows.",
    },
    {
      id: "violation",
      label: "Served a drink that breaks a requirement",
      unit: "%",
      better: "lower",
      axis: "outcome",
      help: "Share of cases where the suggested drink, after the café engine's own checks, still breaks a requirement in the authored expectation (for example dairy for a dairy-free customer).",
    },
    {
      id: "ece",
      label: "Calibration error",
      unit: "",
      better: "lower",
      axis: "calibration",
      help: "Expected calibration error of the raw preference answers over ten confidence bins. The code baselines answer with certainty, so their error equals their miss rate.",
    },
    {
      id: "confidentWrong",
      label: "Confident but wrong",
      unit: "%",
      better: "lower",
      axis: "calibration",
      help: "Share of raw preference answers given with at least 70% probability that differ from the authored expectation.",
    },
  ];

  const group = (c: (typeof CASES)[number]) =>
    c.category === "finite-partial-state" ? "templated" : "hand-written";

  const stats = (id: string, idx: number[]) => {
    const o = outcomes[id],
      n = idx.length || 1;

    const answers = idx.flatMap((i) =>
      FIELDS.map((f, k) => ({
        prediction: o[i].dists[k].some((x) => x > 0) ? o[i].dists[k] : tokensFor(f).map(() => 1),
        reference: tokensFor(f).map((t) => (t === gold(CASES[i], f) ? 1 : 0)),
      })),
    );

    const card = score(answers);

    return {
      exact: idx.filter((i) => o[i].exact).length / n,
      fields: idx.reduce((s, i) => s + o[i].fields, 0) / (n * FIELDS.length),
      feasible: idx.filter((i) => o[i].feasibleExact).length / n,
      violation: idx.filter((i) => o[i].violation).length / n,
      ece: card.ece,
      confidentWrong: card.confidentButWrong / (card.decisions || 1),
    };
  };

  const estimate = (id: string, filter: (c: (typeof CASES)[number]) => boolean) => {
    const idx = CASES.map((c, i) => (filter(c) ? i : -1)).filter((i) => i >= 0);

    const point = stats(id, idx),
      ci = bootstrapGroupsMany(
        idx.map((i) => [i]),
        (s) => stats(id, s),
        1000,
      );

    return Object.fromEntries(
      Object.entries(point).map(([k, v]) => [
        k,
        {
          value: v,
          n: idx.length,
          ...ci.get(k),
          method: "bootstrap-case" as const,
        },
      ]),
    );
  };

  const results = Object.fromEntries(contestants.map((ct) => [ct.id, estimate(ct.id, () => true)]));
  const slices: Card["slices"] = { workflow: {} };

  for (const g of ["templated", "hand-written"])
    slices.workflow[g] = Object.fromEntries(
      contestants.map((ct) => [ct.id, estimate(ct.id, (c) => group(c) === g)]),
    );

  // Chunks in the typed-decisions shape, so the calibration and case views work unchanged: one row per case × field.
  const targets = {
    schema: "arena.targets/1",
    rows: CASES.flatMap((c, ci) =>
      FIELDS.map((f) => ({
        c: ci,
        key: f,
        type: f,
        wf: group(c),
        keys: tokensFor(f),
        target: tokensFor(f).map((t) => (t === gold(c, f) ? 1 : 0)),
      })),
    ),
  };

  mkdirSync(join(out, "preds"), { recursive: true });
  writeFileSync(join(out, "cafe.targets.json"), JSON.stringify(targets));

  const option = (f: Field, t: string) =>
    t === "unknown"
      ? "not stated"
      : t === "conflicting"
        ? "contradictory"
        : `${t.startsWith("required") ? "must be" : "would like"} ${VALUES[f][t.replace(/^(required|preferred)_/, "")]}`;

  writeFileSync(
    join(out, "cafe.cases.json"),
    JSON.stringify({
      schema: "arena.cases/1",
      cases: CASES.map((c, ci) => ({
        id: c.id,
        workflow: group(c),
        state: {
          customer: c.input.transcript.map((t) => t.text),
          suggested: Object.fromEntries(
            contestants.map((ct) => [ct.short, outcomes[ct.id][ci].suggested ?? "nothing"]),
          ),
          breaksARequirement: contestants.flatMap((ct) =>
            outcomes[ct.id][ci].violation ? [ct.short] : [],
          ),
        },
        questions: FIELDS.map((f) => ({
          key: f,
          type: FIELD_LABELS[f].toLowerCase(),
          instructions: FIELD_LABELS[f],
          keys: tokensFor(f),
          options: tokensFor(f).map((t) => option(f, t)),
        })),
      })),
    }),
  );
  const preds: Record<string, string> = {};

  for (const ct of contestants) {
    preds[ct.id] = `preds/cafe.${ct.id}.json`;
    writeFileSync(
      join(out, preds[ct.id]),
      JSON.stringify({
        schema: "arena.preds/1",
        contestant: ct.id,
        p: outcomes[ct.id].flatMap((o) => o.dists.map((d) => d.map((x) => round(x)))),
      }),
    );
  }

  const rs = runSet(
    `${recordedOn}-cafe-jev`,
    "Café Jev, 102 authored cases",
    recordedOn,
    { benchmark: "cafe-jev", menu: doc.menuRevision, contract: "cafe-jev-turn-v1", cases: 102 },
    ["cafe-jev/cafe.jsonl.gz"],
  );

  return {
    id: "cafe",
    title: "What does the customer actually want?",
    question:
      "A customer describes a drink. Each contestant answers seven typed questions about their preferences; the café's own code then picks a legal recipe.",
    family: "judgement-set",
    reference: "authored-labels",
    metrics,
    primary: "exact",
    contestants: contestants.map((ct) => ({
      ...ct,
      default: true,
      runSets: ct.id === "jev" ? [rs.id] : [],
    })),
    results,
    slices,
    facetLabels: { workflow: "Cases" },
    provenance: `Agreement with authored expectations · 102 café cases (81 templated one-sentence states, 21 hand-written requests) · expectations written before the calls, not independently annotated · typesafe-ai/jev via AI Gateway, recorded ${new Date(recordedOn).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} · code baselines computed at build; the keyword rules were written after reading these cases and the most-common-answer baseline is fitted on them, so both are optimistic · 95% case-bootstrap intervals`,
    chunks: { preds, targets: "cafe.targets.json", cases: "cafe.cases.json" },
    lenses: ["bars", "scatter", "reliability", "table", "case"],
    protocolGroups: [{ hash: rs.protocolHash, label: rs.label, runSets: [rs.id] }],
  };
}

// ---------------------------------------------------------------- robustness
function robustnessCard(out: string): Card {
  const doc = robustnessSchema.parse(
    readJson(join(recordings, "robustness-position-summary.json")),
  );

  const rows = doc.rows;

  const variants: ["again" | "reversed" | "separate", string, CardContestant["color"]][] = [
    ["again", "Asked again, same order", PALETTE.conditionA],
    ["reversed", "Reversed order, labels reassigned", PALETTE.conditionB],
    ["separate", "Each sentence asked alone", PALETTE.conditionC],
  ];

  const results: Card["results"] = {};

  for (const [key] of variants) {
    const usable = rows.flatMap((r) => {
      const original = r.original,
        variant = r[key];

      return original && variant ? [{ sentences: r.sentences, original, variant }] : [];
    });

    const perBoard = usable.map((r) =>
      r.sentences.map((s) => Math.abs(r.original[s] - r.variant[s])),
    );

    const best = (j: Record<string, number>, order: string[]) =>
      order.reduce((b, s) => (j[s] > j[b] ? s : b), order[0]);

    const all = perBoard.flat();
    results[key] = {
      meanChange: {
        value: mean(all),
        n: usable.length,
        ...bootstrapGroups(perBoard, (s) => mean(s), 1000),
        method: "bootstrap-case",
      },
      moved: {
        value: all.filter((d) => d > 0.2).length / (all.length || 1),
        n: usable.length,
        ...bootstrapGroups(perBoard, (s) => s.filter((d) => d > 0.2).length / (s.length || 1), 1000),
        method: "bootstrap-case",
      },
      sameChoice: {
        value:
          usable.filter((r) => best(r.original, r.sentences) === best(r.variant, r.sentences))
            .length / (usable.length || 1),
        n: usable.length,
        method: "count",
      },
    };
  }

  writeFileSync(
    join(out, "robustness.rows.json"),
    JSON.stringify({ schema: "arena.robustness/1", rows }),
  );

  return {
    id: "spot-robustness",
    title: "Does Jev's judgement move when nothing meaningful changes?",
    question: "The same 30 boards asked again, in reverse order, and one spot per request.",
    family: "robustness",
    reference: "self-consistency",
    metrics: [
      {
        id: "meanChange",
        label: "Mean change in P(clean)",
        unit: "",
        better: "lower",
        axis: "robustness",
        help: "Average absolute change in a spot's judged probability compared with the original batched request.",
      },
      {
        id: "moved",
        label: "Judgements moved by more than 0.2",
        unit: "%",
        better: "lower",
        axis: "robustness",
        help: "Share of spot judgements that changed by more than 0.2.",
      },
      {
        id: "sameChoice",
        label: "Same chosen spot",
        unit: "%",
        better: "higher",
        axis: "robustness",
        help: "Share of boards where code would pick the same spot from the new judgements.",
      },
    ],
    primary: "meanChange",
    contestants: variants.map(([id, name, color]) => ({
      id,
      name,
      short: name,
      kind: "hosted" as const,
      model: "typesafe-ai/jev",
      policy: "judge each spot",
      color,
      default: true,
      runSets: ["2026-09-23-spot-clean-position"],
    })),
    results,
    provenance: `Judge each spot · 30 boards from the recorded turn games (seeds 7, 19, 42) · ${rows.reduce((s, r) => s + r.sentences.length, 0)} judgements · recorded 23 Sep 2026 · 95% board-bootstrap intervals`,
    chunks: { rows: "robustness.rows.json" },
    lenses: ["bars", "table"],
    protocolGroups: [
      {
        hash: sha("robustness-position").slice(0, 12),
        label: "Position and batching",
        runSets: ["2026-09-23-spot-clean-position"],
      },
    ],
  };
}

/** Metrics that measure a model call; code players make none, so they are omitted for them. */
const TIMING = new Set(["decisionMs", "latency", "failed", "memory"]);

const TRADEOFF = new Map<string, [string, string]>([
  ["tetris-turns", ["decisionMs", "lines"]],
  ["tetris-realtime", ["gameTime", "lines"]],
  ["spot-robustness", ["meanChange", "sameChoice"]],
  ["typed-decisions", ["ece", "agreement"]],
  ["cafe", ["violation", "exact"]],
  ["one-box", ["changes", "right"]],
]);

const INSIGHTS = new Map(
  Object.entries({
    "tetris-turns":
      "Asking Jev to judge each spot in a sentence, and letting code compare, cleared about twice as many lines as asking it to pick one landing from a list. It still trails the hand-written planner by about two lines.",
    "tetris-realtime":
      "With gravity running, judging each spot still clears the most lines, but rate limits stretch the game. Remembering only confident judgements keeps most of the lines in about half the time.",
    "spot-robustness":
      "Asking twice barely moves Jev's judgement; reversing the order never changed a chosen spot. Asking about spots one at a time moves judgements most, so batching helps as well as saving requests.",
    "typed-decisions":
      "Jev agrees with the reference most often and its stated confidence tracks how often it agrees. Qwen3-4B, scored on its label probabilities, is often confident and wrong.",
    "one-box":
      "Jev's box ends on the right card for 94% of the 50 held-out phrases (98% of the 150 development ones), against 70% for Laya and 62% for Shapeshift's keyword rules, and it commits the fewest wrong cards on the way. Keeping the latest answer gets Jev to the right card sooner but makes the box change about twice as often. Nothing was tuned before the held-out run. The phrases were written by a model that never saw any contestant, which may still favour a model.",
    cafe: "Jev never served a drink that breaks a stated requirement. The keyword reader, written after reading these exact cases, gets more preferences exactly right but breaks a requirement in 3.9% of cases.",
  }),
);

/** A readable upper bound for a scale: 1, 2, 2.5 or 5 times a power of ten. */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));

  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function finalize(card: Card): Card {
  const code = new Set(card.contestants.filter((c) => c.kind === "code").map((c) => c.id));

  const tables = [
    card.results,
    ...Object.values(card.slices ?? {}).flatMap((f) => Object.values(f)),
  ];

  for (const table of tables)
    for (const [cid, perMetric] of Object.entries(table))
      if (code.has(cid)) for (const m of TIMING) delete perMetric[m];

  const metrics = card.metrics.map((m) => {
    const values = tables.flatMap((t) =>
      Object.values(t).flatMap((pm) => {
        const e = pm[m.id];

        return e ? [e.value, e.hi ?? e.value, ...(e.perItem?.map((p) => p.value) ?? [])] : [];
      }),
    );

    const domain: [number, number] =
      m.unit === "%" ? [0, 1] : [0, niceCeil(Math.max(0, ...values.filter(Number.isFinite)))];

    const out: MetricDef = { ...m, domain };

    if (TIMING.has(m.id)) out.timing = true;

    return out;
  });

  return { ...card, metrics, tradeoff: TRADEOFF.get(card.id), insight: INSIGHTS.get(card.id) };
}

export async function buildArena(outDir: string) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const cards = [
    await turnsCard(outDir),
    await realtimeCard(outDir),
    robustnessCard(outDir),
    studyCard(outDir),
    cafeCard(outDir),
    oneBoxCard(outDir, { recordings, phrases: resolve(here, "src/one-box/phrases.json") }, runSet),
  ].map(finalize);

  const runSets: RunSet[] = [
    runSet(
      "2026-09-20-typed-decisions",
      "Typed Decisions test split, 10 models",
      "2026-09-20",
      {},
      ["experience-prototypes/public/data/local-models.json"],
    ),
    runSet(
      "2026-09-22-tetris-turns-busy",
      "First turn attempt (provider busy)",
      "2026-09-22",
      { game: "tetris", timing: "turns" },
      ["packages/arena/recordings/attempt-1-provider-busy.jsonl.gz"],
      {
        standing: "availability-only",
        note: "Sent three requests at once and hit provider capacity; 93 of 127 failed. Measures availability, not the designs.",
      },
    ),
  ];

  const index: ArenaIndex = {
    schema: "arena.index/1",
    generatedAt: new Date().toISOString(),
    runSets,
    cards,
  };

  // Parse our own output: a card that does not match the schema fails the build.
  writeFileSync(join(outDir, "index.json"), JSON.stringify(arenaIndexSchema.parse(index)));

  return index;
}

if (import.meta.main) {
  const out = resolve(here, "../../experience-prototypes/public/arena");
  const index = await buildArena(out);
  console.log(
    JSON.stringify({
      cards: index.cards.map((c) => c.id),
      bytes: readFileSync(join(out, "index.json")).length,
    }),
  );
}
