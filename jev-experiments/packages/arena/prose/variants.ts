/**
 * Prose studies: every item × variant as the exact request Jev is sent, plus a reader that
 * turns the answer into the study's quantity. One question per request, so no variant sees
 * another's wording. Content is fixed by `items.ts`; only form changes here.
 */
import type { Payload } from "../../../experience-prototypes/server/gateway";
import { rng, type WireQuestion } from "../src/checkable/items";
import {
  ANCHOR_ITEMS,
  AMBIGUOUS_ITEMS,
  ATTRIBUTE_ITEMS,
  CHOICE_ITEMS,
  DECOY_ITEMS,
  FRAMING_ITEMS,
  LIKERT_ITEMS,
  TRUTH_ITEMS,
  type ChoiceItem,
  type ChoiceOption,
  type ClaimItem,
} from "./items";
import {
  cap,
  interleave,
  layouts,
  LONG_BACKGROUND,
  numbersAsWords,
  seedOf,
  shuffleFacts,
  typos,
} from "./text";
import { LANGUAGES, TRANSLATIONS } from "./translations";

export type Study =
  | "claim-truth"
  | "claim-ambiguous"
  | "choice"
  | "framing"
  | "attribute"
  | "anchor"
  | "decoy"
  | "likert";

/**
 * How an answer becomes the study's quantity.
 * - `yes`: P(claim) from one question: a yes/no (flipped when `polarity` is −1), a choice key,
 *   or score levels weighted by `weights`.
 * - `dist`: a distribution over canonical keys, from a choice (`keyMap` wire → canonical), a
 *   score (`keyMap` level index → canonical key), or one yes/no per option (`each`), renormalised.
 */
export type Reader =
  | { kind: "noul"; polarity: 1 | -1 }
  | { kind: "choice-yes"; yes: string }
  | { kind: "score-yes"; weights: number[] }
  | { kind: "dist"; from: "choice" | "score" | "each"; keyMap: Record<string, string> };

export type Job = {
  id: string;
  study: Study;
  family: string;
  variant: string;
  item: string;
  request: Payload;
  read: Reader;
  /** Never sent. A boolean for claims, a canonical key for choices, a level index for anchors. */
  truth?: boolean | string | number;
  /** Study-specific labels used by the analysis (frame, order, anchor, …). */
  meta?: Record<string, string>;
};

const single = (q: WireQuestion) => ({ q });
const noul = (instructions: string): WireQuestion => ({ type: "noul", instructions });

type ClaimVariant = {
  family: string;
  variant: string;
  instructions: string;
  polarity?: 1 | -1;
  state?: unknown;
  question?: WireQuestion;
  read?: Reader;
};

/** Wording variants: same state (JSON facts), one yes/no per request. */
function wording(it: ClaimItem): ClaimVariant[] {
  const q = it.question;
  const c = it.claim;
  const n = it.claimNeg;
  const seed = seedOf(it.id);

  return [
    { family: "baseline", variant: "canonical", instructions: q },
    { family: "baseline", variant: "repeat-1", instructions: q },
    { family: "baseline", variant: "repeat-2", instructions: q },

    { family: "sentence-form", variant: "declarative", instructions: `${cap(c)}.` },
    { family: "sentence-form", variant: "is-it-true", instructions: `Is it true that ${c}?` },
    { family: "sentence-form", variant: "true-or-false", instructions: `True or false: ${c}.` },
    { family: "sentence-form", variant: "imperative", instructions: `Determine whether ${c}.` },
    { family: "sentence-form", variant: "tag-question", instructions: `${cap(c)}, right?` },
    { family: "sentence-form", variant: "answer-yes-or-no", instructions: `Answer yes or no: ${q}` },
    { family: "sentence-form", variant: "answer-no-or-yes", instructions: `Answer no or yes: ${q}` },

    { family: "lexical-syntax", variant: "voice", instructions: it.voice },
    { family: "lexical-syntax", variant: "synonyms", instructions: it.synonym },
    {
      family: "lexical-syntax",
      variant: "center-embedded",
      instructions: `The question that the facts that are listed above bear on is whether or not, all things considered, ${c}.`,
    },

    { family: "length", variant: "terse", instructions: it.terse },
    {
      family: "length",
      variant: "verbose",
      instructions: `I have a question about the situation described above, and I would like you to consider all of the details carefully before answering. Taking everything that has been stated into account, ${q} Please answer with your best judgement, based only on the information provided.`,
    },

    {
      family: "register",
      variant: "formal",
      instructions: `Kindly ascertain, on the basis of the information provided, whether ${c}.`,
    },
    {
      family: "register",
      variant: "legal",
      instructions: `On the facts stated herein, and without regard to any matter not stated, determine whether it is the case that ${c}.`,
    },
    { family: "register", variant: "casual", instructions: `ok quick one lol, ${c}? yes or no` },
    {
      family: "register",
      variant: "child-directed",
      instructions: `Let's look at the facts together! Here's a little puzzle for you: ${q}`,
    },

    {
      family: "hedge-intensifier",
      variant: "hedge",
      instructions: `I might be wrong, but is it perhaps the case that ${c}?`,
    },
    {
      family: "hedge-intensifier",
      variant: "intensifier",
      instructions: `Is it absolutely, definitely, 100% true that ${c}?`,
    },

    { family: "noise", variant: "typos-light", instructions: typos(q, 0.05, seed + 1) },
    { family: "noise", variant: "typos-heavy", instructions: typos(q, 0.2, seed + 2) },
    { family: "noise", variant: "all-caps", instructions: q.toUpperCase() },
    {
      family: "noise",
      variant: "lowercase-no-punctuation",
      instructions: q.toLowerCase().replace(/[?.,!'’]/g, ""),
    },

    { family: "negation", variant: "is-it-false", instructions: `Is it false that ${c}?`, polarity: -1 },
    { family: "negation", variant: "negated-claim", instructions: `Is it true that ${n}?`, polarity: -1 },
    { family: "negation", variant: "negated-declarative", instructions: `${cap(n)}.`, polarity: -1 },
    { family: "negation", variant: "double-false-of-negated", instructions: `Is it false that ${n}?` },
    { family: "negation", variant: "double-not-the-case", instructions: `Is it not the case that ${n}?` },
    { family: "negation", variant: "negative-polar", instructions: `Isn't it true that ${c}?` },
  ];
}

/** Suggestion, acquiescence, presupposition, stakes and persona (psychology). */
function psychology(it: ClaimItem): ClaimVariant[] {
  const q = it.question;
  const c = it.claim;
  const n = it.claimNeg;

  return [
    { family: "suggestion", variant: "most-say-yes", instructions: `${q} Most people say yes.` },
    { family: "suggestion", variant: "most-say-no", instructions: `${q} Most people say no.` },
    { family: "suggestion", variant: "expert-claim", instructions: `An expert has said that ${c}. Is the expert right?` },
    {
      family: "suggestion",
      variant: "expert-negated",
      instructions: `An expert has said that ${n}. Is the expert right?`,
      polarity: -1,
    },
    { family: "acquiescence", variant: "agree-claim", instructions: `Do you agree that ${c}?` },
    { family: "acquiescence", variant: "agree-negated", instructions: `Do you agree that ${n}?`, polarity: -1 },
    { family: "presupposition", variant: "given-claim", instructions: `Given that ${c}, confirm: is that correct?` },
    {
      family: "presupposition",
      variant: "given-negated",
      instructions: `Given that ${n}, confirm: is that correct?`,
      polarity: -1,
    },
    { family: "stakes-persona", variant: "stakes", instructions: `This is very important to my career. ${q}` },
    {
      family: "stakes-persona",
      variant: "persona-strict",
      instructions: `Answer as a strict, sceptical auditor would. ${q}`,
    },
    {
      family: "stakes-persona",
      variant: "persona-lenient",
      instructions: `Answer as a generous, easy-going friend would. ${q}`,
    },
  ];
}

const SCORE5 = ["Definitely no", "Probably no", "Unsure", "Probably yes", "Definitely yes"];
const SCORE5_W = [0, 0, 0.5, 1, 1];

/** Answer shapes: the same yes/no asked as a choice, a score, or a yes/no with criteria. */
function shapes(it: ClaimItem): ClaimVariant[] {
  const q = it.question;
  const claim = `${cap(it.claim)}.`;
  const neg = `${cap(it.claimNeg)}.`;

  return [
    {
      family: "answer-shape",
      variant: "choice-yes-no",
      instructions: q,
      question: { type: "choice", instructions: q, criteria: { yes: "Yes", no: "No" } },
      read: { kind: "choice-yes", yes: "yes" },
    },
    {
      family: "answer-shape",
      variant: "choice-no-yes",
      instructions: q,
      question: { type: "choice", instructions: q, criteria: { no: "No", yes: "Yes" } },
      read: { kind: "choice-yes", yes: "yes" },
    },
    {
      family: "answer-shape",
      variant: "choice-claims",
      instructions: "Which statement is true?",
      question: { type: "choice", instructions: "Which statement is true?", criteria: { a: claim, b: neg } },
      read: { kind: "choice-yes", yes: "a" },
    },
    {
      family: "answer-shape",
      variant: "choice-claims-reversed",
      instructions: "Which statement is true?",
      question: { type: "choice", instructions: "Which statement is true?", criteria: { a: neg, b: claim } },
      read: { kind: "choice-yes", yes: "b" },
    },
    {
      family: "answer-shape",
      variant: "score-5",
      instructions: q,
      question: { type: "score", instructions: q, criteria: SCORE5 },
      read: { kind: "score-yes", weights: SCORE5_W },
    },
    {
      family: "answer-shape",
      variant: "score-5-descending",
      instructions: q,
      question: { type: "score", instructions: q, criteria: [...SCORE5].reverse() },
      read: { kind: "score-yes", weights: [...SCORE5_W].reverse() },
    },
    {
      family: "answer-shape",
      variant: "noul-with-criteria",
      instructions: q,
      question: {
        type: "noul",
        instructions: q,
        criteria: { true: claim, false: neg },
      } as unknown as WireQuestion,
    },
  ];
}

/** Same facts, other layouts (truth items only). */
function representation(it: ClaimItem): ClaimVariant[] {
  const q = it.question;
  const f = it.facts;
  const seed = seedOf(it.id);
  const json = layouts.json(f);

  return [
    { family: "representation", variant: "prose", instructions: q, state: it.prose },
    { family: "representation", variant: "markdown-table", instructions: q, state: layouts.table(f) },
    { family: "representation", variant: "bullets", instructions: q, state: layouts.bullets(f) },
    { family: "representation", variant: "env-lines", instructions: q, state: layouts.env(f) },
    { family: "representation", variant: "csv", instructions: q, state: layouts.csv(f) },
    { family: "representation", variant: "json-array", instructions: q, state: layouts.array(f) },
    { family: "representation", variant: "xml", instructions: q, state: layouts.xml(f) },
    { family: "representation", variant: "snake-case-keys", instructions: q, state: layouts.snakeJson(f) },
    { family: "representation", variant: "json-string", instructions: q, state: JSON.stringify(json) },
    { family: "representation", variant: "nested", instructions: q, state: { case: { facts: json } } },
    {
      family: "representation",
      variant: "facts-in-instructions",
      instructions: `Facts:\n${layouts.bullets(f)}\n\n${q}`,
      state: {},
    },
    { family: "context", variant: "shuffled-order", instructions: q, state: layouts.json(shuffleFacts(f, seed)) },
    {
      family: "context",
      variant: "distractors",
      instructions: q,
      state: layouts.json(interleave(f, it.distractors)),
    },
    {
      family: "context",
      variant: "long-background",
      instructions: q,
      state: { Background: LONG_BACKGROUND, ...json },
    },
    {
      family: "context",
      variant: "numbers-as-words",
      instructions: q,
      state: layouts.json(f.map(([k, v]) => [k, numbersAsWords(v)])),
    },
  ];
}

/** Other languages: the question alone, then question and facts (truth items only). */
function multilingual(it: ClaimItem): ClaimVariant[] {
  return LANGUAGES.flatMap((lang): ClaimVariant[] => {
    const t = TRANSLATIONS[it.id]![lang];

    return [
      { family: "language-question", variant: lang, instructions: t.question },
      { family: "language-full", variant: lang, instructions: t.question, state: t.prose },
    ];
  });
}

function claimJobs(it: ClaimItem, study: "claim-truth" | "claim-ambiguous"): Job[] {
  const vs = [...wording(it), ...psychology(it), ...shapes(it)];

  if (study === "claim-truth") vs.push(...representation(it), ...multilingual(it));

  return vs.map((v) => ({
    id: `${study}:${it.id}:${v.family}:${v.variant}`,
    study,
    family: v.family,
    variant: v.variant,
    item: it.id,
    request: {
      state: v.state === undefined ? layouts.json(it.facts) : v.state,
      questions: single(v.question ?? noul(v.instructions)),
    },
    read: v.read ?? { kind: "noul", polarity: v.polarity ?? 1 },
    ...(it.truth === undefined ? {} : { truth: it.truth }),
  }));
}

/** Moves the correct option to position `k` (0-based); the rest keep their relative order. */
export function placeCorrect(options: ChoiceOption[], correct: string, k: number) {
  const right = options.find(([key]) => key === correct)!;
  const rest = options.filter(([key]) => key !== correct);

  return [...rest.slice(0, k), right, ...rest.slice(k)];
}

function choiceJobs(it: ChoiceItem): Job[] {
  const base = (options: ChoiceOption[], instructions = it.instructions) => ({
    question: {
      type: "choice" as const,
      instructions,
      criteria: Object.fromEntries(options.map(([k, label]) => [k, label])),
    },
    keyMap: Object.fromEntries(options.map(([k]) => [k, k])),
  });
  const relabel = (keys: string[], describe = (label: string) => label) => ({
    question: {
      type: "choice" as const,
      instructions: it.instructions,
      criteria: Object.fromEntries(it.options.map(([, label], i) => [keys[i]!, describe(label)])),
    },
    keyMap: Object.fromEntries(it.options.map(([k], i) => [keys[i]!, k])),
  });
  const random = seedOf(it.id);
  const draw = rng(random);
  const opaque = it.options.map(() => `k${Math.floor(draw() * 36 ** 3).toString(36).padStart(3, "0")}`);
  const vs: { family: string; variant: string; question: WireQuestion; keyMap: Record<string, string>; each?: boolean }[] = [
    { family: "baseline", variant: "canonical", ...base(it.options) },
    { family: "baseline", variant: "repeat-1", ...base(it.options) },
    { family: "baseline", variant: "repeat-2", ...base(it.options) },
    ...[0, 1, 2, 3].map((k) => ({
      family: "position",
      variant: `correct-at-${k + 1}`,
      ...base(placeCorrect(it.options, it.correct, k)),
    })),
    { family: "position", variant: "reversed", ...base([...it.options].reverse()) },
    { family: "labels", variant: "letters", ...relabel(["A", "B", "C", "D"]) },
    { family: "labels", variant: "numbers", ...relabel(["1", "2", "3", "4"]) },
    { family: "labels", variant: "opaque-ids", ...relabel(opaque) },
    { family: "labels", variant: "label-as-key", ...relabel(it.options.map(([, l]) => l)) },
    {
      family: "labels",
      variant: "verbose-criteria",
      ...relabel(
        it.options.map(([k]) => k),
        (l) => `${l}. Choose this option if it is the correct answer to the question, given the facts provided.`,
      ),
    },
    {
      family: "option-count",
      variant: "two-options",
      ...base(it.options.filter(([k], i) => k === it.correct || i === it.options.findIndex(([x]) => x !== it.correct))),
    },
    { family: "option-count", variant: "six-options", ...base([...it.options, ...it.extras]) },
    { family: "option-count", variant: "none-of-the-above", ...base([...it.options, ["none", "None of the above"]]) },
    { family: "wording", variant: "imperative", ...base(it.options, it.imperative) },
    { family: "wording", variant: "typos-heavy", ...base(it.options, typos(it.instructions, 0.2, random + 2)) },
    { family: "wording", variant: "spanish", ...base(it.options, it.es) },
    { family: "wording", variant: "chinese", ...base(it.options, it.zh) },
  ];
  const jobs: Job[] = vs.map((v) => ({
    id: `choice:${it.id}:${v.family}:${v.variant}`,
    study: "choice",
    family: v.family,
    variant: v.variant,
    item: it.id,
    request: { state: it.state, questions: single(v.question) },
    read: { kind: "dist", from: "choice", keyMap: v.keyMap },
    truth: it.correct,
  }));

  jobs.push({
    id: `choice:${it.id}:answer-shape:yes-no-each`,
    study: "choice",
    family: "answer-shape",
    variant: "yes-no-each",
    item: it.id,
    request: {
      state: it.state,
      questions: Object.fromEntries(
        it.options.map(([k, label]) => [
          k,
          noul(`Question: ${it.instructions} Is "${label}" the correct answer?`),
        ]),
      ),
    },
    read: { kind: "dist", from: "each", keyMap: Object.fromEntries(it.options.map(([k]) => [k, k])) },
    truth: it.correct,
  });

  return jobs;
}

function framingJobs(): Job[] {
  return FRAMING_ITEMS.flatMap((it) => {
    const s = it.n / 3;
    const u = it.unit;
    const text = {
      gain: {
        sure: `If this program is adopted, ${s} ${u} ${it.gain}.`,
        risky: `If this program is adopted, there is a 1/3 probability that all ${it.n} ${u} ${it.gain}, and a 2/3 probability that none of them ${it.gain}.`,
      },
      loss: {
        sure: `If this program is adopted, ${it.n - s} ${u} ${it.loss}.`,
        risky: `If this program is adopted, there is a 1/3 probability that ${it.lossNone}, and a 2/3 probability that all ${it.n} ${u} ${it.loss}.`,
      },
    };

    return (["gain", "loss"] as const).flatMap((frame) =>
      (["sure-first", "risky-first"] as const).map((order): Job => {
        const [first, second] = order === "sure-first" ? (["sure", "risky"] as const) : (["risky", "sure"] as const);

        return {
          id: `framing:${it.id}:${frame}:${order}`,
          study: "framing",
          family: "risky-choice",
          variant: `${frame}-${order}`,
          item: it.id,
          request: {
            state: { Situation: it.context },
            questions: single({
              type: "choice",
              instructions: it.question,
              criteria: { "Program A": text[frame][first], "Program B": text[frame][second] },
            }),
          },
          read: { kind: "dist", from: "choice", keyMap: { "Program A": first, "Program B": second } },
          meta: { frame, order },
        };
      }),
    );
  });
}

const QUALITY = ["Very poor", "Poor", "Average", "Good", "Very good"];

function attributeJobs(): Job[] {
  return ATTRIBUTE_ITEMS.flatMap((it) =>
    (["positive", "negative"] as const).map(
      (frame): Job => ({
        id: `attribute:${it.id}:${frame}`,
        study: "attribute",
        family: "attribute-framing",
        variant: frame,
        item: it.id,
        request: {
          state: { Subject: it.subject, Fact: it[frame] },
          questions: single({ type: "score", instructions: it.question, criteria: QUALITY }),
        },
        read: { kind: "dist", from: "score", keyMap: Object.fromEntries(QUALITY.map((_, i) => [String(i), String(i)])) },
        meta: { frame },
      }),
    ),
  );
}

function anchorJobs(): Job[] {
  return ANCHOR_ITEMS.flatMap((it) => {
    const plain = { Quiz: "general knowledge" };
    const vs: [string, unknown, string][] = [
      ["none", plain, it.question],
      ["irrelevant-low", { ...plain, "Your randomly drawn ticket number": it.low }, it.question],
      ["irrelevant-high", { ...plain, "Your randomly drawn ticket number": it.high }, it.question],
      ["comparative-low", plain, `First consider whether the answer is higher or lower than ${it.low}. Then: ${it.question}`],
      ["comparative-high", plain, `First consider whether the answer is higher or lower than ${it.high}. Then: ${it.question}`],
    ];

    return vs.map(
      ([variant, state, instructions]): Job => ({
        id: `anchor:${it.id}:${variant}`,
        study: "anchor",
        family: "anchoring",
        variant,
        item: it.id,
        request: { state, questions: single({ type: "score", instructions, criteria: it.levels }) },
        read: { kind: "dist", from: "score", keyMap: Object.fromEntries(it.levels.map((_, i) => [String(i), String(i)])) },
        truth: it.truth,
      }),
    );
  });
}

function decoyJobs(): Job[] {
  const names = { a: "Ash", b: "Birch", d: "Cedar" };

  return DECOY_ITEMS.flatMap((it) => {
    const sets: [string, [keyof typeof names, string][]][] = [
      ["none", [["a", it.a], ["b", it.b]]],
      ["decoy-a", [["a", it.a], ["b", it.b], ["d", it.aDecoy]]],
      ["decoy-b", [["a", it.a], ["b", it.b], ["d", it.bDecoy]]],
    ];

    return sets.flatMap(([decoy, options]) =>
      (["forward", "reversed"] as const).map((order): Job => {
        const listed = order === "forward" ? options : [...options].reverse();

        return {
          id: `decoy:${it.id}:${decoy}:${order}`,
          study: "decoy",
          family: "asymmetric-dominance",
          variant: `${decoy}-${order}`,
          item: it.id,
          request: {
            state: { Decision: it.context },
            questions: single({
              type: "choice",
              instructions: it.question,
              criteria: Object.fromEntries(listed.map(([k, text]) => [names[k], text])),
            }),
          },
          read: { kind: "dist", from: "choice", keyMap: Object.fromEntries(listed.map(([k]) => [names[k], k])) },
          meta: { decoy, order },
        };
      }),
    );
  });
}

const AGREE5 = ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"];
const AGREE3 = ["Disagree", "Neutral", "Agree"];
const AGREE7 = [
  "Strongly disagree",
  "Disagree",
  "Somewhat disagree",
  "Neither agree nor disagree",
  "Somewhat agree",
  "Agree",
  "Strongly agree",
];
const ENDPOINTS = ["1 (strongly disagree)", "2", "3", "4", "5 (strongly agree)"];

function likertJobs(): Job[] {
  return LIKERT_ITEMS.flatMap((it) => {
    const ask = (s: string) => `How much do you agree with this statement: "${s}"`;
    /** keyMap from level index to agreement in [0, 1], written as a string. */
    const up = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), String(i / (n - 1))]));
    const down = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), String((n - 1 - i) / (n - 1))]));
    const vs: [string, WireQuestion, Reader, string][] = [
      ["agree-5", { type: "score", instructions: ask(it.statement), criteria: AGREE5 }, { kind: "dist", from: "score", keyMap: up(5) }, "statement"],
      ["agree-5-descending", { type: "score", instructions: ask(it.statement), criteria: [...AGREE5].reverse() }, { kind: "dist", from: "score", keyMap: down(5) }, "statement"],
      ["agree-3", { type: "score", instructions: ask(it.statement), criteria: AGREE3 }, { kind: "dist", from: "score", keyMap: up(3) }, "statement"],
      ["agree-7", { type: "score", instructions: ask(it.statement), criteria: AGREE7 }, { kind: "dist", from: "score", keyMap: up(7) }, "statement"],
      ["agree-5-endpoints", { type: "score", instructions: ask(it.statement), criteria: ENDPOINTS }, { kind: "dist", from: "score", keyMap: up(5) }, "statement"],
      ["agree-5-reversed-statement", { type: "score", instructions: ask(it.reversed), criteria: AGREE5 }, { kind: "dist", from: "score", keyMap: up(5) }, "reversed"],
      ["yes-no-agree", noul(`Do you agree with this statement: "${it.statement}"?`), { kind: "noul", polarity: 1 }, "statement"],
      ["yes-no-agree-reversed", noul(`Do you agree with this statement: "${it.reversed}"?`), { kind: "noul", polarity: 1 }, "reversed"],
    ];

    return vs.map(
      ([variant, question, read, statement]): Job => ({
        id: `likert:${it.id}:${variant}`,
        study: "likert",
        family: "likert",
        variant,
        item: it.id,
        request: { state: { Context: "an opinion survey" }, questions: single(question) },
        read,
        meta: { statement },
      }),
    );
  });
}

export function allJobs(): Job[] {
  return [
    ...TRUTH_ITEMS.flatMap((it) => claimJobs(it, "claim-truth")),
    ...AMBIGUOUS_ITEMS.flatMap((it) => claimJobs(it, "claim-ambiguous")),
    ...CHOICE_ITEMS.flatMap(choiceJobs),
    ...framingJobs(),
    ...attributeJobs(),
    ...anchorJobs(),
    ...decoyJobs(),
    ...likertJobs(),
  ];
}
