/**
 * The prose studies as an article: what moves a decision model, and what doesn't. The hero is one
 * figure, every rewording's change in the probability of the right answer, from the study's
 * results. Fool Jev, the playable version of the doubt finding, is folded at the end.
 */
import { useState } from "react";
import prose from "../../../packages/arena/prose/results.json";
import { FoolJev } from "../fool-jev";
import { homeHeadline } from "../headline-strip";
import { Article } from "./article";
import { Cite } from "./cite";

type Variant = (typeof prose)["claim-truth"]["variants"][number];

const FAMILY: Record<string, string> = {
  baseline: "Same question again",
  "sentence-form": "Sentence form",
  "lexical-syntax": "Word choice",
  length: "Length",
  register: "Register",
  "hedge-intensifier": "Hedges",
  noise: "Typos and noise",
  negation: "Negation",
  suggestion: "Suggestion",
  acquiescence: "Agree or disagree",
  presupposition: "Presupposition",
  "stakes-persona": "Stakes and persona",
  "answer-shape": "Answer shape",
  representation: "Fact layout",
  context: "Context",
  "language-question": "Language: question",
  "language-full": "Language: everything",
};

/** The two forms the study discusses by name, quoted as asked. */
const WORDING: Record<string, string> = {
  "most-say-no": "the question, then “Most people say no.”",
  "center-embedded": "“The question that the facts that are listed above bear on is whether or not, all things considered, …”",
};

const STUDY = "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/packages/arena/prose";
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const label = (v: Variant) => v.variant.replaceAll("-", " ");

function RewordingChart({ variants, onPick, picked }: { variants: Variant[]; onPick: (v: Variant) => void; picked: Variant | null }) {
  const families = [...new Set(variants.map((v) => v.family))];
  const lo = Math.min(...variants.map((v) => v.deltaCI[0]), -0.05);
  const hi = Math.max(...variants.map((v) => v.deltaCI[1]), 0.05);
  const W = 640;
  const left = 150;
  const row = 26;
  const H = families.length * row + 40;
  const x = (d: number) => left + ((d - lo) / (hi - lo)) * (W - left - 16);
  const ticks = [-0.3, -0.2, -0.1, 0, 0.1].filter((t) => t >= lo && t <= hi);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fmt-chart" role="group" aria-label="Change in the probability of the right answer, for each rewording">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={8} y2={H - 28} stroke={t === 0 ? "var(--ink)" : "var(--line)"} strokeWidth={t === 0 ? 1.5 : 1} />
          <text x={x(t)} y={H - 12} textAnchor="middle" fontSize="12" fill="var(--muted)">
            {t === 0 ? "0" : signed(t)}
          </text>
        </g>
      ))}
      {families.map((f, i) => (
        <text key={f} x={left - 10} y={20 + i * row + 4} textAnchor="end" fontSize="13" fill="var(--ink)">
          {FAMILY[f] ?? f}
        </text>
      ))}
      {variants.map((v) => {
        const y = 20 + families.indexOf(v.family) * row;
        const on = picked?.variant === v.variant && picked.family === v.family;
        const flipped = v.flips > 0;

        return (
          <g
            key={`${v.family}/${v.variant}`}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${FAMILY[v.family] ?? v.family}: ${label(v)}, change ${signed(v.delta)}, ${v.flips} of ${v.n} answers flipped`}
            onClick={() => onPick(v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(v);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <line x1={x(v.deltaCI[0])} x2={x(v.deltaCI[1])} y1={y} y2={y} stroke={flipped ? "var(--tomato)" : "var(--muted)"} strokeWidth={2} />
            <circle cx={x(v.delta)} cy={y} r={on ? 7 : 5} fill={flipped ? "var(--tomato)" : "var(--surface)"} stroke="var(--ink)" strokeWidth={on ? 2.5 : 1.5} />
          </g>
        );
      })}
    </svg>
  );
}

export function ProseArticle() {
  const ct = prose["claim-truth"];
  const run = prose.run;
  const variants = ct.variants;
  const home = homeHeadline();
  const families = new Set(variants.map((v) => v.family)).size;
  const items = variants[0]?.n ?? 0;
  const still = variants.filter((v) => v.flips === 0).length;
  const sentence = ct.rollup.find((r) => r.family === "sentence-form");
  const sentenceFlips = sentence ? Math.round(sentence.flipRate * sentence.cells) : null;
  const named = (id: string) => variants.find((v) => v.variant === id);
  const crowd = named("most-say-no");
  const embedded = named("center-embedded");
  const [picked, setPicked] = useState<Variant | null>(crowd ?? null);
  const title = "What moves a decision model?";

  return (
    <Article
      verdict={home?.verdict}
      byline={
        <>
          Jev experiments · recorded {run.first.slice(0, 10)} · {run.answered.toLocaleString()} answers from typesafe-ai/jev ·
          ${run.costUsd.toFixed(3)} at list price
        </>
      }
      hero={
        <>
          <RewordingChart variants={variants} picked={picked} onPick={setPicked} />
          {picked && (
            <p className="fmt-chart-detail" aria-live="polite">
              <b>
                {FAMILY[picked.family] ?? picked.family}: {label(picked)}
              </b>
              {WORDING[picked.variant] ? ` (${WORDING[picked.variant]})` : ""}. The probability of the right answer changed by{" "}
              {signed(picked.delta)} on average (95% interval {signed(picked.deltaCI[0])} to {signed(picked.deltaCI[1])}), and{" "}
              {picked.flips} of {picked.n} answers flipped.
            </p>
          )}
        </>
      }
      caption={
        <>
          Figure 1. Each dot is one way of asking the same {items} questions: the average change in the probability of the
          right answer against the plain question, with its 95% interval. Red dots flipped at least one answer. Select a dot
          for its details.
        </>
      }
      cite={<Cite title={title} scene="prose" recorded={run.first} />}
      notes={[
        <>
          The frozen protocol, items, recording and analysis:{" "}
          <a href={STUDY} target="_blank" rel="noreferrer">
            packages/arena/prose
          </a>
          .
        </>,
        <>Fool Jev on the home page replays its own recorded puzzles; its counts come from that recording.</>,
      ]}
      full={{ label: "Try it yourself: Fool Jev", content: <FoolJev /> }}
    >
      <section>
        <h2>What we did</h2>
        <p>
          We wrote {items} yes-or-no questions whose answers follow from stated facts, and asked each one {variants.length}{" "}
          ways in {families} families: different sentence forms, word choice, typos, negation, suggestions such as “Most
          people say no”, different layouts of the facts, and seven languages. The protocol and analysis were frozen before
          the first request.
        </p>
      </section>

      <section>
        <h2>What we found</h2>
        <p>
          Most rewordings barely moved Jev: {still} of the {variants.length} forms flipped no answer at all
          {sentenceFlips !== null ? `, and the seven sentence forms flipped ${sentenceFlips} of ${sentence?.cells}` : ""}.
        </p>
        {crowd && (
          <p>
            A suggestion did move it. Adding “Most people say no.” lowered the probability of the right answer by{" "}
            {Math.abs(crowd.delta).toFixed(2)} (95% interval {Math.abs(crowd.deltaCI[1]).toFixed(2)} to{" "}
            {Math.abs(crowd.deltaCI[0]).toFixed(2)}) and flipped {crowd.flips} of {crowd.n} answers.
            {home?.stats[0]
              ? ` A later recording of Fool Jev's puzzles found the same pattern: “I'm pretty sure the answer is no.” flipped ${home.stats[0].value} of them.`
              : ""}
          </p>
        )}
        {embedded && (
          <p>
            One form moved it more ({signed(embedded.delta)}), a long centre-embedded sentence describing the question. It's
            confounded: as a yes-or-no, that sentence is true whatever the answer, so we don't count it as a finding.
          </p>
        )}
        {home?.stats[3] && (
          <p>
            Its confidence mostly holds up: {home.stats[3].value} answers stated at 90% or more were right, and the expected
            calibration error over these questions is {ct.calibration.ece.toFixed(3)}.
          </p>
        )}
      </section>

      <section>
        <h2>Uncertainty and limits</h2>
        <ul>
          <li>{items} hand-written questions; other questions could be more or less fragile.</li>
          <li>One recording per request. Intervals bootstrap over the questions, not over repeat runs.</li>
          <li>A few forms change more than the wording; the study's notes flag them, as with the centre-embedded sentence.</li>
          <li>The decoy, framing, anchoring and Likert studies from the same run are reported separately.</li>
        </ul>
      </section>

      <section>
        <h2>Data</h2>
        <p>
          <a href={`${STUDY}/results.json`} target="_blank" rel="noreferrer">
            results.json
          </a>{" "}
          has every variant's counts and intervals. The run used {run.inputTokens.toLocaleString()} input tokens, with a
          median latency of {run.latencyMs.p50} ms. The decoy result has <a href="#experiment/decoy">its own article</a>.
        </p>
      </section>
    </Article>
  );
}
