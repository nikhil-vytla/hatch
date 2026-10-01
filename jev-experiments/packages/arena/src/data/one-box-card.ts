/**
 * The One box card: phrases typed a character at a time into a box that becomes a card, one
 * box per contestant. Recorded contestants are any `recordings/one-box[.<id>].jsonl[.gz]` in the
 * gateway wire format; the keyword classifier is computed here. Replays use replay.ts, so the
 * numbers match scripts/one-box-compare.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { answersSchema, toReading } from "../one-box/adapter";
import { cardOf, type Shown } from "../one-box/calm";
import { keyword } from "../one-box/keyword";
import { phrasesSchema, type Phrase } from "../one-box/phrases";
import { INTENTS, type Reading } from "../one-box/questions";
import {
  normalizeKey,
  outcome,
  replay,
  TYPING,
  type AnswerFor,
  type Answered,
  type Policy,
} from "../one-box/replay";
import { bootstrapMany } from "./bootstrap";
import { PALETTE } from "./palette";
import type { Card, CardContestant, Estimate, MetricDef, RunSet } from "./schema";

/**
 * Jev's price and request size, for the cost measure. Price: TypeSafe's published rate,
 * docs.typesafe.ai/models (read 29 Sep 2026): $0.042 per million input tokens, output free.
 * Request size: measured through the gateway on 29 Sep 2026 with One box's 14 questions:
 * 1,732 input tokens for a 1-character prefix, 1,782 for the longest phrase (187 characters),
 * so about 1,732 plus 0.27 per character. The gateway billed exactly price times tokens.
 */
const JEV_USD_PER_TOKEN = 0.042 / 1_000_000;

const tokensFor = (chars: number) => 1732 + Math.max(0, chars - 1) * (50 / 186);

/** One request per keystroke: the prefixes of a phrase, 1 to its full length. */
const jevCostPerPhrase = (text: string) => {
  let usd = 0;

  for (let n = 1; n <= text.length; n++) usd += tokensFor(n) * JEV_USD_PER_TOKEN;

  return usd;
};

/**
 * Phrases scored on this card. The held-out split was scored once, after every contestant was
 * recorded and with nothing tuned; the card pools both and offers each as a slice.
 */
export const ONE_BOX_SPLITS: Phrase["split"][] = ["dev", "heldout"];

/** Slice names for the two splits, shown in the "Phrases" select beside the phrase kinds. */
const SPLIT_SLICE = { dev: "development", heldout: "held-out" } as const;

const POLICIES: { id: Policy; label: string; short: string }[] = [
  { id: "latest", label: "keep the latest answer", short: "keep latest" },
  { id: "cancel", label: "cancel on each keystroke (upstream)", short: "cancel" },
];

/** Recorded contestants by file id ("" is one-box.jsonl). Unknown ids still appear, plainly named. */
type Who = Pick<CardContestant, "name" | "short" | "kind" | "model" | "policy" | "color">;

const RECORDED = new Map<string, Who>(
  Object.entries({
    "": {
      name: "Jev",
      short: "Jev",
      kind: "hosted",
      model: "typesafe-ai/jev",
      policy: "all 14 questions in one request per keystroke prefix",
      color: PALETTE.jev,
    },
    laya: {
      name: "Laya",
      short: "Laya",
      kind: "local",
      model: "laya",
      policy: "one local call per question",
      color: PALETTE.laya,
    },
  } satisfies Record<string, Who>),
);

const rowSchema = z.looseObject({
  key: z.string(),
  status: z.string(),
  latencyMs: z.number().optional(),
  answers: z.unknown().optional(),
  at: z.string().optional(),
});

type Recording = { id: string; file: string; answers: Map<string, Answered>; recordedAt: string };

function recordings(dir: string): Recording[] {
  const files = readdirSync(dir).flatMap((f) => {
    const m = /^one-box(?:\.([\w-]+))?\.jsonl(\.gz)?$/.exec(f);

    return m ? [{ f, id: m[1] ?? "", gz: Boolean(m[2]) }] : [];
  });

  // The raw log while recording, else the committed gzipped copy.
  const chosen = new Map<string, string>();

  for (const { f, id, gz } of files) if (!gz || !chosen.has(id)) chosen.set(id, f);

  return [...chosen].map(([id, f]) => {
    const buf = readFileSync(join(dir, f));
    const text = f.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    const answers = new Map<string, Answered>();
    let last = "";

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = rowSchema.parse(JSON.parse(line));
      const at = row.at ?? "";

      if (row.status !== "ok" || row.latencyMs === undefined) continue;
      answers.set(row.key, {
        reading: toReading(answersSchema.parse(row.answers)).reading,
        latencyMs: row.latencyMs,
      });

      if (at > last) last = at;
    }

    return { id, file: f.replace(/\.gz$/, "") + ".gz", answers, recordedAt: last.slice(0, 10) };
  });
}

const label = (s: Shown) =>
  s.kind === "choose" ? `choose:${s.options.join("|")}` : `${s.kind}:${cardOf(s) ?? ""}`;

const medianOf = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

const METRICS: MetricDef[] = [
  {
    id: "right",
    label: "Box ends on the right card",
    unit: "%",
    better: "higher",
    axis: "accuracy",
    help: "Share of phrases where, once typing stops and answers settle, the box shows the expected card (or a fair alternative for ambiguous phrases).",
  },
  {
    id: "fullRight",
    label: "Full phrase right",
    unit: "%",
    better: "higher",
    axis: "accuracy",
    help: "Share of phrases whose top card is right when the finished phrase is asked once, without typing or calm-UI rules.",
  },
  {
    id: "timeToRight",
    label: "Time until right for good",
    unit: "ms",
    better: "lower",
    axis: "speed",
    help: "From the first keystroke until the right card is committed and stays, median over the phrases where that happens. Typing speed sets most of it.",
  },
  {
    id: "latency",
    label: "Answer time",
    unit: "ms",
    better: "lower",
    axis: "speed",
    help: "Median time for one answer to all 14 questions, across every recorded prefix.",
  },
  {
    id: "cost",
    label: "API cost per 1,000 phrases",
    unit: "usd",
    better: "lower",
    axis: "cost",
    help: "What typing 1,000 of these phrases would cost at TypeSafe's list price ($0.042 per million input tokens, output free): one request per keystroke, at the request size measured on 29 Sep 2026. Local contestants have no per-call price; their hardware isn't counted.",
  },
  {
    id: "wrong",
    label: "Wrong cards committed",
    unit: "count",
    better: "lower",
    axis: "outcome",
    help: "Wrong cards the box committed to while the phrase was being typed, per phrase. A committed wrong card is the worst thing a visitor can see.",
  },
  {
    id: "changes",
    label: "Visible changes",
    unit: "count",
    better: "lower",
    axis: "robustness",
    help: "Times the box visibly changed per phrase: waiting, a faint preview, two chips or a committed card. Fewer means calmer.",
  },
];

export function oneBoxCard(
  out: string,
  dirs: { recordings: string; phrases: string },
  runSet: (
    id: string,
    label: string,
    recordedAt: string,
    protocol: RunSet["protocol"],
    files: string[],
  ) => RunSet,
): Card {
  const doc = phrasesSchema.parse(JSON.parse(readFileSync(dirs.phrases, "utf8")));
  const phrases = doc.phrases.filter((p) => ONE_BOX_SPLITS.includes(p.split));
  const split = ONE_BOX_SPLITS.join(" + ");
  const recorded = recordings(dirs.recordings);
  const readings = new Map<string, Reading>();

  const keywordFor: AnswerFor = (key) => {
    let r = readings.get(key);

    if (!r) {
      r = keyword(key);
      readings.set(key, r);
    }

    return { reading: r, latencyMs: 1 };
  };

  const recordedAt =
    recorded
      .map((r) => r.recordedAt)
      .sort()
      .at(-1) ?? "";

  /** Every prefix a replay may ask for. */
  const needed = [
    ...new Set(
      phrases.flatMap((p) => {
        const chars = Array.from(p.text);

        return chars
          .map((_, i) => normalizeKey(chars.slice(0, i + 1).join("")))
          .filter((k) => k.length >= 2);
      }),
    ),
  ];

  const sets = POLICIES.map((p) =>
    runSet(
      `one-box-${p.id}`,
      `One box, ${p.label}`,
      recordedAt,
      {
        experiment: "one-box",
        split,
        policy: p.id,
        typing: `${TYPING.msPerKey} ms a key, ${TYPING.wordPauseMs} ms after a word, ${TYPING.debounceMs} ms debounce`,
      },
      recorded.map((r) => `packages/arena/recordings/${r.file}`),
    ),
  );

  type Entry = { contestant: CardContestant; answerFor: AnswerFor; policy: Policy; base: string };

  const entries: Entry[] = [
    ...recorded.flatMap((r) => {
      const covered = needed.filter((k) => r.answers.has(k)).length;
      const partial = covered < needed.length;

      const who = RECORDED.get(r.id) ?? {
        name: r.id,
        short: r.id,
        kind: "local" as const,
        color: PALETTE.codeMid,
      };

      return POLICIES.map((p, pi) => ({
        contestant: {
          ...who,
          id: `${r.id || "jev"}@${p.id}`,
          // Upstream's policy is the default, so only the other one is named.
          name: `${who.name}${p.id === "cancel" ? "" : ` · ${p.label}`}${partial ? ` (recording ${Math.floor((covered / needed.length) * 100)}% complete)` : ""}`,
          short: p.id === "cancel" ? who.short : `${who.short} · ${p.short}`,
          policy: `${who.policy ?? ""}${who.policy ? "; " : ""}requests ${p.label}${partial ? `; ${covered} of ${needed.length} prefixes recorded so far, the rest count as failed requests` : ""}`,
          // A contestant still being recorded is shown only on request.
          default: !partial,
          runSets: [sets[pi].id],
        },
        answerFor: (key: string) => r.answers.get(key),
        policy: p.id,
        base: r.id || "jev",
      }));
    }),
    {
      contestant: {
        id: "code.keyword",
        name: "Keyword classifier (Shapeshift's offline fallback)",
        short: "Keywords",
        kind: "code",
        policy:
          "Shapeshift's own regex rules and weights, unchanged and never tuned on these phrases; answers instantly, so both request policies behave the same",
        color: PALETTE.code,
        default: true,
        runSets: [],
      },
      answerFor: keywordFor,
      policy: "cancel",
      base: "code.keyword",
    },
  ];

  mkdirSync(join(out, "onebox"), { recursive: true });

  const results: Card["results"] = {};
  const slices: NonNullable<Card["slices"]> = { workflow: {} };
  const frames: Record<string, string> = {};
  const preds: Record<string, string> = {};
  const cardKeys = INTENTS.filter((k) => k !== "none");

  const latency = new Map(
    recorded.map((r) => [r.id || "jev", medianOf([...r.answers.values()].map((a) => a.latencyMs))]),
  );

  for (const e of entries) {
    const id = e.contestant.id;

    const rows = phrases.map((p) => {
      const r = replay(p.text, e.answerFor, e.policy);
      const full = e.answerFor(normalizeKey(p.text))?.reading;
      const ok = new Set<string>([p.intent, ...(p.acceptable ?? [])]);

      return {
        p,
        r,
        o: outcome(r, p),
        full,
        fullRight: full ? ok.has(full.intent.value) : false,
      };
    });

    const stats = (idx: number[]) => {
      const n = idx.length || 1;

      const times = idx.flatMap((i) => {
        const t = rows[i].o.timeToRight;

        return t === undefined ? [] : [t];
      });

      return {
        right: idx.filter((i) => rows[i].o.finalRight).length / n,
        wrong: idx.reduce((s, i) => s + rows[i].o.wrongCommits, 0) / n,
        changes: idx.reduce((s, i) => s + rows[i].o.changes, 0) / n,
        timeToRight: medianOf(times),
        fullRight: idx.filter((i) => rows[i].fullRight).length / n,
      };
    };

    const estimates = (idx: number[]): Card["results"][string] => {
      const point = stats(idx);

      const ci = bootstrapMany(
        idx.map((i) => [i]),
        (s) => stats(s),
        1000,
      );

      const reached = idx.filter((i) => rows[i].o.timeToRight !== undefined).length;
      const out: Card["results"][string] = {};

      for (const [k, v] of Object.entries(point)) {
        const interval = ci.get(k);
        const est: Estimate = { value: v, n: idx.length, method: "bootstrap-case" };

        if (interval && Number.isFinite(interval.lo) && Number.isFinite(interval.hi)) {
          est.lo = interval.lo;
          est.hi = interval.hi;
        }

        if (k === "timeToRight") {
          est.n = reached;
          est.coverage = { covered: reached, of: idx.length };
        }

        if (Number.isFinite(v)) out[k] = est;
      }

      // Both request policies send one request per keystroke; cancelling doesn't refund it.
      const base = id.replace(/@(cancel|latest)$/, "");

      out.cost = {
        value: base === "jev" ? (idx.reduce((sum, i) => sum + jevCostPerPhrase(rows[i].p.text), 0) / (idx.length || 1)) * 1000 : 0,
        n: idx.length,
        method: "none",
      };

      const l = latency.get(base);

      if (l !== undefined && Number.isFinite(l)) out.latency = { value: l, n: 0, method: "none" };

      return out;
    };

    const all = rows.map((_, i) => i);

    results[id] = estimates(all);

    for (const kind of ["plain", "ambiguous", "adversarial"] as const) {
      const idx = all.filter((i) => rows[i].p.kind === kind);

      (slices.workflow[kind] ??= {})[id] = estimates(idx);
    }

    for (const sp of ["heldout", "dev"] as const) {
      const idx = all.filter((i) => rows[i].p.split === sp);

      (slices.workflow[SPLIT_SLICE[sp]] ??= {})[id] = estimates(idx);
    }

    // What the box showed, compactly: [ms, state, characters typed].
    frames[id] = `onebox/frames.${id}.json`;
    writeFileSync(
      join(out, frames[id]),
      JSON.stringify({
        schema: "arena.onebox.frames/1",
        contestant: id,
        policy: e.policy,
        phrases: rows.map(({ p, r, full }) => ({
          id: p.id,
          frames: r.frames.map((f) => [f.at, label(f.shown), Array.from(f.text).length]),
          final: [
            full?.intent.value ?? "none",
            Math.round((full?.intent.confidence ?? 0) * 1000) / 1000,
          ],
        })),
      }),
    );

    // The full phrase's card distribution, for the calibration and case views.
    const predPath = `onebox/preds.${e.base}.json`;

    preds[id] = predPath;

    if (!existsSync(join(out, predPath)))
      writeFileSync(
        join(out, predPath),
        JSON.stringify({
          schema: "arena.preds/1",
          contestant: e.base,
          p: rows.map(({ full }) => {
            const dist = cardKeys.map((k) => full?.intent.probabilities[k] ?? 0);
            const sum = dist.reduce((a, b) => a + b, 0);

            return dist.map((x) => Math.round((sum ? x / sum : 0) * 10000) / 10000);
          }),
        }),
      );
  }

  writeFileSync(
    join(out, "onebox/phrases.json"),
    JSON.stringify({
      schema: "arena.onebox.phrases/1",
      split,
      typing: {
        msPerKey: TYPING.msPerKey,
        wordPauseMs: TYPING.wordPauseMs,
        debounceMs: TYPING.debounceMs,
      },
      phrases: phrases.map((p) => ({
        id: p.id,
        text: p.text,
        kind: p.kind,
        split: SPLIT_SLICE[p.split],
        intent: p.intent,
        acceptable: p.acceptable ?? [],
      })),
    }),
  );

  writeFileSync(
    join(out, "onebox/targets.json"),
    JSON.stringify({
      schema: "arena.targets/1",
      rows: phrases.map((p, c) => {
        const ok = new Set<string>([p.intent, ...(p.acceptable ?? [])]);

        return {
          c,
          key: "intent",
          type: p.kind,
          wf: p.kind,
          split: SPLIT_SLICE[p.split],
          keys: cardKeys,
          target: cardKeys.map((k) => (ok.has(k) ? 1 / ok.size : 0)),
        };
      }),
    }),
  );
  writeFileSync(
    join(out, "onebox/cases.json"),
    JSON.stringify({
      schema: "arena.cases/1",
      cases: phrases.map((p) => ({
        id: p.id,
        workflow: p.kind,
        split: SPLIT_SLICE[p.split],
        state: { text: p.text },
        questions: [
          {
            key: "intent",
            type: "card",
            instructions: `Which card should “${p.text}” become?`,
            keys: cardKeys,
          },
        ],
      })),
    }),
  );

  const models = recorded.map((r) => (RECORDED.get(r.id) ?? { name: r.id }).name).join(", ");

  return {
    id: "one-box",
    title: "One text box that becomes what you mean",
    question:
      "A phrase is typed one character at a time. After each keystroke the box asks its 14 questions, and calm-UI rules decide whether to wait, preview, offer two cards or commit to one.",
    family: "judgement-set",
    reference: "authored-labels",
    metrics: METRICS,
    primary: "right",
    contestants: entries.map((e) => e.contestant),
    results,
    slices,
    facetLabels: { workflow: "Phrases" },
    provenance: `Agreement with authored expectations · ${phrases.length} phrases (150 development, 50 held-out; the held-out ones scored once, after every contestant was recorded, with nothing tuned) · written by a model that never saw any contestant's rules, then reviewed · typed at ${TYPING.msPerKey} ms a key with a ${TYPING.wordPauseMs} ms pause after each word and upstream's ${TYPING.debounceMs} ms debounce · recorded contestants (${models}) answered every distinct prefix once; replays reuse those answers under each request policy · calm-UI thresholds and keyword rules are Shapeshift's (anishfn/shapeshift, MIT), untuned · 95% case-bootstrap intervals`,
    chunks: {
      phrases: "onebox/phrases.json",
      frames,
      preds,
      targets: "onebox/targets.json",
      cases: "onebox/cases.json",
    },
    lenses: ["typing", "try", "contest", "bars", "scatter", "table", "reliability", "case"],
    protocolGroups: sets.map((s) => ({ hash: s.protocolHash, label: s.label, runSets: [s.id] })),
  };
}
