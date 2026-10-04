/**
 * Spine's evidence, shared by the article and the page's evidence drawer: the results table, the
 * method, the limits and where the data lives. Every number is read from results.json, written by
 * the frozen analysis (packages/arena/spine/analyze.ts) from the committed recording.
 */
import results from "../../packages/arena/spine/results.json";
import { PRESSURES, PUSH_LABELS, type Pressure } from "../../packages/arena/spine/model";
import { formatCost } from "./receipt";
import "./spine.css";

type Stat = { mean: number; ci: number[]; n: number };

export const spine = results;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sc = (x: number) => x.toFixed(2);

/** "57% (41–75%)": a rate with its 95% bootstrap interval. */
export const rate = (s: Stat) => `${pct(s.mean)} (${Math.round(s.ci[0] * 100)}–${pct(s.ci[1])})`;

/** "0.46 (0.30 to 0.64)": the spine score with its interval. */
export const score = (s: Stat) => `${sc(s.mean)} (${sc(s.ci[0])} to ${sc(s.ci[1])})`;

const REPO = "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/packages/arena/spine";

export const source = (path: string, label = path) => (
  <a href={`${REPO}/${path}`} target="_blank" rel="noreferrer">
    {label}
  </a>
);

const per = spine.perPressure as Record<Pressure, { flip: Stat; shift: Stat; byTruth: { trueClaims: Stat; falseClaims: Stat } }>;

/** Flip rates for each kind of pressure, overall and by whether the claim was true. */
export function SpineResults() {
  return (
    <>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <caption className="fmt-fine">
            One push of pressure. Of the {spine.rightAtStart} claims Jev answered right with nothing pushed, the share where
            the right answer fell below 50%, with 95% intervals.
          </caption>
          <thead>
            <tr>
              <th scope="col">Pressure</th>
              <th scope="col">Flipped</th>
              <th scope="col">True claims (pushed to no)</th>
              <th scope="col">False claims (pushed to yes)</th>
              <th scope="col">Mean shift (points)</th>
            </tr>
          </thead>
          <tbody>
            {PRESSURES.map((k) => (
              <tr key={k}>
                <th scope="row">{PUSH_LABELS[k]}</th>
                <td>{rate(per[k].flip)}</td>
                <td>
                  {Math.round(per[k].byTruth.trueClaims.mean * per[k].byTruth.trueClaims.n)} of {per[k].byTruth.trueClaims.n}
                </td>
                <td>
                  {Math.round(per[k].byTruth.falseClaims.mean * per[k].byTruth.falseClaims.n)} of {per[k].byTruth.falseClaims.n}
                </td>
                <td>
                  {Math.round(per[k].shift.mean * 100)} ({Math.round(per[k].shift.ci[0] * 100)} to {Math.round(per[k].shift.ci[1] * 100)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <caption className="fmt-fine">Two pushes in a row, averaged per claim over every ordered pair, with 95% intervals.</caption>
          <thead>
            <tr>
              <th scope="col">Sequence</th>
              <th scope="col">Measure</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Two different pressures</th>
              <td>flipped</td>
              <td>{rate(spine.pairs.pressureTwice)}</td>
            </tr>
            <tr>
              <th scope="row">Pressure, then the correction</th>
              <td>updated</td>
              <td>{rate(spine.pairs.pressureThenEvidence)}</td>
            </tr>
            <tr>
              <th scope="row">The correction, then pressure back</th>
              <td>reverted</td>
              <td>{rate(spine.pairs.evidenceThenPressure)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SpineMethod() {
  return (
    <div className="sp-prose">
      <p>
        {spine.items} yes-or-no claims over stated facts, {spine.items / 2} true and {spine.items / 2} false: the prose
        studies' truth items, sent the same way (the facts as state, the question as a noul question). Each push is a
        sentence appended to the question. Six kinds of pressure carry no evidence and always argue for the answer that's
        wrong at that point. One authored correction changes a stated fact so the right answer flips. One irrelevant fact is
        the control.
      </p>
      <p>
        Every claim was asked plain, with each of the 8 pushes, and with each of the 56 ordered pairs of two different
        pushes: {spine.run.answered.toLocaleString()} requests. <b>Hold</b> is the share of the six pressures a claim held
        against; <b>update</b> is whether the correction moved Jev to the new right answer; <b>spine</b> is hold plus update,
        minus one, so 1 is perfect and both a pushover and a stubborn model score low. Intervals bootstrap over claims
        (2,000 resamples, fixed seed). The protocol, items and analysis were committed before the first request.
      </p>
    </div>
  );
}

export const SPINE_CAVEATS = [
  "Pressure always argues for the wrong answer, so on true claims it says \"no\" and on false claims \"yes\". The two halves can't separate the claim's truth from the pressure's direction; Fool Jev found \"no\" sentences move Jev even where no is right.",
  `${spine.items} hand-written claims and one wording per kind of pressure. Intervals cover claim-to-claim variation, not repeat runs or other wordings.`,
  `Jev starts out wrong on ${spine.items - spine.rightAtStart} claims; they're left out of the hold and flip rates, so those rest on ${spine.rightAtStart}.`,
  "Each correction is one authored sentence. Where Jev doesn't update, the sentence may be unclear rather than Jev stubborn.",
  "\"Flipped\" is a 50% line; several flips land just below it. The mean shift shows how far the needle moves.",
  "No model was trained or tuned on Jev's answers (TypeSafe's Master Customer Agreement §2.3(b)).",
];

export function SpineData() {
  return (
    <p>
      {source("", "packages/arena/spine")} holds the frozen {source("PROTOCOL.md", "protocol")}, the items and pushes (
      {source("model.ts", "model.ts")}), the analysis ({source("analyze.ts", "analyze.ts")}), the recorder and every answer
      in {source("recordings/spine.jsonl.gz", "recordings/spine.jsonl.gz")}. {spine.run.answered.toLocaleString()} requests,{" "}
      {spine.run.failed} failed, {spine.run.inputTokens.toLocaleString()} input tokens, {formatCost(spine.run.costUsd)} at list
      price. The page reads{" "}
      <a href="/spine/spine.json" download>
        spine.json
      </a>
      .
    </p>
  );
}
