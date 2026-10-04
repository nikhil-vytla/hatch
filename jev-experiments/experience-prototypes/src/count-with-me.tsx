/**
 * Count with me: guess how many objects are in a photo, then see what an open vision model, an
 * object detector and Jev (reading the detector's boxes as text) answered, against COCO's exact
 * annotations. The rounds grow from one object to forty. Everything replays recordings
 * (live-worlds/count); nothing calls a model.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CountData } from "../../live-worlds/count/build";
import { binOf, jevRequest, LETTERS, type Detection } from "../../live-worlds/count/model";
import { fetchJson, percent as pct } from "./api";
import { Receipt } from "./receipt";
import { ModeTag } from "./trust";
import "./count-with-me.css";

type Item = CountData["items"][number];
type Lane = CountData["lanes"][number];
type LaneAnswer = Item["answers"][string];

/** One round per count bin, smallest first: the crowd gets bigger as you go. */
const ROUND_BINS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const CROWD_BIN = 6;

const LANE_TEXT: Record<string, string> = { vlm: "Qwen3-VL-4B", detector: "DETR detector", jev: "Jev on the boxes" };

function pickRounds(items: Item[], seed: number) {
  // A small deterministic shuffle per set, so "New set" changes the photos.
  return ROUND_BINS.flatMap((b) => {
    const inBin = items.filter((it) => it.bin === b);

    return inBin.length ? [inBin[(seed * 7 + b * 13) % inBin.length]] : [];
  });
}

const offBy = (bin: number, truth: number) => Math.abs(bin - truth);

function Verdict({ bin, truth }: { bin: number; truth: number }) {
  const d = offBy(bin, truth);

  return <span className={`cw-verdict${d === 0 ? " is-right" : ""}`}>{d === 0 ? "✓ right" : `✗ off by ${d} bin${d === 1 ? "" : "s"}`}</span>;
}

function Bars({ bins, truth, labels }: { bins: Record<string, number>; truth: number; labels: string[] }) {
  return (
    <div className="cw-bars" role="img" aria-label={`Probability per count: ${labels.map((l, i) => `${l} ${pct(bins[LETTERS[i]] ?? 0)}`).join(", ")}`}>
      {labels.map((l, i) => (
        <div key={l} className={`cw-bar${i === truth ? " is-truth" : ""}`} title={`${l}: ${pct(bins[LETTERS[i]] ?? 0)}`}>
          <span style={{ height: `${Math.max(2, (bins[LETTERS[i]] ?? 0) * 100)}%` }} />
          <small>{l.replace(" or more", "+")}</small>
        </div>
      ))}
    </div>
  );
}

function Photo({ item, showTruth, showDetector, threshold }: { item: Item; showTruth: boolean; showDetector: boolean; threshold: number }) {
  const sx = item.thumbWidth / item.width;
  const sy = item.thumbHeight / item.height;

  return (
    <figure className="cw-photo">
      <div className="cw-frame" style={{ aspectRatio: `${item.thumbWidth} / ${item.thumbHeight}` }}>
        <img src={`/count/${item.thumb}`} alt={`A ${item.kind === "composite" ? "grid of four photos" : "photo"} with ${item.plural} in it`} width={item.thumbWidth} height={item.thumbHeight} />
        <svg viewBox={`0 0 ${item.thumbWidth} ${item.thumbHeight}`} aria-hidden="true">
          {showTruth &&
            item.boxes.map((b, i) => <rect key={`t${i}`} className="cw-box-truth" x={b[0] * sx} y={b[1] * sy} width={b[2] * sx} height={b[3] * sy} />)}
          {showDetector &&
            item.detections
              .filter((d) => d.score >= threshold)
              .map((d, i) => <rect key={`d${i}`} className="cw-box-det" x={d.box[0] * sx} y={d.box[1] * sy} width={d.box[2] * sx} height={d.box[3] * sy} />)}
        </svg>
      </div>
      <figcaption className="cw-credit">
        {item.kind === "composite" ? "Four COCO photos in a grid: " : "Photo: "}
        {item.credit.map((c, i) => (
          <span key={c.cocoId}>
            {i > 0 && "; "}
            <a href={c.flickr ?? c.coco} target="_blank" rel="noreferrer">
              COCO {c.cocoId}
            </a>
            ,{" "}
            <a href={c.licenceUrl} target="_blank" rel="noreferrer">
              {c.licence.replace(" License", "")}
            </a>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function Reveal({ item, data, guess, ms }: { item: Item; data: CountData; guess: number; ms: number }) {
  const vlm = item.answers.vlm;
  const det = item.answers.detector;
  const jev = item.answers.jev;
  const guessBin = binOf(guess);
  const request = useMemo(() => jevRequest(item, item.detections as Detection[]), [item]);
  const ladder = (a: LaneAnswer) =>
    data.thresholds.map((n) => {
      const p = a.more[`more${n}`];
      const right = p >= 0.5 === item.count > n;

      return (
        <li key={n} className={right ? "is-right" : ""}>
          more than {n}? <b>{p >= 0.5 ? "yes" : "no"}</b> {pct(p >= 0.5 ? p : 1 - p)}
        </li>
      );
    });
  const even = (a: LaneAnswer) =>
    a.even === null ? null : (
      <li className={a.even >= 0.5 === (item.count % 2 === 0) ? "is-right" : ""}>
        even? <b>{a.even >= 0.5 ? "yes" : "no"}</b> {pct(a.even >= 0.5 ? a.even : 1 - a.even)}
      </li>
    );

  return (
    <div className="cw-reveal" aria-live="polite">
      <p className="cw-truth">
        <b>{item.count}</b> {item.plural}
        <small>COCO's annotators outlined every one{item.kind === "composite" ? ", across the four photos" : ""}.</small>
      </p>
      <div className="cw-cards">
        <section className="cw-card is-you">
          <h4>You</h4>
          <p className="cw-answer">{guess}</p>
          <Verdict bin={guessBin} truth={item.bin} />
          <p className="cw-fine">
            {item.count === guess ? "Exactly right." : `Off by ${Math.abs(guess - item.count)}.`} You took {(ms / 1000).toFixed(1)} s.
          </p>
        </section>
        {vlm && (
          <section className="cw-card">
            <h4>Qwen3-VL-4B</h4>
            <p className="cw-sees">looked at the photo</p>
            <p className="cw-answer">{data.bins[binOf(vlm.estimate)]}</p>
            <Verdict bin={binOf(vlm.estimate)} truth={item.bin} />
            <Bars bins={vlm.bins} truth={item.bin} labels={data.bins} />
            <ul className="cw-ladder">
              {ladder(vlm)}
              {even(vlm)}
            </ul>
            <Receipt
              data={{
                mode: "recorded",
                ms: vlm.ms,
                questions: data.prompts.length,
                costUsd: 0,
                servedBy: "MLX-VLM on an M4 Max",
                raw: { request: data.prompts.map((p) => ({ ...p, question: p.question.replaceAll("{objects}", item.plural) })), response: vlm, note: "One prefill per question; the answer labels' logits, softmaxed." },
              }}
              label="Vision model"
            />
          </section>
        )}
        {det && (
          <section className="cw-card">
            <h4>DETR detector</h4>
            <p className="cw-sees">looked at the photo</p>
            <p className="cw-answer">{det.exact}</p>
            <Verdict bin={binOf(det.exact ?? 0)} truth={item.bin} />
            <p className="cw-fine">
              boxes it was at least {pct(data.detectorThreshold)} sure of. It drew {item.detections.length} at {pct(data.factsThreshold)} or more.
            </p>
            <Receipt data={{ mode: "recorded", ms: det.ms, costUsd: 0, servedBy: "transformers.js, local" }} label="Detector" />
          </section>
        )}
        {jev && (
          <section className="cw-card is-jev">
            <h4>Jev on the boxes</h4>
            <p className="cw-sees">read the detector's {item.detections.length} boxes as text</p>
            <p className="cw-answer">{data.bins[binOf(jev.estimate)]}</p>
            <Verdict bin={binOf(jev.estimate)} truth={item.bin} />
            <Bars bins={jev.bins} truth={item.bin} labels={data.bins} />
            <ul className="cw-ladder">
              {ladder(jev)}
              {even(jev)}
            </ul>
            <Receipt
              data={{ mode: "recorded", ms: jev.ms, questions: 6, inputTokens: item.jev?.inputTokens, at: item.jev?.at, servedBy: item.jev?.servedBy, raw: { request, response: jev } }}
              label="Jev"
            />
          </section>
        )}
      </div>
    </div>
  );
}

/** Signed error against true count, every image, one decider; dots coloured by crowding. */
function ErrorChart({ data, lane }: { data: CountData; lane: string }) {
  // Drawn at its real width, so the labels stay a readable size on a phone and on a wide screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);

  useEffect(() => {
    const el = box.current;

    if (!el) return;

    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));

    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  const H = W < 500 ? 260 : 320;
  const pad = { l: 36, r: 10, t: 12, b: 34 };
  const x = (n: number) => pad.l + (Math.log(n) / Math.log(50)) * (W - pad.l - pad.r);
  const yMax = 20;
  const yMin = -30;
  const y = (e: number) => pad.t + ((yMax - Math.max(yMin, Math.min(yMax, e))) / (yMax - yMin)) * (H - pad.t - pad.b);
  const crowd = (o: number) => (o === 0 ? "apart" : o < 0.6 ? "touching" : "packed");
  const points = data.items.flatMap((it, i) => {
    const a = it.answers[lane];

    if (!a) return [];

    // A little sideways spread so photos with the same count don't hide each other.
    const jitter = ((i * 37) % 11) / 11 - 0.5;

    return [{ id: it.id, cx: x(it.count * (1 + jitter * 0.06)), cy: y(a.estimate - it.count), cls: crowd(it.overlapShare), label: `${it.count} ${it.plural}, answered ${a.estimate}` }];
  });

  return (
    <div ref={box}>
      <svg className="cw-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${LANE_TEXT[lane]}: answer minus truth against the true count, for ${points.length} images`}>
        {[-30, -20, -10, 0, 10, 20].map((e) => (
          <g key={e}>
            <line x1={pad.l} x2={W - pad.r} y1={y(e)} y2={y(e)} className={e === 0 ? "cw-axis-zero" : "cw-grid"} />
            <text x={pad.l - 6} y={y(e) + 4} textAnchor="end">
              {e > 0 ? `+${e}` : e}
            </text>
          </g>
        ))}
        {[1, 2, 3, 5, 10, 20, 30, 50].map((n) => (
          <text key={n} x={x(n)} y={H - pad.b + 16} textAnchor="middle">
            {n}
          </text>
        ))}
        <text x={(W + pad.l) / 2} y={H - 4} textAnchor="middle" className="cw-axis-label">
          true count (log scale)
        </text>
        <text x={pad.l + 6} y={pad.t + 14} className="cw-axis-label">
          ↑ said too many
        </text>
        <text x={pad.l + 6} y={H - pad.b - 6} className="cw-axis-label">
          ↓ said too few
        </text>
        {points.map((p) => (
          <circle key={p.id} cx={p.cx} cy={p.cy} r={5} className={`cw-dot is-${p.cls}`}>
            <title>{p.label}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function CrowdBars({ lanes }: { lanes: Lane[] }) {
  return (
    <div className="cw-crowd-bars">
      {lanes[0].groups.map((g, gi) => (
        <div key={g.id} className="cw-crowd-group">
          <h4>{g.label}</h4>
          {lanes.map((l) => {
            const s = l.groups[gi];

            return (
              <div key={l.id} className={`cw-hbar is-${l.id}`}>
                <span className="cw-hbar-label">{l.label}</span>
                <span className="cw-hbar-track">
                  <span style={{ width: `${s.exactBin.mean * 100}%` }} />
                </span>
                <b>{pct(s.exactBin.mean)}</b>
              </div>
            );
          })}
          <p className="cw-fine">{lanes[0].groups[gi].n} images</p>
        </div>
      ))}
    </div>
  );
}

export function CountWithMe() {
  const [data, setData] = useState<CountData | null>(null);
  const [failed, setFailed] = useState(false);
  const [set, setSet] = useState(0);
  const [round, setRound] = useState(0);
  const [guess, setGuess] = useState("");
  const [played, setPlayed] = useState<{ id: string; guess: number; ms: number }[]>([]);
  const [showTruth, setShowTruth] = useState(true);
  const [showDetector, setShowDetector] = useState(false);
  const [chartLane, setChartLane] = useState("vlm");
  const shownAt = useRef(performance.now());
  const input = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchJson<CountData>("/count/count.json")
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const rounds = useMemo(() => (data ? pickRounds(data.items, set) : []), [data, set]);

  useEffect(() => {
    shownAt.current = performance.now();
  }, [round, set]);

  if (failed) return <p className="cw-fine">The recordings couldn't be loaded.</p>;

  if (!data || !rounds.length) return <p className="cw-fine">Loading the photos…</p>;

  const item = rounds[Math.min(round, rounds.length - 1)];
  const done = played[round]?.id === item.id ? played[round] : null;
  const vlm = data.lanes.find((l) => l.id === "vlm");
  const few = vlm?.groups.find((g) => g.id === "few");
  const crowd = vlm?.groups.find((g) => g.id === "crowd");
  const firstCrowd = rounds.findIndex((r) => r.bin >= CROWD_BIN);
  const lock = () => {
    const n = Number(guess);

    if (!guess || !Number.isInteger(n) || n < 0) return;

    setPlayed((p) => [...p.slice(0, round), { id: item.id, guess: n, ms: performance.now() - shownAt.current }]);
  };
  const next = () => {
    setGuess("");
    setShowDetector(false);
    setRound((r) => r + 1);
    // The next photo starts at the top of the round, not wherever the last reveal left the page.
    requestAnimationFrame(() => {
      top.current?.scrollIntoView({ block: "start" });
      input.current?.focus({ preventScroll: true });
    });
  };
  const restart = () => {
    setSet((s) => s + 1);
    setRound(0);
    setPlayed([]);
    setGuess("");
  };
  const tally = (lane: string | "you") =>
    played.filter((p) => {
      const it = rounds.find((r) => r.id === p.id)!;
      const est = lane === "you" ? p.guess : it.answers[lane]?.estimate;

      return est !== undefined && binOf(est) === it.bin;
    }).length;

  return (
    <div className="cw">
      <div className="cw-top" ref={top}>
        <p className="cw-round">
          Round {Math.min(round + 1, rounds.length)} of {rounds.length}
        </p>
        <div className="cw-dots" aria-hidden="true">
          {rounds.map((r, i) => (
            <span key={r.id} className={i < played.length ? "is-done" : i === round ? "is-now" : ""} />
          ))}
        </div>
        <ModeTag mode="recorded" />
        <button type="button" className="cw-button is-quiet" onClick={restart}>
          New set of photos
        </button>
      </div>

      {round === firstCrowd && !done && few && crowd && (
        <p className="cw-crowd-callout" role="status">
          <b>The crowd gets bigger.</b> On {few.n} photos of {few.label} objects, Qwen3-VL-4B named the right count {pct(few.exactBin.mean)} of the time. On the{" "}
          {crowd.n} with {crowd.label}, {pct(crowd.exactBin.mean)}.
        </p>
      )}

      {round < rounds.length ? (
        <div className="cw-stage">
          <Photo item={item} showTruth={!!done && showTruth} showDetector={!!done && showDetector} threshold={data.detectorThreshold} />
          <div className="cw-side">
            {!done ? (
              <form
                className="cw-guess"
                onSubmit={(e) => {
                  e.preventDefault();
                  lock();
                }}
              >
                <label htmlFor="cw-guess-input">
                  How many <b>{item.plural}</b>?
                </label>
                {item.kind === "composite" && <p className="cw-fine">Four photos in a grid: count across all of them.</p>}
                <div className="cw-guess-row">
                  <input
                    id="cw-guess-input"
                    ref={input}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={500}
                    value={guess}
                    onChange={(e) => setGuess(e.target.value)}
                    autoComplete="off"
                  />
                  <button type="submit" className="cw-button" disabled={!guess}>
                    Lock it in
                  </button>
                </div>
                <p className="cw-fine">Guess first. Then see what a vision model, a detector and Jev said, and the real count.</p>
              </form>
            ) : (
              <>
                <Reveal item={item} data={data} guess={done.guess} ms={done.ms} />
                <div className="cw-toggles">
                  <label>
                    <input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> <span className="cw-key is-truth" /> COCO's outlines
                  </label>
                  <label>
                    <input type="checkbox" checked={showDetector} onChange={(e) => setShowDetector(e.target.checked)} /> <span className="cw-key is-det" /> detector's boxes
                  </label>
                </div>
                {round < rounds.length - 1 ? (
                  <button type="button" className="cw-button" onClick={next}>
                    Next photo →
                  </button>
                ) : (
                  <button type="button" className="cw-button" onClick={() => {
                      setRound(rounds.length);
                      requestAnimationFrame(() => top.current?.scrollIntoView({ block: "start" }));
                    }}>
                    See the score →
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}

      {round >= rounds.length && (
        <section className="cw-score" aria-labelledby="cw-score-title">
          <h3 id="cw-score-title">Right count, {rounds.length} photos</h3>
          <ul>
            {(["you", ...data.lanes.map((l) => l.id)] as const).map((l) => (
              <li key={l} className={l === "you" ? "is-you" : ""}>
                <span>{l === "you" ? "You" : LANE_TEXT[l]}</span>
                <b>
                  {tally(l)} of {played.length}
                </b>
              </li>
            ))}
          </ul>
          <button type="button" className="cw-button" onClick={restart}>
            Play a new set
          </button>
        </section>
      )}

      <section className="cw-all" aria-labelledby="cw-all-title">
        <h3 id="cw-all-title">All {data.items.length} photos: the bigger the crowd, the bigger the miss</h3>
        <CrowdBars lanes={data.lanes} />
        <div className="cw-chart-head">
          <div className="cw-seg" role="group" aria-label="Decider">
            {data.lanes.map((l) => (
              <button key={l.id} type="button" aria-pressed={chartLane === l.id} onClick={() => setChartLane(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
          <p className="cw-legend">
            <span className="cw-dot-key is-apart" /> objects apart <span className="cw-dot-key is-touching" /> some touch <span className="cw-dot-key is-packed" /> packed
          </p>
        </div>
        <ErrorChart data={data} lane={chartLane} />
        <p className="cw-fine">
          Each dot is a photo: its answer minus the true count. The vision model and Jev answer in count bins, so a dot sits at the middle of the bin they chose (38 for "30 or more").
          The detector's dot is its exact number of confident boxes. Results by bin, with 95% intervals, are under About & evidence.
        </p>
      </section>
    </div>
  );
}
