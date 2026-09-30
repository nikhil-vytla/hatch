/**
 * When to ask a person: pick the confidence below which Jev hands a case to a human, and see
 * what that costs in reviews and saves in mistakes. Every number is counted from recorded Jev
 * answers with known right answers; nothing here calls a model.
 */
import { useEffect, useMemo, useState } from "react";
import { cheapest, curve, split, top, type Decision } from "../../packages/arena/src/handoff/model";
import { Notice, Pane, Pills, Stat } from "./shared";

/** How far each dataset's stated confidence can be trusted, from its recorded calibration. */
type Source = { id: string; label: string; about: string; unit: string; calibration: string };

const SOURCES: Source[] = [
  {
    id: "banking77",
    label: "BANKING77",
    about: "385 banking requests, 77 possible intents. Right means the dataset's intent label.",
    unit: "requests",
    calibration:
      "Here Jev is overconfident below about 90%: when it says 76% or 86% it is right only 31% and 59% of the time (calibration error 0.10). A threshold still helps, but less than its number suggests.",
  },
  {
    id: "clinc150",
    label: "CLINC150",
    about: "400 assistant requests, 151 intents including out-of-scope. Right means the dataset's label.",
    unit: "requests",
    calibration: "Here Jev's confidence roughly tracks how often it is right (calibration error 0.05).",
  },
  {
    id: "typed",
    label: "Typed Decisions",
    about:
      "2,000 workflow decisions. Right means Jev's top option matches the teacher's; the teacher agrees with itself only 73.5% of the time.",
    unit: "decisions",
    calibration:
      "Here Jev's confidence tracks how often it agrees with the teacher closely (calibration error 0.04; see the calibration panel in Decision models on a Mac).",
  },
];

const COSTS = [1, 2, 5, 10, 20, 50, 100];

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function fromIntent(result: any, id: string): Decision[] {
  return (result?.experiments?.[id]?.rows ?? [])
    .filter((r: any) => !r.error && r.probabilities)
    .map((r: any) => ({ confidence: top(r.probabilities).confidence, right: r.prediction === r.target }));
}

function fromTyped(result: any): Decision[] {
  return (result?.cases ?? [])
    .flatMap((c: any) => c.questions)
    .filter((q: any) => q.predictions?.jev)
    .map((q: any) => {
      const p = top(q.predictions.jev);

      return { confidence: p.confidence, right: p.key === top(q.target).key };
    });
}

/** Share handled against error rate among handled, with the current threshold marked. */
function Tradeoff({ decisions, threshold }: { decisions: Decision[]; threshold: number }) {
  const points = useMemo(() => curve(decisions), [decisions]);
  const here = split(decisions, threshold);
  const w = 360;
  const h = 200;
  const pad = 34;
  const maxErr = Math.max(0.05, ...points.map((p) => p.errorRate));
  const x = (c: number) => pad + c * (w - pad * 1.5);
  const y = (e: number) => h - pad - (e / maxErr) * (h - pad * 1.5);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.coverage).toFixed(1)},${y(p.errorRate).toFixed(1)}`).join(" ");
  const hx = x(here.total ? here.handled / here.total : 0);
  const hy = y(here.handled ? here.mistakes / here.handled : 0);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="handoff-chart" role="img" aria-label="Share Jev handles against its error rate">
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} className="handoff-axis" />
      <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(maxErr)} className="handoff-axis" />
      <path d={path} className="handoff-line" />
      <circle cx={hx} cy={hy} r={5} className="handoff-dot" />
      <text x={x(0)} y={h - 12} className="handoff-label">Jev handles 0%</text>
      <text x={x(1)} y={h - 12} textAnchor="end" className="handoff-label">100%</text>
      <text x={pad - 6} y={y(maxErr) + 4} textAnchor="end" className="handoff-label">
        {pct(maxErr)}
      </text>
      <text x={pad - 6} y={y(0) + 4} textAnchor="end" className="handoff-label">
        0%
      </text>
      <text x={x(0) + 4} y={y(maxErr) - 6} className="handoff-label">
        wrong among the cases it handles
      </text>
    </svg>
  );
}

export function Handoff({ result }: { result: any }) {
  const [source, setSource] = useState(SOURCES[0]);
  const [threshold, setThreshold] = useState(0.9);
  const [cost, setCost] = useState(5);
  const [typed, setTyped] = useState<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (source.id !== "typed" || typed) return;

    fetch("/data/local-models.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setTyped(d.result))
      .catch(() => setFailed(true));
  }, [source, typed]);

  const decisions = useMemo(
    () => (source.id === "typed" ? fromTyped(typed) : fromIntent(result, source.id)),
    [source, typed, result],
  );

  const s = split(decisions, threshold);
  const best = useMemo(() => cheapest(decisions, cost), [decisions, cost]);
  const sure = split(decisions, 0.995);

  if (source.id === "typed" && !typed)
    return (
      <div className="handoff">
        <Pills values={SOURCES.map((x) => x.label)} value={source.label} onChange={(v) => setSource(SOURCES.find((x) => x.label === v) ?? SOURCES[0])} />
        <Notice>{failed ? "The Typed Decisions recording could not be loaded." : "Loading 2,000 recorded decisions…"}</Notice>
      </div>
    );

  return (
    <div className="handoff">
      <Pills values={SOURCES.map((x) => x.label)} value={source.label} onChange={(v) => setSource(SOURCES.find((x) => x.label === v) ?? SOURCES[0])} />
      <p className="fine">{source.about}</p>

      <Pane title="Jev acts when it is at least this sure" sub={`${decisions.length.toLocaleString()} recorded ${source.unit}`}>
        <label className="handoff-slider">
          <span>
            Threshold <b>{threshold > 1 ? "review everything" : pct(threshold)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={1.01}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            aria-label="Confidence threshold"
          />
        </label>
        <div className="handoff-grid">
          <Tradeoff decisions={decisions} threshold={threshold} />
          <div className="stats-row handoff-stats">
            <Stat label="Jev handles" value={`${s.handled.toLocaleString()} (${pct(s.total ? s.handled / s.total : 0)})`} />
            <Stat label="Right among those" value={s.handled ? pct(1 - s.mistakes / s.handled) : "—"} />
            <Stat label="Mistakes nobody reviews" value={s.mistakes.toLocaleString()} />
            <Stat label="Sent to a person" value={s.reviewed.toLocaleString()} />
          </div>
        </div>
        {sure.handled > 0 && (
          <p className="fine">
            Even when Jev says it is 100% sure (after rounding), it is wrong on {sure.mistakes} of {sure.handled}{" "}
            {source.unit} here.
          </p>
        )}
      </Pane>

      <Pane title="What threshold is cheapest?" sub="Counting a review as one unit of cost">
        <label className="handoff-slider">
          <span>
            An unreviewed mistake costs as much as <b>{cost}</b> review{cost === 1 ? "" : "s"}
          </span>
          <input
            type="range"
            min={0}
            max={COSTS.length - 1}
            step={1}
            value={COSTS.indexOf(cost)}
            onChange={(e) => setCost(COSTS[Number(e.target.value)])}
            aria-label="Cost of a mistake in reviews"
          />
        </label>
        {best && (
          <p>
            {best.split.threshold > 1 ? (
              <>Review everything: at this cost no threshold beats a person checking every case.</>
            ) : best.split.threshold === 0 ? (
              <>
                Act on everything: at this cost a mistake is cheaper than reviewing, so Jev handles all{" "}
                {best.split.total.toLocaleString()} and gets {best.split.mistakes} wrong.
              </>
            ) : (
              <>
                The cheapest threshold is <b>{pct(best.split.threshold)}</b>: Jev handles{" "}
                {pct(best.split.handled / best.split.total)} of cases with {best.split.mistakes} unreviewed mistakes
                ({pct(best.split.mistakes / best.split.handled)} of those it handles), and people review{" "}
                {best.split.reviewed.toLocaleString()}.
              </>
            )}{" "}
            {best.split.threshold <= 1 && best.split.threshold !== threshold && (
              <button type="button" className="text-link" onClick={() => setThreshold(best.split.threshold)}>
                Use this threshold
              </button>
            )}
          </p>
        )}
        <p className="fine">A threshold only helps as far as the confidence means something. {source.calibration}</p>
      </Pane>
    </div>
  );
}
