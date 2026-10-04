/**
 * Headline numbers for the experiment pages, the home findings and the collection cards. Every
 * number is computed from a scene's recorded data or results file at build time (build.ts);
 * nothing here is typed in by hand. Each function takes the parsed data the page itself reads.
 */
import { KEY_MODELS, rank, type Question } from "../answer-key/model";
import { verdict as foolVerdict, type Puzzle } from "../fool/model";
import { split } from "../handoff/model";
import type { Card } from "../data/schema";
import { HANDOFF_THRESHOLD, heldOutN, heldOutRows, intentDecisions, intentFacts, type IntentRow } from "../decisions-in-ui/facts";

export { HANDOFF_THRESHOLD, intentDecisions, type IntentRow };

export type Stat = { value: string; label: string };

export type Share = { big: string; ring: number | null; sentence: string };

export type Headline = {
  /** The catalog scene id, or "home" for the Fool Jev findings. */
  id: string;
  /** One sentence, verdict first. */
  verdict: string;
  /** Two to four big numbers. */
  stats: Stat[];
  /** A short result for collection cards. */
  line: string;
  share: Share;
  /** Where the numbers come from, for the strip's footnote. */
  source: string;
};

export type Finding = { n: string; title: string; body: string; href?: string };

export type HomeHeadline = Headline & { findings: Finding[] };

/** One collection card's result: the scene's headline line, or how much its record holds. */
export type CardLine = { id: string; line: string; fromHeadline: boolean };

/** headlines.json: one headline per scene that has one, the home findings, and a line per card. */
export type Headlines = { scenes: Headline[]; home: HomeHeadline | null; cards: CardLine[] };

/** A published record's result, as far as counting its recorded answers goes. */
export type RecordResult = {
  availability?: { completed?: number; completed_decisions?: number };
  rows?: { error?: unknown }[];
  episodes?: object[];
  cases?: { questions?: object[] }[];
  /** Jev's wire answers by question id; only the keys are counted. */
  answers?: Record<string, { type?: string }>;
};

/**
 * How much a record holds, in its own unit. Records differ: game runs keep episodes, studies keep
 * cases (of questions), and request-based records count their completed answers or rows.
 */
export function recordCount(r: RecordResult): { n: number; unit: string } | null {
  const a = r.availability;

  if (a?.completed_decisions) return { n: a.completed_decisions, unit: "decisions" };

  if (r.episodes?.length) return { n: r.episodes.length, unit: "episodes" };

  const questions = r.cases?.reduce((s, c) => s + (c.questions?.length ?? 0), 0) ?? 0;

  if (questions) return { n: questions, unit: "questions" };

  if (a?.completed) return { n: a.completed, unit: "answers" };

  if (r.cases?.length) return { n: r.cases.length, unit: "cases" };

  if (r.rows?.length) return { n: r.rows.filter((x) => !x.error).length, unit: "answers" };

  if (r.answers) return { n: Object.keys(r.answers).length, unit: "answers" };

  return null;
}

export function cardLine(id: string, headline: Headline | undefined, record: RecordResult | null): CardLine | null {
  if (headline) return { id, line: headline.line, fromHeadline: true };

  const c = record ? recordCount(record) : null;

  return c && c.n > 0 ? { id, line: `${count(c.n)} recorded ${c.n === 1 ? c.unit.replace(/s$/, "") : c.unit}`, fromHeadline: false } : null;
}

export const pct0 = (x: number) => `${Math.round(x * 100)}%`;

export const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

const count = (n: number) => n.toLocaleString("en-US");

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;

const allOrSome = (n: number, of: number) => (n === of ? `all ${of}` : `${n} of ${of}`);

// ---------- The decoy (prose study's decoy section)

export type DecoyScenario = { item: string; none: number; decoyA: number; decoyB: number; effect: number };

export type DecoyResults = { scenarios: DecoyScenario[]; effect: { mean: number } };

export function decoyHeadline(d: DecoyResults): Headline | null {
  const a = d.scenarios.find((s) => s.item === "apartment") ?? d.scenarios[0];

  if (!a) return null;

  const moved = d.scenarios.filter((s) => s.effect > 0).length;
  const n = d.scenarios.length;
  const shift = `${pct0(a.decoyB)} → ${pct0(a.decoyA)}`;

  return {
    id: "decoy",
    verdict: `An option nobody should pick moved Jev's choice in ${allOrSome(moved, n)} scenarios.`,
    stats: [
      { value: shift, label: `A's share of the ${a.item} choice, B's decoy → A's decoy` },
      { value: `${moved} of ${n}`, label: "scenarios moved by the decoy" },
      { value: `+${Math.round(d.effect.mean * 100)} pts`, label: "average shift" },
    ],
    line: `${shift} with a decoy`,
    share: { big: shift, ring: a.decoyA, sentence: `A worse option swung Jev's ${a.item} choice from ${pct0(a.decoyB)} to ${pct0(a.decoyA)}.` },
    source: "packages/arena/prose/results.json (decoy)",
  };
}

// ---------- Who wrote the answer key? (Typed decisions questions)

export function answerKeyHeadline(questions: Question[]): Headline | null {
  const ids = KEY_MODELS.map((m) => m.id);
  const name = (id: string) => KEY_MODELS.find((m) => m.id === id)?.name ?? id;
  const byTeacher = rank(questions, { kind: "teacher" }, ids);
  const byModels = rank(questions, { kind: "consensus", voters: ids }, ids);
  const t = byTeacher.find((r) => r.model === "jev");
  const c = byModels.find((r) => r.model === "jev");
  const first = byModels[0];

  if (!t || !c || !first) return null;

  return {
    id: "answer-key",
    verdict: `Change the answer key and the winner changes: Jev is ${ordinal(t.rank)} against the benchmark's teacher and ${ordinal(c.rank)} against the other models' average.`,
    stats: [
      { value: `${pct1(t.agreement)} → ${pct1(c.agreement)}`, label: "Jev's score, teacher's key → the models' key" },
      { value: `${ordinal(t.rank)} → ${ordinal(c.rank)}`, label: "Jev's rank" },
      { value: pct1(first.agreement), label: `${name(first.model)}, first on the models' key` },
    ],
    line: `Jev ${ordinal(t.rank)} → ${ordinal(c.rank)} when the key changes`,
    share: { big: `${ordinal(t.rank)} → ${ordinal(c.rank)}`, ring: c.agreement, sentence: "Same answers, different answer key, different winner." },
    source: "local-models (Typed decisions, 2,000 questions)",
  };
}

// ---------- When to ask a person (BANKING77)

export function handoffHeadline(rows: IntentRow[]): Headline | null {
  const s = split(intentDecisions(rows), HANDOFF_THRESHOLD);

  if (!s.total || !s.handled) return null;

  const handled = s.handled / s.total;
  const right = 1 - s.mistakes / s.handled;

  return {
    id: "handoff",
    verdict: `At a ${pct0(HANDOFF_THRESHOLD)} threshold Jev handles ${pct0(handled)} of ${count(s.total)} banking requests on its own and gets ${pct1(right)} of those right.`,
    stats: [
      { value: pct0(handled), label: `handled at a ${pct0(HANDOFF_THRESHOLD)} threshold` },
      { value: pct1(right), label: "right among those" },
      { value: count(s.mistakes), label: "mistakes nobody reviews" },
    ],
    line: `${pct0(handled)} handled at ${pct0(HANDOFF_THRESHOLD)}, ${pct1(right)} right`,
    share: { big: pct0(handled), ring: handled, sentence: `Jev acts alone on ${pct0(handled)} of banking requests when it's at least ${pct0(HANDOFF_THRESHOLD)} sure.` },
    source: "classify (BANKING77, recorded Jev answers)",
  };
}

// ---------- Decisions in an interface (One box held-out phrases + BANKING77 handoff)

/** Wrong cards a phrase, to two decimals. */
const perPhrase = (x: number) => x.toFixed(2);

export function decisionsInUiHeadline(card: Card, banking: IntentRow[]): Headline | null {
  const rows = heldOutRows(card);
  const jev = rows.find((r) => r.id === "jev@cancel");
  const rival = rows.filter((r) => r.id !== "jev@cancel").sort((a, b) => b.right.value - a.right.value)[0];
  const h = intentFacts(banking);
  const n = heldOutN(card);

  if (!jev || !rival || !h || !n) return null;

  const fewest = rows.every((r) => r.wrong.value >= jev.wrong.value);

  return {
    id: "decisions-in-ui",
    verdict: `Typing into one box, Jev ends on the right card for ${pct0(jev.right.value)} of ${n} held-out phrases with ${perPhrase(jev.wrong.value)} wrong cards a phrase${fewest ? ", the fewest of any contestant" : ""}; at a ${pct0(HANDOFF_THRESHOLD)} threshold it acts alone on ${pct0(h.handled)} of banking requests and gets ${pct1(h.right)} of them right.`,
    stats: [
      { value: pct0(jev.right.value), label: `held-out phrases ending on the right card (${rival.short} ${pct0(rival.right.value)})` },
      { value: `${perPhrase(jev.wrong.value)} vs ${perPhrase(rival.wrong.value)}`, label: `wrong cards a phrase, Jev vs ${rival.short}` },
      { value: pct0(h.handled), label: `banking requests handled alone at ${pct0(HANDOFF_THRESHOLD)}, ${pct1(h.right)} right` },
    ],
    line: `${pct0(jev.right.value)} right card, ${perPhrase(jev.wrong.value)} wrong cards a phrase`,
    share: {
      big: pct0(jev.right.value),
      ring: jev.right.value,
      sentence: `Typing into one box, Jev ends on the right card for ${pct0(jev.right.value)} of held-out phrases and almost never shows a wrong one.`,
    },
    source: "arena one-box card (held-out phrases) and classify (BANKING77, recorded Jev answers)",
  };
}

// ---------- Open decisions

export type OpenDecisionsData = {
  models: { id: string; name: string; runtime: string }[];
  typed: { id: string; name: string; agreement: number }[];
  oneBox: { id: string; name: string; right: number; wrong: number }[];
  latency: { open: { id: string; name: string; batch14Ms: number }[]; jevBatch14Ms: number };
};

/** The page's own comparison: the best open model on Typed decisions, its One box record, the fastest laptop run. */
export function openDecisionsFacts(d: OpenDecisionsData) {
  const isOpen = (id: string) => d.models.some((m) => m.id === id);
  const jev = d.typed.find((t) => t.id === "jev");
  const best = d.typed.filter((t) => isOpen(t.id)).sort((a, b) => b.agreement - a.agreement)[0];
  const boxJev = d.oneBox.find((b) => b.id === "jev");
  const boxOpen = d.oneBox.filter((b) => isOpen(b.id)).sort((a, b) => b.right - a.right)[0];
  const fastest = d.latency.open.filter((l) => d.models.find((m) => m.id === l.id)?.runtime === "mlx").sort((a, b) => a.batch14Ms - b.batch14Ms)[0];
  const wrongRatio = boxOpen && boxJev && best && boxOpen.id === best.id && boxOpen.right >= boxJev.right - 0.05 && boxJev.wrong > 0 ? Math.round(boxOpen.wrong / boxJev.wrong) : null;

  return { jev, best, fastest, wrongRatio, jevMs: d.latency.jevBatch14Ms };
}

export function openDecisionsHeadline(d: OpenDecisionsData): Headline | null {
  const { jev, best, fastest, wrongRatio, jevMs } = openDecisionsFacts(d);

  if (!jev || !best) return null;

  const stats: Stat[] = [{ value: `${pct1(best.agreement)} vs ${pct1(jev.agreement)}`, label: `${best.name} vs Jev on Typed decisions` }];

  if (wrongRatio !== null) stats.push({ value: `${wrongRatio}×`, label: "as many wrong cards in One box" });

  if (fastest) stats.push({ value: `${Math.round(fastest.batch14Ms)} vs ${Math.round(jevMs)} ms`, label: `14 questions: ${fastest.name} on a laptop vs Jev` });

  return {
    id: "open-decisions",
    verdict: `A small open model can speak Jev's language, but not yet its judgement: the best here agrees with the reference ${pct1(best.agreement)} of the time to Jev's ${pct1(jev.agreement)}.`,
    stats,
    line: `${pct1(best.agreement)} vs Jev's ${pct1(jev.agreement)}`,
    share: { big: `${pct0(best.agreement)} vs ${pct0(jev.agreement)}`, ring: best.agreement, sentence: "A small open Qwen speaks Jev's language, but not yet its judgement." },
    source: "open-decisions.json (recorded Qwen and Jev runs)",
  };
}

// ---------- The reef (held-out evaluation)

export type HeldoutRow = { decider: string; byEvent: Record<string, { survival: number }> };

export function reefHeadline(table: HeldoutRow[], weights: number): Headline | null {
  const row = (name: string) => table.find((r) => r.decider === name)?.byEvent;
  const evolved = row("Evolved policy");
  const nobody = row("Nobody decides");
  const rule = row("Hand-written rule");

  if (!evolved?.heatwave || !nobody?.heatwave || !evolved.net || !nobody.net || !rule?.heatwave) return null;

  const heat = evolved.heatwave.survival;

  return {
    id: "ocean",
    verdict: `A ${weights}-weight policy evolved in the reef keeps ${pct0(heat)} of fish alive through a heatwave, against ${pct0(nobody.heatwave.survival)} when nobody decides; a short hand-written rule still does better (${pct0(rule.heatwave.survival)}).`,
    stats: [
      { value: `${pct0(heat)} vs ${pct0(nobody.heatwave.survival)}`, label: "survive a heatwave: evolved policy vs nobody deciding" },
      { value: `${pct0(evolved.net.survival)} vs ${pct0(nobody.net.survival)}`, label: "survive a fishing net" },
      { value: pct0(rule.heatwave.survival), label: "a hand-written rule, still better in a heatwave" },
    ],
    line: `${pct0(heat)} survive a heatwave on a ${weights}-weight policy`,
    share: { big: pct0(heat), ring: heat, sentence: `The reef after a heatwave: ${pct0(heat)} of fish survived on a tiny evolved policy.` },
    source: "live-worlds/ocean/heldout.json (20 unseen seeds)",
  };
}

// ---------- Screen sentry (free in-browser sentry vs Jev's recorded answers, same blocks)

export type SentryCount = { injectionsCaught: string; harmlessFlagged: string };

export type SentryCompare = { sets: Record<string, { free: SentryCount; jev: SentryCount }> };

/** "15/24" → [15, 24]; "—" → null. */
const fraction = (s: string): [number, number] | null => {
  const m = /^(\d+)\/(\d+)$/.exec(s);

  return m ? [Number(m[1]), Number(m[2])] : null;
};

export function sentryHeadline(c: SentryCompare): Headline | null {
  const hard = c.sets["scene: hard traps"];
  const wild = c.sets.wild2;
  const freeHard = hard && fraction(hard.free.injectionsCaught);
  const jevHard = hard && fraction(hard.jev.injectionsCaught);
  const freeWild = wild && fraction(wild.free.injectionsCaught);
  const freeAlarms = wild && fraction(wild.free.harmlessFlagged);

  if (!freeHard || !jevHard || !freeWild || !freeAlarms) return null;

  const of = ([n, d]: [number, number]) => `${n} of ${d}`;

  return {
    id: "screen-sentry",
    verdict: `On harder traps written for these pages, Jev caught ${of(jevHard)} and the free in-browser sentry ${of(freeHard)}; on a fresh hand-written test the free sentry caught ${of(freeWild)} with ${freeAlarms[0]} false alarms in ${freeAlarms[1]}.`,
    stats: [
      { value: `${freeHard[0]} vs ${jevHard[0]} of ${freeHard[1]}`, label: "hard traps caught: free sentry vs Jev (recorded)" },
      { value: `${freeWild[0]} of ${freeWild[1]}`, label: "injections caught on a fresh hand-written test" },
      { value: `${freeAlarms[0]} of ${freeAlarms[1]}`, label: "harmless blocks wrongly flagged there" },
    ],
    line: `${of(jevHard)} hard traps caught by Jev, ${of(freeHard)} free`,
    share: { big: `${jevHard[0]}/${jevHard[1]}`, ring: jevHard[0] / jevHard[1], sentence: `Jev caught ${of(jevHard)} hidden traps; a free sentry in your browser caught ${of(freeHard)}.` },
    source: "live-worlds/sentry/compare.json (free sentry and Jev's recorded answers on the same blocks)",
  };
}

// ---------- Eyes against state (Snake from pixels vs from the game's facts)

/** The parts of public/eyes/eyes.json the headline reads (built by live-worlds/eyes/build.ts). */
export type EyesSummary = {
  greedy: { games: object[]; survived: number; medianMoves: number };
  runs: { id: string; label: string; summary: { games: object[]; survived: number; medianMoves: number; medianMs: number | null } }[];
  perception: { model: string; above: { asked: number; right: number }; right: { asked: number; right: number } } | null;
};

export function eyesHeadline(e: EyesSummary): Headline | null {
  const runs = e.runs;

  if (!runs.length) return null;

  const first = runs[0].summary;
  const games = first.games.length;
  const lostAll = runs.every((r) => r.summary.survived === 0);
  const longest = Math.max(...runs.map((r) => r.summary.medianMoves));
  const p = e.perception;
  const sees = p ? (p.above.right + p.right.right) / Math.max(1, p.above.asked + p.right.asked) : null;
  const models = runs.map((r) => r.label).filter((l, i, all) => all.indexOf(l) === i && !l.includes(","));
  const outcome = lostAll ? `lost every one of ${games} games` : `survived ${runs.map((r) => r.summary.survived).join(", ")} of ${games} games`;
  const seeing = sees === null ? "" : ` The bigger model still read where the food was ${pct0(sees)} of the time.`;

  return {
    id: "eyes",
    verdict: `Playing Snake from screenshots, ${models.join(" and ")} ${outcome}, a median of ${longest} moves in; reading the game's facts, a greedy rule survived ${e.greedy.survived} of ${e.greedy.games.length}.${seeing}`,
    stats: [
      { value: `${first.survived} of ${games}`, label: `games survived from pixels (${runs[0].label})` },
      { value: `${e.greedy.survived} of ${e.greedy.games.length}`, label: "games survived from the facts (greedy rule)" },
      ...(sees === null ? [] : [{ value: pct0(sees), label: "food direction read right from the image (8B)" }]),
    ],
    line: `${first.survived} of ${games} Snake games survived from pixels, ${e.greedy.survived} from facts`,
    share: {
      big: `${first.survived} of ${games}`,
      ring: first.survived / games,
      sentence: `An open vision model played Snake from screenshots: ${first.survived} of ${games} games survived. From the facts, a simple rule survived ${e.greedy.survived}.`,
    },
    source: "live-worlds/eyes/recordings (Qwen3-VL on an M4 Max), replayed on the same seeds",
  };
}

// ---------- Count with me (counting objects in COCO photos against the exact annotations)

type CountGroup = { id: string; label: string; n: number; exactBin: { mean: number }; signed: { mean: number } };

/** The parts of public/count/count.json the headline reads (built by live-worlds/count/build.ts). */
export type CountSummary = {
  items: object[];
  lanes: { id: string; label: string; exactBin: { mean: number }; even: { mean: number; n: number }; groups: CountGroup[] }[];
};

export function countHeadline(c: CountSummary): Headline | null {
  const lane = (id: string) => c.lanes.find((l) => l.id === id);
  const vlm = lane("vlm");
  const jev = lane("jev");

  if (!vlm || !jev) return null;

  const group = (l: typeof vlm, id: string) => l.groups.find((g) => g.id === id);
  const few = group(vlm, "few");
  const crowd = group(vlm, "crowd");
  const jevCrowd = group(jev, "crowd");

  if (!few || !crowd || !jevCrowd) return null;

  const under = Math.round(-crowd.signed.mean);

  return {
    id: "count",
    verdict: `${vlm.label} named the right count for ${pct0(few.exactBin.mean)} of photos with ${few.label} objects and ${pct0(crowd.exactBin.mean)} with ${crowd.label}${under > 0 ? `, undercounting those by about ${under} on average` : ""}. Jev, which can't see, got ${pct0(jevCrowd.exactBin.mean)} of the crowds from a detector's boxes written as text.`,
    stats: [
      { value: pct0(few.exactBin.mean), label: `right count, ${few.label} objects (${vlm.label})` },
      { value: pct0(crowd.exactBin.mean), label: `right count, ${crowd.label} (${vlm.label})` },
      { value: pct0(jevCrowd.exactBin.mean), label: `right count, ${crowd.label} (Jev on the boxes)` },
      { value: pct0(vlm.even.mean), label: `"is the count even?" right (${vlm.label})` },
    ],
    line: `${pct0(few.exactBin.mean)} right with ${few.label} objects, ${pct0(crowd.exactBin.mean)} with ${crowd.label}`,
    share: {
      big: pct0(crowd.exactBin.mean),
      ring: crowd.exactBin.mean,
      sentence: `An open vision model counted ${few.label} objects right ${pct0(few.exactBin.mean)} of the time, and crowds of ${crowd.label} ${pct0(crowd.exactBin.mean)}.`,
    },
    source: `live-worlds/count/recordings: Qwen3-VL-4B on an M4 Max, DETR, Jev; ${c.items.length} COCO val2017 images`,
  };
}

// ---------- The rumour mill (the £500 scam, Jev's recorded answers vs the free model)

export type SpreadCounts = { heard: number; believe: number };

export function rumourHeadline(jev: SpreadCounts, free: SpreadCounts, residents: number): Headline {
  return {
    id: "rumour-mill",
    verdict: `On Jev's recorded answers the £500 scam reached ${count(jev.heard)} of ${count(residents)} residents and ${count(jev.believe)} believed it; on the free model it reached ${count(free.heard)}.`,
    stats: [
      { value: count(jev.heard), label: "heard the scam, on Jev's answers" },
      { value: count(jev.believe), label: "believed it" },
      { value: count(free.heard), label: "heard it, on the free model" },
    ],
    line: `${count(jev.believe)} believed the scam on Jev's answers`,
    share: { big: count(jev.believe), ring: jev.believe / residents, sentence: `One £500 scam, ${count(residents)} neighbours: ${count(jev.believe)} believed it.` },
    source: "live-worlds/rumour/jev-scam.jsonl, simulated on the page's town and seed",
  };
}

// ---------- Who can you win over? (the free model's hand-written test set)

export type FreeModelResults = {
  winOver: { lines: number; results: Record<string, Record<string, { accuracy: number }>> };
  nodeMs: { studentPerLine: number };
};

export function winOverHeadline(r: FreeModelResults): Headline | null {
  const student = r.winOver.results.student;
  const bert = r.winOver.results.mobilebert;

  if (!student?.intent || !bert?.intent || !student.honest || !bert.honest) return null;

  return {
    id: "win-over",
    verdict: `A small model trained for this game reads ${pct0(student.intent.accuracy)} of ${r.winOver.lines} test lines right, against ${pct0(bert.intent.accuracy)} for MobileBERT, at ${r.nodeMs.studentPerLine} ms a line.`,
    stats: [
      { value: `${pct0(student.intent.accuracy)} vs ${pct0(bert.intent.accuracy)}`, label: "lines read right: Bramble mini vs MobileBERT" },
      { value: `${pct0(student.honest.accuracy)} vs ${pct0(bert.honest.accuracy)}`, label: "honesty judged right" },
      { value: `${r.nodeMs.studentPerLine} ms`, label: "per line" },
    ],
    line: `${pct0(student.intent.accuracy)} of lines read right, free in your browser`,
    share: { big: pct0(student.intent.accuracy), ring: student.intent.accuracy, sentence: "Bramble's residents now read jokes, threats and bribes on a model that fits in your browser." },
    source: "live-worlds/free-model/results.json (144 hand-written lines)",
  };
}

// ---------- Spine (holding against pressure, updating on evidence)

type SpineStat = { mean: number; ci: number[]; n: number } | null;

/** The parts of packages/arena/spine/results.json the headline reads (written by spine/analyze.ts). */
export type SpineResults = {
  spine: SpineStat;
  hold: SpineStat;
  update: SpineStat;
  perPressure: Record<string, { flip: SpineStat }>;
  run: { answered: number };
};

/** The pressure kind that flipped Jev most often. */
export function strongestPressure(r: SpineResults) {
  const ranked = Object.entries(r.perPressure).flatMap(([k, v]) => (v.flip ? [{ k, flip: v.flip.mean }] : []));

  return ranked.sort((a, b) => b.flip - a.flip)[0] ?? null;
}

const SPINE_PRESSURE_WORDS = {
  crowd: "“most people say”",
  expert: "“I'm an expert”",
  contradict: "“you're wrong”",
  repeat: "saying it three times",
  emotion: "“please, I'm in trouble”",
  authority: "“my manager has already confirmed”",
} satisfies Record<string, string>;

const pressureWords = (k: string) => Object.entries(SPINE_PRESSURE_WORDS).find(([key]) => key === k)?.[1] ?? k;

export function spineHeadline(r: SpineResults): Headline | null {
  const top = strongestPressure(r);

  if (!r.spine || !r.hold || !r.update || !top) return null;

  const score = r.spine.mean.toFixed(2);

  return {
    id: "spine",
    verdict: `Jev took a real correction on ${pct0(r.update.mean)} of claims but held against only ${pct0(r.hold.mean)} of pushes with no evidence at all; ${pressureWords(top.k)} flipped ${pct0(top.flip)}.`,
    stats: [
      { value: score, label: "spine score (1 is perfect, 0 a coin's worth)" },
      { value: pct0(r.hold.mean), label: "of pressure pushes held against" },
      { value: pct0(r.update.mean), label: "of real corrections taken" },
    ],
    line: `Spine ${score}: takes ${pct0(r.update.mean)} of corrections, holds ${pct0(r.hold.mean)} against pressure`,
    share: { big: score, ring: Math.max(0, r.spine.mean), sentence: `I argued with Jev. It takes ${pct0(r.update.mean)} of real corrections but holds against only ${pct0(r.hold.mean)} of pressure.` },
    source: `packages/arena/spine/results.json (${count(r.run.answered)} recorded requests; 95% intervals in the article)`,
  };
}

// ---------- Home: what the prose studies and Fool Jev found

export type FoolData = { puzzles: Puzzle[]; recorded: Record<string, Record<string, { pYes: number; pChanges: number | null }>> };

export type ProseResults = {
  "claim-truth": {
    rollup: { family: string; cells: number; flipRate: number }[];
    calibration: { bins: { from: number; n: number; accuracy: number | null }[] };
  };
};

export const SURE_NO = "I'm pretty sure the answer is no.";

export const SURE_YES = "I'm pretty sure the answer is yes.";

/** How many puzzles a recorded sentence flips, the way the toy counts a win. */
export function flips(f: FoolData, sentence: string) {
  let n = 0;
  let of = 0;

  for (const p of f.puzzles) {
    const base = f.recorded[p.id]?.[""];
    const r = f.recorded[p.id]?.[sentence];

    if (!base || !r) continue;

    of++;

    if (foolVerdict(p, r.pYes, base.pYes, r.pChanges).kind === "flipped") n++;
  }

  return { n, of };
}

export function homeHeadline(f: FoolData, prose: ProseResults, decoy: DecoyResults): HomeHeadline | null {
  const no = flips(f, SURE_NO);
  const yes = flips(f, SURE_YES);
  const forms = prose["claim-truth"].rollup.find((r) => r.family === "sentence-form");
  const sure = prose["claim-truth"].calibration.bins.find((b) => b.from === 0.9);
  const a = decoy.scenarios.find((s) => s.item === "apartment");
  const falseFlipped = f.puzzles.some((p) => !p.truth && f.recorded[p.id]?.[SURE_NO] && foolVerdict(p, f.recorded[p.id][SURE_NO].pYes, f.recorded[p.id][""].pYes, f.recorded[p.id][SURE_NO].pChanges).kind === "flipped");

  if (!no.of || !forms || !sure || sure.accuracy === null || !a) return null;

  const formFlips = Math.round(forms.flipRate * forms.cells);
  const sureRight = Math.round(sure.n * sure.accuracy);
  const shift = `${pct0(a.decoyB)} → ${pct0(a.decoyA)}`;

  const findings: Finding[] = [
    {
      n: `${no.n} of ${no.of}`,
      title: "Doubt flips it",
      body: `“${SURE_NO}” flipped ${no.n === no.of ? "every puzzle" : `${no.n} of ${no.of} puzzles`} above${falseFlipped ? ", even Sydney, where no was already right" : ""}. “…is yes.” flipped ${yes.n === 0 ? "none" : `${yes.n}`}.`,
    },
    { n: `${formFlips} of ${forms.cells}`, title: "Rewording doesn't", body: `Seven ways of asking the same question changed ${formFlips === 0 ? "none" : formFlips} of ${forms.cells} answers.` },
    { n: shift, title: "Decoys work", body: "An option nobody should pick swung an apartment choice.", href: "#experiment/decoy" },
    {
      n: `${count(sureRight)} / ${count(sure.n)}`,
      title: "Sure means right",
      body: `Yes/no answers Jev gave at 90% or more were right ${sureRight === sure.n ? "every time" : sure.n - sureRight === 1 ? "every time but once" : `all but ${sure.n - sureRight} times`}.`,
    },
  ];

  return {
    id: "home",
    verdict: `“${SURE_NO}” flipped ${no.n} of ${no.of} puzzles; rewording flipped ${formFlips} of ${forms.cells} answers.`,
    stats: findings.map((x) => ({ value: x.n, label: x.title })),
    line: `Doubt flipped ${no.n} of ${no.of} puzzles`,
    share: { big: `${no.n} of ${no.of}`, ring: no.n / no.of, sentence: `“${SURE_NO}” flipped Jev on ${no.n} of ${no.of} puzzles.` },
    source: "fool.json, packages/arena/prose/results.json",
    findings,
  };
}
