/**
 * Builds public/headlines/headlines.json from the files the pages themselves read: the published
 * records in public/, the prose study's results, the reef's held-out table, the free model's
 * test results and the rumour mill's recorded run. Runs last in prepare.ts, after those files
 * exist. A headline whose inputs are missing is left out, never invented.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scamComparison, type RecordedRow } from "../../../../live-worlds/rumour/compare";
import type { Vectors } from "../../../../live-worlds/rumour/similarity";
import { createTown } from "../../../../live-worlds/rumour/town";
import { experiments } from "../../../../experience-prototypes/src/catalog";
import {
  answerKeyHeadline,
  decisionsInUiHeadline,
  cardLine,
  decoyHeadline,
  eyesHeadline,
  countHeadline,
  handoffHeadline,
  homeHeadline,
  openDecisionsHeadline,
  reefHeadline,
  rumourHeadline,
  sentryHeadline,
  spineHeadline,
  winOverHeadline,
  type DecoyResults,
  type EyesSummary,
  type CountSummary,
  type FoolData,
  type FreeModelResults,
  type Headlines,
  type HeldoutRow,
  type IntentRow,
  type OpenDecisionsData,
  type ProseResults,
  type RecordResult,
  type SentryCompare,
  type SpineResults,
} from "./headlines";
import type { Question } from "../answer-key/model";
import type { Card } from "../data/schema";

/** The rumour mill's town, as the page builds it. */
export const RUMOUR_TOWN = { seed: 7, residents: 4000 };

/** A JSON file this repo's own builders write, or null if it isn't there. */
function read<T>(path: string): T | null {
  if (!existsSync(path)) return null;

  // SAFETY: every caller names the shape the file's builder writes and its page reads.
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export type HeadlineInputs = {
  prose: (ProseResults & { decoy: DecoyResults }) | null;
  fool: FoolData | null;
  questions: Question[] | null;
  banking: IntentRow[] | null;
  openDecisions: OpenDecisionsData | null;
  heldout: HeldoutRow[] | null;
  weights: number | null;
  freeModel: FreeModelResults | null;
  sentry: SentryCompare | null;
  rumour: { vectors: Vectors; messages: Record<string, number[]>; rows: RecordedRow[] } | null;
  eyes: EyesSummary | null;
  /** The One box arena card, from public/arena/index.json. */
  oneBox: Card | null;
  spine: SpineResults | null;
  count: CountSummary | null;
  /** Every catalog scene and its published record's result, for the collection cards. */
  records: { id: string; result: RecordResult | null }[];
};

/** Reads every input; `lab` is jev-experiments/, `app` is experience-prototypes/ after prepare. */
export function loadHeadlineInputs(lab: string, app: string): HeadlineInputs {
  const prose = read<ProseResults & { decoy: DecoyResults }>(join(lab, "packages/arena/prose/results.json"));
  const fool = read<FoolData>(join(app, "public/fool/fool.json"));
  const local = read<{ result?: { cases?: { questions: Question[] }[] } }>(join(app, "public/data/local-models.json"));
  const classify = read<{ result?: { experiments?: Record<string, { rows?: IntentRow[] }> } }>(join(app, "public/data/classify.json"));
  const openDecisions = read<OpenDecisionsData>(join(app, "public/open-decisions/open-decisions.json"));
  const heldout = read<{ table: HeldoutRow[] }>(join(lab, "live-worlds/ocean/heldout.json"));
  const policy = read<{ weights: number[] }>(join(lab, "live-worlds/ocean/policy.json"));
  const freeModel = read<FreeModelResults>(join(lab, "live-worlds/free-model/results.json"));
  const sentry = read<SentryCompare>(join(lab, "live-worlds/sentry/compare.json"));
  const vectors = read<Vectors & { messages: Record<string, number[]> }>(join(lab, "live-worlds/rumour/vectors.json"));
  const scam = join(lab, "live-worlds/rumour/jev-scam.jsonl");
  const eyes = read<EyesSummary>(join(app, "public/eyes/eyes.json"));
  const arena = read<{ cards: Card[] }>(join(app, "public/arena/index.json"));
  const spine = read<SpineResults>(join(lab, "packages/arena/spine/results.json"));
  const count = read<CountSummary>(join(app, "public/count/count.json"));

  const rows: RecordedRow[] = existsSync(scam)
    ? readFileSync(scam, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

  return {
    prose,
    fool,
    questions: local?.result?.cases?.flatMap((c) => c.questions) ?? null,
    banking: classify?.result?.experiments?.banking77?.rows ?? null,
    openDecisions,
    heldout: heldout?.table ?? null,
    weights: policy?.weights.length ?? null,
    freeModel,
    sentry,
    rumour: vectors && rows.length ? { vectors: { anchors: vectors.anchors, archetypes: vectors.archetypes, places: vectors.places }, messages: vectors.messages, rows } : null,
    eyes,
    oneBox: arena?.cards.find((c) => c.id === "one-box") ?? null,
    spine,
    count,
    records: experiments.map((e) => ({ id: e.id, result: e.data ? (read<{ result?: RecordResult }>(join(app, `public/data/${e.data}.json`))?.result ?? null) : null })),
  };
}

/** The rumour mill's headline: the scam spread on Jev's recording and on the free model. */
function rumour(r: NonNullable<HeadlineInputs["rumour"]>) {
  const town = createTown(RUMOUR_TOWN.seed, RUMOUR_TOWN.residents);
  const c = scamComparison(town, r.vectors, r.messages, r.rows);

  return c ? rumourHeadline(c.jev.counts, c.free.counts, town.residents.length) : null;
}

export function headlinesFrom(i: HeadlineInputs): Headlines {
  const scenes = [
    i.prose ? decoyHeadline(i.prose.decoy) : null,
    i.questions ? answerKeyHeadline(i.questions) : null,
    i.banking ? handoffHeadline(i.banking) : null,
    i.openDecisions ? openDecisionsHeadline(i.openDecisions) : null,
    i.heldout && i.weights ? reefHeadline(i.heldout, i.weights) : null,
    i.freeModel ? winOverHeadline(i.freeModel) : null,
    i.sentry ? sentryHeadline(i.sentry) : null,
    i.rumour ? rumour(i.rumour) : null,
    i.eyes ? eyesHeadline(i.eyes) : null,
    i.oneBox && i.banking ? decisionsInUiHeadline(i.oneBox, i.banking) : null,
    i.spine ? spineHeadline(i.spine) : null,
    i.count ? countHeadline(i.count) : null,
  ].filter((h) => h !== null);

  return {
    scenes,
    home: i.fool && i.prose ? homeHeadline(i.fool, i.prose, i.prose.decoy) : null,
    cards: i.records.flatMap((r) => cardLine(r.id, scenes.find((h) => h.id === r.id), r.result) ?? []),
  };
}

export function buildHeadlines(lab: string, app: string, outDir: string) {
  const out = headlinesFrom(loadHeadlineInputs(lab, app));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "headlines.json"), JSON.stringify(out) + "\n");

  return out.scenes.length + (out.home ? 1 : 0);
}
