/**
 * PROTOTYPE: Eyes against state. Throwaway; lives on branch proto/eyes-vs-state only.
 *
 * The same Snake game, same seed, two lanes:
 *   A, facts: the decider reads the game state as text (the greedy rule, free; or recorded Jev).
 *   B, pixels: a camera stand-in reads the drawn board, then the same greedy rule decides on what
 *      it saw. Jev is text-only ("No image, audio, or video input"), so Jev never sees pixels.
 * A third slot is reserved for a recorded GPU run of a real vision-language model (SGLang); it is
 * not recorded yet. A button measures a real small VLM (SmolVLM-256M) in this browser, opt-in.
 *
 * Variants (?v= in the hash, e.g. #experiment/eyes?v=b): a side by side, b one board with a
 * facts/pixels toggle and ghosts, c a scrubbable replay that lists every misread.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { greedy, initial, step, type State } from "../../local-models-and-games/arcade/engine";
import { CAMERAS, perceive, seenState, trackOf, type Camera, type Perceived, type Track } from "./eyes-perceive.proto";
import "./eyes-vs-state.proto.css";

type Frame = { state: State; action: string | null; ms: number; seen?: Perceived; stale?: boolean };
type Lane = { frames: Frame[]; final: State };
type Decider = "greedy" | "jev";
type Clock = "waits" | "realtime";

const TICK_MS = 100;
const RECORDED_SEEDS = [7, 19, 42];

function factsLane(seed: number, decider: Decider, jevTrace: { action: string; latency_ms: number }[] | null): Lane {
  let s = initial("snake", seed);
  const frames: Frame[] = [];

  for (let i = 0; s.status === "playing" && i < 90; i++) {
    const t0 = performance.now();
    const rec = decider === "jev" ? jevTrace?.[i] : undefined;
    const action = rec ? rec.action : greedy(s);
    const ms = rec ? rec.latency_ms : performance.now() - t0;

    frames.push({ state: s, action, ms });
    s = step(s, action);
  }

  frames.push({ state: s, action: null, ms: 0 });

  return { frames, final: s };
}

/**
 * The pixel lane. In "waits" the game pauses for each decision. In "realtime" it moves every
 * 100 ms; a decision lands `lag` ticks after the frame it was made from, and until then the snake
 * keeps going straight.
 */
function pixelsLane(seed: number, cam: Camera, clock: Clock, whatIfMs: number): Lane {
  let s = initial("snake", seed);
  const frames: Frame[] = [];
  let track: Track | null = null;
  const pending: { due: number; action: string }[] = [];

  for (let i = 0; s.status === "playing" && i < 90; i++) {
    const seen = perceive(s, cam, track);

    track = trackOf(seen);

    const t0 = performance.now();
    const decided = greedy(seenState(s, seen));
    const ms = seen.ms + (performance.now() - t0) + (clock === "realtime" ? whatIfMs : 0);

    let action = decided;
    let stale = false;

    if (clock === "realtime") {
      const lag = Math.floor(ms / TICK_MS);

      pending.push({ due: i + lag, action: decided });

      const ready = pending.filter((p) => p.due <= i);

      if (ready.length) {
        action = ready[ready.length - 1].action;
        pending.splice(0, pending.indexOf(ready[ready.length - 1]) + 1);
        stale = lag > 0;
      } else {
        action = "straight";
        stale = true;
      }
    }

    frames.push({ state: s, action, ms, seen, stale });
    s = step(s, action);
  }

  frames.push({ state: s, action: null, ms: 0 });

  return { frames, final: s };
}

type Summary = { score: number; deaths: number; runs: number; misreadFrames: number; frames: number; ms: number; perSecond: number };

function summarize(lanes: Lane[], pixel: boolean): Summary {
  let score = 0;
  let deaths = 0;
  let misreadFrames = 0;
  let frames = 0;
  let ms = 0;

  for (const l of lanes) {
    score += l.final.score;
    deaths += Number(l.final.status === "lost");

    for (const f of l.frames) {
      if (!f.action) continue;

      frames++;
      ms += f.ms;

      if (pixel && f.seen?.misreads.length) misreadFrames++;
    }
  }

  const mean = ms / Math.max(1, frames);

  return { score: score / lanes.length, deaths, runs: lanes.length, misreadFrames, frames, ms: mean, perSecond: 1000 / Math.max(mean, TICK_MS) };
}

const fmtMs = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);

function Board({ frame, ghosts, label }: { frame: Frame; ghosts?: boolean; label: string }) {
  const s = frame.state;
  const cell = 26;

  return (
    <svg className="ev-board" viewBox={`0 0 ${cell * 10} ${cell * 10}`} role="img" aria-label={label}>
      <rect width={cell * 10} height={cell * 10} className="ev-floor" />
      {s.snake!.map((p, i) => (
        <rect key={i} x={p.x * cell + 2} y={p.y * cell + 2} width={cell - 4} height={cell - 4} rx={6} className={i === 0 ? "ev-head" : "ev-body"} />
      ))}
      <circle cx={(s.food!.x + 0.5) * cell} cy={(s.food!.y + 0.5) * cell} r={cell * 0.3} className="ev-food" />
      {ghosts &&
        frame.seen?.misreads.map((m, i) => (
          <rect key={`g${i}`} x={m.x * cell + 1} y={m.y * cell + 1} width={cell - 2} height={cell - 2} rx={6} className="ev-ghost">
            <title>{`Saw ${m.seen}, was ${m.truth}`}</title>
          </rect>
        ))}
    </svg>
  );
}

function CameraView({ seen }: { seen?: Perceived }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!seen || !ref.current) return;

    ref.current.width = seen.image.width;
    ref.current.height = seen.image.height;
    ref.current.getContext("2d")!.putImageData(seen.image, 0, 0);
  }, [seen]);

  return <canvas ref={ref} className="ev-camera" aria-label="What the camera delivered" />;
}

function useVariant() {
  const read = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("v") ?? "a";
  const [v, setV] = useState(read);

  useEffect(() => {
    const on = () => setV(read());

    window.addEventListener("hashchange", on);

    return () => window.removeEventListener("hashchange", on);
  }, []);

  const choose = (next: string) => {
    const [path] = location.hash.split("?");

    location.hash = `${path}?v=${next}`;
  };

  return [v, choose] as const;
}

/** Opt-in: time a real small vision-language model on a few frames, in this browser. */
function VlmProbe({ frames }: { frames: Frame[] }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<{ tick: number; answer: string; truth: string; ms: number }[]>([]);

  const run = async () => {
    setStatus("Loading SmolVLM-256M (about 250 MB, once)…");
    setRows([]);

    const worker = new Worker(new URL("./eyes-vlm.proto.worker.ts", import.meta.url), { type: "module" });
    const picks = frames.filter((f) => f.action).filter((_, i) => i % 6 === 0).slice(0, 6);
    const canvas = document.createElement("canvas");

    canvas.width = canvas.height = 260;

    const blobs: { tick: number; truth: string; blob: Blob }[] = [];

    for (const f of picks) {
      const c = canvas.getContext("2d")!;
      const { drawClean } = await import("./eyes-perceive.proto");

      drawClean(c, f.state, 26);
      blobs.push({ tick: f.state.tick, truth: greedy(f.state), blob: await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png")) });
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
    <div className="ev-probe">
      <button type="button" onClick={() => void run()}>
        Measure a real small vision model here <small>in your browser · free · 250 MB download</small>
      </button>
      {status && <p className="ev-fine">{status}</p>}
      {rows.length > 0 && (
        <table className="ev-table">
          <thead>
            <tr>
              <th>Move</th>
              <th>It said</th>
              <th>Greedy on the true state</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tick}>
                <td>{r.tick}</td>
                <td>{r.answer}</td>
                <td>{r.truth}</td>
                <td>{fmtMs(r.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EyesVsState() {
  const [variant, choose] = useVariant();
  const [seed, setSeed] = useState(7);
  const [camId, setCamId] = useState("phone");
  const [decider, setDecider] = useState<Decider>("greedy");
  const [clock, setClock] = useState<Clock>("waits");
  const [whatIf, setWhatIf] = useState(0);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [view, setView] = useState<"facts" | "pixels">("pixels");
  const [arcade, setArcade] = useState<any>(null);
  const cam = CAMERAS.find((c) => c.id === camId) ?? CAMERAS[1];

  useEffect(() => {
    fetch("/data/arcade.json")
      .then((r) => r.json())
      .then((d) => setArcade(d.result ?? d))
      .catch(() => setArcade({ episodes: [] }));
  }, []);

  const jevTrace = useMemo(() => {
    const e = arcade?.episodes?.find((x: any) => x.game === "snake" && x.policy === "jev" && x.seed === seed);

    return e ? e.trace : null;
  }, [arcade, seed]);

  const useJev = decider === "jev" && jevTrace && clock === "waits";
  const facts = useMemo(() => factsLane(seed, useJev ? "jev" : "greedy", jevTrace), [seed, useJev, jevTrace]);
  const pixels = useMemo(() => pixelsLane(seed, cam, clock, whatIf), [seed, cam, clock, whatIf]);

  // Twenty seeds of each lane, for the "what seeing costs" panel.
  const many = useMemo(() => {
    const seeds = Array.from({ length: 20 }, (_, i) => 101 + i);

    return {
      facts: summarize(seeds.map((s) => factsLane(s, "greedy", null)), false),
      pixels: summarize(seeds.map((s) => pixelsLane(s, cam, clock, whatIf)), true),
    };
  }, [cam, clock, whatIf]);

  const length = Math.max(facts.frames.length, pixels.frames.length);

  useEffect(() => setTick(0), [seed, camId, decider, clock, whatIf]);

  useEffect(() => {
    if (!playing) return;

    const id = setInterval(() => setTick((t) => (t + 1 >= length ? 0 : t + 1)), TICK_MS * 1.6);

    return () => clearInterval(id);
  }, [playing, length]);

  const fa = facts.frames[Math.min(tick, facts.frames.length - 1)];
  const px = pixels.frames[Math.min(tick, pixels.frames.length - 1)];
  const costMs = many.pixels.ms - many.facts.ms;

  const controls = (
    <div className="ev-controls">
      <label>
        Camera
        <select value={camId} onChange={(e) => setCamId(e.target.value)}>
          {CAMERAS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Seed
        <select value={seed} onChange={(e) => setSeed(Number(e.target.value))}>
          {[...RECORDED_SEEDS, 101, 102, 103].map((s) => (
            <option key={s} value={s}>
              {s}
              {RECORDED_SEEDS.includes(s) ? " (Jev recorded)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Facts lane
        <select value={decider} onChange={(e) => setDecider(e.target.value as Decider)}>
          <option value="greedy">Greedy rule · free</option>
          <option value="jev">Jev · recorded</option>
        </select>
      </label>
      <label>
        Clock
        <select value={clock} onChange={(e) => setClock(e.target.value as Clock)}>
          <option value="waits">The game waits for each move</option>
          <option value="realtime">Real time, 10 moves a second</option>
        </select>
      </label>
      {clock === "realtime" && (
        <label className="ev-whatif">
          What if seeing took {whatIf} ms more?
          <input type="range" min={0} max={400} step={10} value={whatIf} onChange={(e) => setWhatIf(Number(e.target.value))} />
        </label>
      )}
      <button type="button" onClick={() => setPlaying(!playing)}>
        {playing ? "Pause" : "Play"}
      </button>
    </div>
  );

  const notes = (
    <>
      {decider === "jev" && !useJev && (
        <p className="ev-fine">
          {clock === "realtime"
            ? "Recorded Jev moves only replay when the game waits: in real time the board drifts away from what was recorded."
            : "Jev was recorded on seeds 7, 19 and 42 only; this seed uses the greedy rule."}
        </p>
      )}
      <p className="ev-fine">
        Jev reads text only (TypeSafe: “No image, audio, or video input”), so the pixel lane can’t be Jev. Here a camera
        stand-in draws the board, degrades it ({cam.label.toLowerCase()}), and reads each cell back by colour; the same
        greedy rule then decides on what it saw. It is a pixel reader, not a vision-language model. A recorded GPU run of
        a real one (an SGLang vision model) slots in later.
      </p>
    </>
  );

  const cost = (
    <section className="ev-cost" aria-label="What seeing costs">
      <h3>What seeing costs</h3>
      <p className="ev-cost-line">
        <b>{costMs >= 0 ? "+" : ""}{fmtMs(Math.abs(costMs))}</b> per move · <b>{many.pixels.deaths - many.facts.deaths >= 0 ? "+" : ""}{many.pixels.deaths - many.facts.deaths}</b> deaths ·{" "}
        <b>{Math.round((100 * many.pixels.misreadFrames) / Math.max(1, many.pixels.frames))}%</b> of frames misread ·{" "}
        <b>{(many.pixels.score - many.facts.score).toFixed(1)}</b> food a game
      </p>
      <p className="ev-fine">
        Over 20 seeds (101–120), {cam.label.toLowerCase()}, {clock === "waits" ? "the game waiting for each move" : `real time${whatIf ? `, plus a what-if ${whatIf} ms` : ""}`}. Facts:{" "}
        {many.facts.deaths} of 20 died, {many.facts.score.toFixed(1)} food. Pixels: {many.pixels.deaths} of 20 died,{" "}
        {many.pixels.score.toFixed(1)} food. Times are measured in this browser for the stand-in; the what-if slider is
        not a measurement.
      </p>
    </section>
  );

  const gpuSlot = (
    <div className="ev-lane ev-lane-empty">
      <h3>Lane C · a vision-language model on a GPU</h3>
      <p>Recorded GPU run, not yet recorded.</p>
      <p className="ev-fine">
        Format: one JSON line per move with the frame hash, model, server, the answer’s probabilities and the time. OneJev
        is a candidate to evaluate, not to ship: its training labels aren’t documented.
      </p>
    </div>
  );

  const laneStats = (lane: Lane, f: Frame, pixel: boolean) => (
    <p className="ev-stat">
      Move {f.state.tick} · {f.action ?? lane.final.status} · {fmtMs(f.ms)}
      {pixel && f.seen?.misreads.length ? ` · ${f.seen.misreads.length} cells misread` : ""}
      {pixel && f.stale ? " · late, kept going straight" : ""} · score {f.state.score}
    </p>
  );

  return (
    <div className="toybox ev">
      <p className="ev-proto">Prototype · variant {variant.toUpperCase()}</p>
      {controls}

      {variant === "a" && (
        <>
          <div className="ev-lanes">
            <div className="ev-lane">
              <h3>Lane A · reads the facts</h3>
              <Board frame={fa} label="Facts lane board" />
              {laneStats(facts, fa, false)}
            </div>
            <div className="ev-lane">
              <h3>Lane B · looks at the screen</h3>
              <div className="ev-pair">
                <Board frame={px} ghosts label="Pixels lane board, misreads outlined in red" />
                <CameraView seen={px.seen} />
              </div>
              {laneStats(pixels, px, true)}
            </div>
            {gpuSlot}
          </div>
          {cost}
        </>
      )}

      {variant === "b" && (
        <>
          <div className="ev-single">
            <div className="ev-toggle" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "facts"} onClick={() => setView("facts")}>
                What the game knows
              </button>
              <button type="button" aria-pressed={view === "pixels"} onClick={() => setView("pixels")}>
                What the camera sees
              </button>
            </div>
            <Board frame={view === "facts" ? fa : px} ghosts={view === "pixels"} label="Board" />
            {view === "pixels" && <CameraView seen={px.seen} />}
            {view === "facts" ? laneStats(facts, fa, false) : laneStats(pixels, px, true)}
          </div>
          {cost}
        </>
      )}

      {variant === "c" && (
        <>
          <div className="ev-replay">
            <div className="ev-pair">
              <Board frame={px} ghosts label="Pixels lane at the scrubbed move" />
              <CameraView seen={px.seen} />
            </div>
            <input
              type="range"
              min={0}
              max={pixels.frames.length - 1}
              value={Math.min(tick, pixels.frames.length - 1)}
              onChange={(e) => {
                setPlaying(false);
                setTick(Number(e.target.value));
              }}
              aria-label="Scrub the replay"
            />
            {laneStats(pixels, px, true)}
          </div>
          <h3>Every misread in this run</h3>
          <ul className="ev-misreads">
            {pixels.frames
              .filter((f) => f.seen?.misreads.length)
              .map((f) => {
                const truth = greedy(f.state);

                return (
                  <li key={f.state.tick}>
                    <button
                      type="button"
                      onClick={() => {
                        setPlaying(false);
                        setTick(pixels.frames.indexOf(f));
                      }}
                    >
                      Move {f.state.tick}
                    </button>{" "}
                    {f.seen!.misreads.map((m) => `saw ${m.seen} at ${m.x},${m.y} (was ${m.truth})`).join("; ")}
                    {f.action !== truth ? ` → chose ${f.action}, facts would choose ${truth}` : " → same move anyway"}
                  </li>
                );
              })}
          </ul>
          {cost}
        </>
      )}

      {notes}
      <VlmProbe frames={pixels.frames} />

      <nav className="ev-bar" aria-label="Prototype variants">
        {[
          ["a", "Side by side"],
          ["b", "One board, toggle"],
          ["c", "Replay and misreads"],
        ].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={variant === id} onClick={() => choose(id)}>
            {id.toUpperCase()} · {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
