/**
 * Count with me: the shared pieces. Every image has an exact COCO count for one category. Three
 * deciders answer the same typed questions about it:
 * - a vision-language model, from the pixels (local, MLX-VLM; vlm_server.py);
 * - an object detector, by counting its boxes (DETR ResNet-50, local);
 * - Jev, which is text-only, from the detector's boxes written out as facts.
 *
 * The questions: which count bin (a choice), "more than N?" for a ladder of N (yes/no), and "is
 * the count even?" (yes/no). Bins and their letters are shared with choose.py.
 */
import { bootstrap } from "../../packages/arena/prose/metrics";

/** Inclusive count bins; must match BINS in choose.py (a test checks). */
export const BINS: [number, number][] = [
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 5],
  [6, 8],
  [9, 12],
  [13, 19],
  [20, 29],
  [30, 999],
];

/** One answer letter per bin, each a single token. */
export const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;

export const binLabel = ([lo, hi]: [number, number]) => (lo === hi ? `${lo}` : hi >= 999 ? `${lo} or more` : `${lo}–${hi}`);

export const BIN_LABELS = BINS.map(binLabel);

export function binOf(n: number) {
  const i = BINS.findIndex(([lo, hi]) => n >= lo && n <= hi);

  return i < 0 ? (n < 1 ? 0 : BINS.length - 1) : i;
}

/** A single number standing for a bin, for an approximate error in objects. */
export const REPRESENTATIVE = [1, 2, 3, 4.5, 7, 10.5, 16, 24.5, 38];

/** Coarser crowd sizes for the headline and the "crowd gets bigger" view: bins they cover. */
export const GROUPS = [
  { id: "few", label: "1 to 3", bins: [0, 1, 2] },
  { id: "some", label: "4 to 12", bins: [3, 4, 5] },
  { id: "crowd", label: "13 or more", bins: [6, 7, 8] },
] as const;

/** The "more than N?" ladder. */
export const THRESHOLDS = [2, 5, 10, 20] as const;

export type Item = {
  id: string;
  kind: "photo" | "composite";
  category: string;
  plural: string;
  count: number;
  bin: number;
  width: number;
  height: number;
  file: string;
  thumb: string;
  thumbWidth: number;
  thumbHeight: number;
  boxes: number[][];
  overlapShare: number;
  medianAreaPct: number;
  /** The image as shown: a photo's own licence, or what a composite's four licences combine to. */
  licence: { name: string; url: string };
  sources: { cocoId: number; count: number; licence: { name: string; url: string }; noncommercial: boolean; flickr?: string; coco: string }[];
};

const GRID_NOTE = "If the image is a grid of photos, count across all of them.";

/** The questions the vision model is asked about one image, with their single-token labels. */
export function vlmQuestions(item: Pick<Item, "plural">) {
  const count = [
    `How many ${item.plural} are in this image? Count every one you can see, including partly hidden ones. ${GRID_NOTE}`,
    ...BINS.map((b, i) => `${LETTERS[i]}: ${binLabel(b)}`),
    "Answer with one letter.",
  ].join("\n");

  return [
    { key: "count", question: count, labels: [...LETTERS] },
    ...THRESHOLDS.map((n) => ({
      key: `more${n}`,
      question: `Are there more than ${n} ${item.plural} in this image? ${GRID_NOTE} Answer Yes or No.`,
      labels: ["Yes", "No"],
    })),
    { key: "even", question: `Is the number of ${item.plural} in this image even? ${GRID_NOTE} Answer Yes or No.`, labels: ["Yes", "No"] },
  ];
}

/** The detector's boxes for one image, as recorded by detect.ts. */
export type Detection = { score: number; box: [number, number, number, number] };

/** A box counts for the detector-only lane at this confidence or above. */
export const DETECTOR_THRESHOLD = 0.7;

/** Boxes at this confidence or above are shown to Jev, with their confidence, so Jev judges which count. */
export const FACTS_THRESHOLD = 0.3;

/** Jev's typed request: the detector's boxes as text, and the same questions as the vision model. */
export function jevRequest(item: Pick<Item, "plural" | "width" | "height">, detections: Detection[]) {
  const shown = detections.filter((d) => d.score >= FACTS_THRESHOLD).sort((a, b) => b.score - a.score);
  const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;

  return {
    state: {
      "Object to count": item.plural,
      Source:
        "An object detector looked at the image and returned these boxes for this kind of object. You cannot see the image. Some boxes may be duplicates or wrong, and the detector may have missed some objects.",
      "Boxes found": String(shown.length),
      Boxes: shown.map((d, i) => ({
        n: i + 1,
        confidence: Math.round(d.score * 100) / 100,
        "x %": pct(d.box[0], item.width),
        "y %": pct(d.box[1], item.height),
        "width %": pct(d.box[2], item.width),
        "height %": pct(d.box[3], item.height),
      })),
    },
    questions: {
      count: {
        type: "choice" as const,
        instructions: `How many ${item.plural} are in the image?`,
        criteria: Object.fromEntries(BINS.map((b, i) => [LETTERS[i], binLabel(b)])),
      },
      ...Object.fromEntries(
        THRESHOLDS.map((n) => [`more${n}`, { type: "noul" as const, instructions: `Are there more than ${n} ${item.plural} in the image?` }]),
      ),
      even: { type: "noul" as const, instructions: `Is the number of ${item.plural} in the image even?` },
    },
  };
}

/** One decider's answers about one image, in a common shape. */
export type Answer = {
  /** Probability per bin letter. */
  bins: Record<string, number>;
  /** P(yes) for each "more than N?". */
  more: Record<string, number>;
  /** P(yes) that the count is even. */
  even: number | null;
  /** An exact count where the decider gives one (the detector); else null. */
  exact: number | null;
  ms: number | null;
};

export const topBin = (bins: Record<string, number>) =>
  LETTERS.reduce((best, l, i) => ((bins[l] ?? 0) > (bins[LETTERS[best]] ?? 0) ? i : best), 0);

/** The decider's single estimate of the count: its exact count, or its top bin's representative. */
export const estimate = (a: Answer) => a.exact ?? REPRESENTATIVE[topBin(a.bins)];

export const estimateBin = (a: Answer) => (a.exact !== null ? binOf(a.exact) : topBin(a.bins));

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Accuracy summary for one decider over a set of images. */
export function summarize(items: Item[], answers: Map<string, Answer>) {
  const rows = items.flatMap((it) => {
    const a = answers.get(it.id);

    if (!a) return [];

    const bin = estimateBin(a);
    const ladder = THRESHOLDS.filter((n) => a.more[`more${n}`] !== undefined).map((n) => Number(a.more[`more${n}`] >= 0.5 === it.count > n));

    return [
      {
        id: it.id,
        trueBin: it.bin,
        exactBin: Number(bin === it.bin),
        withinOne: Number(Math.abs(bin - it.bin) <= 1),
        binError: Math.abs(bin - it.bin),
        absError: Math.abs(estimate(a) - it.count),
        signed: estimate(a) - it.count,
        ladder: ladder.length ? mean(ladder) : NaN,
        even: a.even === null ? NaN : Number(a.even >= 0.5 === (it.count % 2 === 0)),
      },
    ];
  });

  const stat = (key: "exactBin" | "withinOne" | "binError" | "absError" | "signed" | "ladder" | "even") => {
    const xs = rows.map((r) => r[key]).filter((x) => !Number.isNaN(x));

    return { mean: mean(xs), ci: bootstrap(xs), n: xs.length };
  };

  const byBin = BINS.map((_, b) => {
    const rs = rows.filter((r) => r.trueBin === b);
    const exact = rs.map((r) => r.exactBin);
    const abs = rs.map((r) => r.absError);

    return {
      bin: b,
      n: rs.length,
      exactBin: mean(exact),
      exactBinCi: bootstrap(exact),
      absError: mean(abs),
      absErrorCi: bootstrap(abs),
      signed: mean(rs.map((r) => r.signed)),
    };
  });

  return { n: rows.length, exactBin: stat("exactBin"), withinOne: stat("withinOne"), binError: stat("binError"), absError: stat("absError"), signed: stat("signed"), ladder: stat("ladder"), even: stat("even"), byBin };
}

/** The vision model's recorded rows for one image, as an Answer. */
export function vlmAnswer(rows: { question: string; probabilities: Record<string, number>; ms: number }[]): Answer | null {
  const by = new Map(rows.map((r) => [r.question, r]));
  const count = by.get("count");

  if (!count) return null;

  return {
    bins: count.probabilities,
    more: Object.fromEntries(THRESHOLDS.flatMap((n) => (by.has(`more${n}`) ? [[`more${n}`, by.get(`more${n}`)!.probabilities.Yes]] : []))),
    even: by.get("even")?.probabilities.Yes ?? null,
    exact: null,
    ms: rows.reduce((s, r) => s + r.ms, 0),
  };
}

/** The detector's answer: its count of boxes at DETECTOR_THRESHOLD, and what follows from it. */
export function detectorAnswer(detections: Detection[], ms: number | null = null): Answer {
  const exact = detections.filter((d) => d.score >= DETECTOR_THRESHOLD).length;

  return {
    bins: Object.fromEntries(LETTERS.map((l, i) => [l, Number(i === binOf(exact))])),
    more: Object.fromEntries(THRESHOLDS.map((n) => [`more${n}`, Number(exact > n)])),
    even: Number(exact % 2 === 0),
    exact,
    ms,
  };
}

type GatewayAnswer = { type: string; value: number | string; probabilities: Record<string, number> | null };

/** Jev's recorded answers for one image, as an Answer. */
export function jevAnswer(answers: Record<string, GatewayAnswer>, ms: number | null = null): Answer | null {
  const count = answers.count;

  if (!count) return null;

  return {
    bins: count.probabilities ?? { [String(count.value)]: 1 },
    more: Object.fromEntries(THRESHOLDS.flatMap((n) => (answers[`more${n}`] ? [[`more${n}`, Number(answers[`more${n}`].value)]] : []))),
    even: answers.even ? Number(answers.even.value) : null,
    exact: null,
    ms,
  };
}
