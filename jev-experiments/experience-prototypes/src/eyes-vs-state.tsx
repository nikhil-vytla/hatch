/**
 * Eyes against state: the same Snake game read two ways, on the same seed.
 *
 *   Lane A reads the game's facts (positions as text): the greedy rule (free) or Jev's recorded
 *   games. Lane B looks at a screenshot: an open vision-language model (Qwen3-VL), recorded once on
 *   an M4 Max, one prefill per move, its answer letters scored the way SGLang's /v1/decisions does.
 *
 * Jev is text-only ("No image, audio, or video input"), so Jev never sees pixels. Everything here
 * replays recordings (live-worlds/eyes); nothing calls a model unless the visitor opts in to the
 * small in-browser model check at the bottom.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { greedy, initial, recordedRequest, step, type State } from "../../local-models-and-games/arcade/engine";
import type { EyesData } from "../../live-worlds/eyes/build";
import { apply, DIRECTIONS, PALETTE, type Direction, type Relative } from "../../live-worlds/eyes/model";
import { fetchJson, percent as pct } from "./api";
import { Receipt } from "./receipt";
import { ModeTag } from "./trust";
import "./eyes-vs-state.css";

type Frame = { seed: number; tick: number; p: Record<Direction, number>; chosen: Direction; move: Relative; greedy: string; ms: number; sha: string };
type Step = { state: State; frame?: Frame; action?: string; ms?: number | null };

const TICK_MS = 380;
const JEV_SEEDS = [7, 19, 42];

const ms = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x)} ms`);

/** Lane A: the greedy rule, or Jev's recorded moves where it has them. */
function factsSteps(seed: number, jev: { action: string; ms: number | null }[] | null): Step[] {
  let s = initial("snake", seed);
  const out: Step[] = [];

  for (let i = 0; s.status === "playing" && i < 90; i++) {
    const rec = jev?.[i];
    const action = rec ? rec.action : greedy(s);

    out.push({ state: s, action, ms: rec ? rec.ms : null });
    s = step(s, action);
  }

  out.push({ state: s });

  return out;
}

/** Lane B: the recorded vision-model moves, replayed through the engine. */
function pixelSteps(seed: number, frames: Frame[]): Step[] {
  const byTick = new Map(frames.filter((f) => f.seed === seed).map((f) => [f.tick, f]));
  let s = initial("snake", seed);
  const out: Step[] = [];

  while (s.status === "playing") {
    const f = byTick.get(s.tick);

    if (!f) break;

    out.push({ state: s, frame: f });
    s = apply(s, f.move);
  }

  out.push({ state: s });

  return out;
}

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Paints the board as the vision model saw it (live-worlds/eyes/frame.ts draws the same). */
function paint(c: CanvasRenderingContext2D, state: State) {
  const cell = 32;

  c.fillStyle = rgb(PALETTE.floor);
  c.fillRect(0, 0, 320, 320);
  c.strokeStyle = rgb(PALETTE.grid);

  for (let i = 0; i <= 10; i++) {
    c.beginPath();
    c.moveTo(i * cell + 0.5, 0);
    c.lineTo(i * cell + 0.5, 320);
    c.moveTo(0, i * cell + 0.5);
    c.lineTo(320, i * cell + 0.5);
    c.stroke();
  }

  c.fillStyle = rgb(PALETTE.body);

  for (const p of state.snake!.slice(1)) c.fillRect(p.x * cell + 2, p.y * cell + 2, cell - 4, cell - 4);

  c.fillStyle = rgb(PALETTE.head);
  c.fillRect(state.snake![0].x * cell + 2, state.snake![0].y * cell + 2, cell - 4, cell - 4);
  c.fillStyle = rgb(PALETTE.food);
  c.beginPath();
  c.arc((state.food!.x + 0.5) * cell, (state.food!.y + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
  c.fill();
}

function Board({ state, label }: { state: State; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current?.getContext("2d");

    if (c) paint(c, state);
  }, [state]);

  return <canvas ref={ref} width={320} height={320} className="ev-board" role="img" aria-label={label} />;
}

function Probabilities({ frame }: { frame: Frame }) {
  return (
    <ul className="ev-probs" aria-label="The model's probability for each direction">
      {DIRECTIONS.map((d) => (
        <li key={d} className={d === frame.chosen ? "is-chosen" : ""}>
          <span>{d}</span>
          <i style={{ width: pct(frame.p[d]) }} />
          <b>{pct(frame.p[d])}</b>
        </li>
      ))}
    </ul>
  );
}

/** Opt-in: time a real small vision-language model on a few frames, in this browser. */
function BrowserModelCheck({ steps }: { steps: Step[] }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<{ tick: number; answer: string; truth: string; ms: number }[]>([]);

  const run = async () => {
    setStatus("Loading SmolVLM-256M (about 250 MB, once)…");
    setRows([]);

    const worker = new Worker(new URL("./eyes-vlm.worker.ts", import.meta.url), { type: "module" });
    const picks = steps.filter((s) => s.action).filter((_, i) => i % 6 === 0).slice(0, 6);
    const canvas = document.createElement("canvas");

    canvas.width = canvas.height = 320;

    const blobs: { tick: number; truth: string; blob: Blob }[] = [];

    for (const s of picks) {
      paint(canvas.getContext("2d")!, s.state);
      blobs.push({ tick: s.state.tick, truth: greedy(s.state), blob: await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png")) });
    }

    worker.onmessage = (e) => {
      const m = e.data;

      if (m.type === "status") setStatus(m.text);
      else if (m.type === "row") setRows((r) => [...r, m.row]);
      else if (m.type === "done") {
        setStatus(m.text);
        worker.terminate();
      }
    };
    worker.postMessage({ frames: blobs });
  };

  return (
    <div className="ev-check">
      <button type="button" onClick={() => void run()}>
        Measure a small vision model in this browser <ModeTag mode="browser" />
      </button>
      <p className="ev-fine">SmolVLM-256M, about 250 MB downloaded once, on WebGPU if your browser has it. It answers six frames from this game.</p>
      {status && <p className="ev-fine" aria-live="polite">{status}</p>}
      {rows.length > 0 && (
        <table className="ev-table">
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col">It said</th>
              <th scope="col">Greedy rule, on the true state</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tick}>
                <td>{r.tick}</td>
                <td>{r.answer}</td>
                <td>{r.truth}</td>
                <td>{ms(r.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EyesVsState() {
  const [data, setData] = useState<EyesData | null>(null);
  const [failed, setFailed] = useState(false);
  const [seed, setSeed] = useState(42);
  const [runId, setRunId] = useState("qwen3-vl-4b.v1");
  const [useJev, setUseJev] = useState(true);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    fetchJson<EyesData>("/eyes/eyes.json")
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const run = data?.runs.find((r) => r.id === runId) ?? data?.runs[0];
  const jevTrace = useJev && JEV_SEEDS.includes(seed) ? (data?.jevTraces[seed] ?? null) : null;
  const facts = useMemo(() => factsSteps(seed, jevTrace), [seed, jevTrace]);
  const pixels = useMemo(() => (run ? pixelSteps(seed, run.frames as Frame[]) : []), [seed, run]);
  const length = Math.max(facts.length, pixels.length);

  useEffect(() => setTick(0), [seed, runId, useJev]);

  useEffect(() => {
    if (!playing || tick >= length - 1) return;

    const t = setTimeout(() => setTick((x) => x + 1), TICK_MS);

    return () => clearTimeout(t);
  }, [playing, tick, length]);

  if (failed) return <p className="ev-fine">The recordings couldn't be loaded.</p>;

  if (!data || !run) return <p className="ev-fine">Loading the recorded games…</p>;

  const a = facts[Math.min(tick, facts.length - 1)];
  const b = pixels[Math.min(tick, pixels.length - 1)];
  const bOver = b.state.status !== "playing";
  const aOver = a.state.status !== "playing";
  const lanes = [data.greedy, ...(data.jev ? [data.jev] : []), ...data.runs.map((r) => r.summary)];
  const p = data.perception;

  return (
    <div className="ev">
      <div className="ev-controls">
        <label>
          Game
          <select value={seed} onChange={(e) => setSeed(Number(e.target.value))}>
            {data.seeds.map((s) => (
              <option key={s} value={s}>
                Seed {s}
                {JEV_SEEDS.includes(s) ? " (Jev recorded)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Lane B model
          <select value={run.id} onChange={(e) => setRunId(e.target.value)}>
            {data.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ev-check-label">
          <input type="checkbox" checked={useJev} onChange={(e) => setUseJev(e.target.checked)} />
          Lane A uses Jev where recorded (seeds 7, 19, 42)
        </label>
        <button type="button" onClick={() => setPlaying((x) => !x)}>
          {playing ? "Pause" : tick >= length - 1 ? "Replay" : "Play"}
        </button>
        <button type="button" onClick={() => setTick(0)}>
          Restart
        </button>
        <input
          type="range"
          min={0}
          max={length - 1}
          value={tick}
          onChange={(e) => {
            setPlaying(false);
            setTick(Number(e.target.value));
          }}
          aria-label="Move"
        />
        <ModeTag mode="recorded" />
      </div>

      <div className="ev-lanes">
        <section className="ev-lane" aria-label="Lane A, reads the facts">
          <h3>A · reads the game's facts</h3>
          <p className="ev-fine">{jevTrace ? "Jev, from the positions as text (recorded)" : "Greedy rule, from the positions as text (code, free)"}</p>
          <Board state={a.state} label={`Facts lane, move ${a.state.tick}`} />
          <p className="ev-status">
            Move {a.state.tick} · food {a.state.score}
            {a.action ? ` · next: ${a.action}` : ""}
            {aOver ? ` · ${a.state.status === "lost" ? a.state.reason : "survived all 90 moves"}` : ""}
          </p>
          {jevTrace && a.ms ? <Receipt
              data={{
                mode: "recorded",
                ms: a.ms,
                questions: 1,
                servedBy: "typesafe-ai",
                raw: { request: recordedRequest(a.state), response: { answers: { action: { value: a.action } } }, note: "Recorded in the arcade's Snake runs, batched with the other games; the code asks for this move alone." },
              }}
              label="Jev"
            /> : null}
        </section>

        <section className={`ev-lane${bOver ? " is-over" : ""}`} aria-label="Lane B, looks at the screen">
          <h3>B · looks at the screen</h3>
          <p className="ev-fine">{run.label}, from a 320×320 screenshot (recorded)</p>
          <Board state={b.state} label={`Pixels lane, move ${b.state.tick}`} />
          <p className="ev-status" aria-live="polite">
            Move {b.state.tick} · food {b.state.score}
            {bOver ? ` · ${b.state.reason}` : b.frame ? ` · chose ${b.frame.chosen} (${b.frame.move})` : ""}
          </p>
          {b.frame && !bOver && (
            <>
              <Probabilities frame={b.frame} />
              <p className="ev-fine">
                {b.frame.move === b.frame.greedy ? "Same move as the greedy rule on the true state." : `The greedy rule, reading the facts, would go ${b.frame.greedy}.`}
              </p>
              <Receipt data={{ mode: "recorded", ms: b.frame.ms, questions: 1, costUsd: 0, at: run.recordedAt, servedBy: "MLX-VLM on an M4 Max", raw: { response: b.frame, note: "One prefill per move; the four answer letters' logits, softmaxed." } }} label="Vision model" />
            </>
          )}
        </section>
      </div>

      <section className="ev-cost" aria-labelledby="ev-cost-title">
        <h3 id="ev-cost-title">What seeing costs, over {data.seeds.length} games</h3>
        <div className="ev-table-wrap">
          <table className="ev-table">
            <thead>
              <tr>
                <th scope="col">Decider</th>
                <th scope="col">Reads</th>
                <th scope="col">Survived</th>
                <th scope="col">Median moves</th>
                <th scope="col">Food a game</th>
                <th scope="col">Per move</th>
                <th scope="col">Same move as greedy</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((l) => (
                <tr key={l.id}>
                  <th scope="row">{l.label}</th>
                  <td>{l.reads === "pixels" ? "screenshot" : "facts"}</td>
                  <td>
                    {l.survived} of {l.games.length}
                  </td>
                  <td>{l.medianMoves}</td>
                  <td>{l.meanFood.toFixed(1)}</td>
                  <td>{l.medianMs === null ? "under 1 ms" : ms(l.medianMs)}</td>
                  <td>{l.agreesWithGreedy === null ? "—" : pct(l.agreesWithGreedy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p && (
          <p className="ev-callout">
            It can see; it can't steer. Asked plain yes/no questions about the same kind of frames, {p.model.split("/").pop()} said correctly whether the food was above the head{" "}
            {p.above.right} of {p.above.asked} times ({pct(p.above.right / p.above.asked)}) and whether it was to the right {p.right.right} of {p.right.asked} times (
            {pct(p.right.right / p.right.asked)}). Turning that into a safe move is where it fails.
          </p>
        )}
        <p className="ev-fine">
          Method, prompts, caveats and data are under About & evidence.{" "}
          <a href="/eyes/eyes.json" download>
            Download the recordings ↓
          </a>
        </p>
      </section>

      <BrowserModelCheck steps={facts} />
    </div>
  );
}
