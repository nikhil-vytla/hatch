/**
 * How sure each model says it is on Typed Decisions, against how often its top option is the
 * teacher's, with the scoring choices that move the headline numbers laid out side by side.
 * Computed in the browser from the published per-question distributions; no new model calls.
 */
import { useMemo, useState } from "react";
import { calibration, type Bin } from "../../local-models-and-games/calibration";
import { Pane, Stat } from "./shared";
import { percent1 as pct } from "./api";


const fixed = (n: number, d = 3) => n.toFixed(d);

/** A reliability diagram: bars at each confidence bin's agreement, the diagonal for reference. */
function Reliability({ bins }: { bins: Bin[] }) {
  const w = 320;
  const h = 220;
  const pad = 32;
  const x = (v: number) => pad + v * (w - pad * 1.5);
  const y = (v: number) => h - pad - v * (h - pad * 1.5);
  const max = Math.max(1, ...bins.map((b) => b.n));

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="calibration-chart"
      role="img"
      aria-label={bins
        .map((b) => `stated ${pct(b.confidence)}, matched ${pct(b.agreement)} (${b.n})`)
        .join("; ")}
    >
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="calibration-diagonal" />
      {bins.map((b) => (
        <g key={b.lo}>
          <rect
            x={x(b.lo) + 1}
            width={x(b.hi) - x(b.lo) - 2}
            y={y(b.agreement)}
            height={y(0) - y(b.agreement)}
            className="calibration-bar"
            opacity={0.35 + 0.65 * (b.n / max)}
          />
          <circle cx={x(b.confidence)} cy={y(b.agreement)} r={3} className="calibration-dot" />
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} className="calibration-axis" />
      <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} className="calibration-axis" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <text x={x(v)} y={h - 10} textAnchor="middle" className="calibration-label">
            {v * 100}%
          </text>
          <text x={pad - 6} y={y(v) + 4} textAnchor="end" className="calibration-label">
            {v * 100}%
          </text>
        </g>
      ))}
    </svg>
  );
}

export function CalibrationPanel({
  result,
}: {
  result: { cases: { questions: never[] }[]; models: { id: string; name: string }[] };
}) {
  const [model, setModel] = useState(
    result.models.some((m) => m.id === "jev") ? "jev" : result.models[0]?.id,
  );
  const questions = useMemo(() => result.cases.flatMap((c) => c.questions), [result]);
  const c = useMemo(() => calibration(questions, model), [questions, model]);
  const name = result.models.find((m) => m.id === model)?.name ?? model;

  return (
    <Pane
      title="How sure, and how often it agrees"
      sub={`${c.questions.toLocaleString()} decisions`}
    >
      <label className="calibration-model">
        Model{" "}
        <select
          aria-label="Calibration model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {result.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="calibration-grid">
        <div>
          <Reliability bins={c.reliability} />
          <p className="fine">
            Bars: how often {name}'s top option is the teacher's, at each stated confidence. On the
            diagonal, "70% sure" is right 70% of the time. Fainter bars hold fewer decisions.
          </p>
        </div>
        <div className="calibration-stats">
          <Stat value={pct(c.agreement)} label="Agrees with the teacher" />
          <Stat value={pct(c.confidence)} label="Average stated confidence" />
          <Stat
            value={`${c.overconfidence >= 0 ? "+" : ""}${pct(c.overconfidence)}`}
            label="Overconfidence"
            note="Confidence minus agreement"
          />
          <Stat value={fixed(c.ece)} label="Calibration error (ECE)" note="Ten bins" />
        </div>
      </div>

      <h3>Why the same answers get different scores</h3>
      <div className="model-table-wrap">
        <table className="model-table">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">{name}</th>
              <th scope="col">What changes it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Brier, averaged per option</th>
              <td>{fixed(c.brierPerOption)}</td>
              <td>This study's definition</td>
            </tr>
            <tr>
              <th scope="row">Brier, summed per question</th>
              <td>{fixed(c.brierPerQuestion)}</td>
              <td>The same errors, not divided by the number of options</td>
            </tr>
            {c.kl.map((k) => (
              <tr key={k.floor}>
                <th scope="row">
                  KL from the teacher, zeros floored at {k.floor.toExponential(0)}
                </th>
                <td>{fixed(k.value)}</td>
                <td>
                  {k.floor === 1e-12 ? "This study's definition" : "Same answers, a gentler floor"}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">Probabilities that are exactly 0</th>
              <td>{pct(c.exactZeros)}</td>
              <td>A model that rounds to zero pays whatever the floor charges</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="fine">
        Agreement is with a teacher (the mean of three samples from a roughly 4B-class model), not
        independent correctness. The dataset card puts the teacher's agreement with itself at 73.5%,
        so scores near that are at the ceiling. The card's Jev 1.13.0 row (measured 18 Sep 2026
        through TypeSafe's API) reports agreement 0.727, Brier 0.148, KL 1.442 and ECE 0.144. Its
        Brier matches the per-question sum here and its overconfidence (+0.023) matches ours. Its KL
        and ECE definitions aren't stated, so those two aren't compared.{" "}
        <a
          href="https://huggingface.co/datasets/LocalLLaMA/typed-decisions"
          target="_blank"
          rel="noreferrer"
        >
          Dataset card
        </a>
      </p>
    </Pane>
  );
}
