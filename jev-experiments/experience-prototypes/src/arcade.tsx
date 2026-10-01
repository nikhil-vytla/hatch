import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Play,
  Pause,
  RotateCcw,
  ChevronRight,
  Gamepad2,
  Radio,
} from "lucide-react";
import { Pane, Button, Stat, Fold, State as StateView, Notice } from "./shared";

const OrbitalScene = lazy(() => import("./orbital-scene"));
import { run, getApiKey } from "./api";
import {
  initial,
  step as advance,
  observe,
  options,
  question,
  type State,
  type Game,
} from "../../local-models-and-games/arcade/engine";

function SnakeBoard({ state }: { state: State }) {
  const reduced = useReducedMotion();
  const points = state
    .snake!.map((p) => `${p.x * 36 + 38},${p.y * 36 + 38}`)
    .join(" ");
  const head = state.snake![0];
  return (
    <svg
      className="snake-board"
      viewBox="0 0 400 400"
      role="img"
      aria-label={`Snake board. ${state.score} food collected. Head at ${head.x}, ${head.y}.`}
    >
      <defs>
        <pattern
          id="snake-grid"
          width="36"
          height="36"
          patternUnits="userSpaceOnUse"
          x="20"
          y="20"
        >
          <rect
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeOpacity=".08"
          />
        </pattern>
      </defs>
      <rect
        x="20"
        y="20"
        width="360"
        height="360"
        rx="10"
        fill="url(#snake-grid)"
        stroke="currentColor"
        strokeOpacity=".14"
      />
      <motion.circle
        initial={false}
        cx={state.food!.x * 36 + 38}
        cy={state.food!.y * 36 + 38}
        r={8}
        fill="#ef987d"
        animate={reduced ? {} : { r: [7, 10, 7] }}
        transition={{ duration: 1.4, repeat: Infinity }}
      />
      <polyline
        points={points}
        fill="none"
        stroke="#9bca9e"
        strokeWidth="24"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity=".82"
      />
      <motion.circle
        initial={false}
        cx={head.x * 36 + 38}
        cy={head.y * 36 + 38}
        animate={{ cx: head.x * 36 + 38, cy: head.y * 36 + 38 }}
        transition={{ duration: reduced ? 0 : 0.16 }}
        r={13}
        fill="#d6edc8"
      />
      <circle
        cx={head.x * 36 + 38}
        cy={head.y * 36 + 38}
        r="3"
        fill="#173125"
      />
    </svg>
  );
}
export function Arcade({ game, result }: { game: Game; result: any }) {
  const episodes = (result.episodes ?? []).filter(
      (e: any) => e.game === game && e.completed,
    ),
    [seed, setSeed] = useState(7),
    [policy, setPolicy] = useState("jev"),
    [mode, setMode] = useState("replay"),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(350),
    [local, setLocal] = useState<State>(() => initial(game, 7)),
    [liveRows, setLiveRows] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null),
    epoch = useRef(0),
    latest = useRef(local);
  latest.current = local;
  const episode =
    episodes.find((e: any) => e.seed === seed && e.policy === policy) ??
    episodes[0];
  const trace = mode === "replay" ? (episode?.trace ?? []) : liveRows;
  const entry = trace[index];
  const state: State =
    mode === "replay"
      ? (entry?.state ?? episode?.state ?? initial(game, seed))
      : local;
  function reset(nextMode = mode, nextSeed = seed) {
    abort.current?.abort();
    epoch.current++;
    setBusy(false);
    setMode(nextMode);
    setPlaying(false);
    setIndex(0);
    setLocal(initial(game, nextSeed));
    setLiveRows([]);
    setError("");
  }
  useEffect(
    () => {
      setBusy(false);
      setPlaying(false);
      return () => {
        epoch.current++;
        abort.current?.abort();
        abort.current = null;
        setBusy(false);
        setPlaying(false);
      };
    },
    [],
  );
  useEffect(() => {
    if (!playing || mode !== "replay") return;
    const t = setInterval(
      () =>
        setIndex((i) => {
          if (i >= trace.length) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      speed,
    );
    return () => clearInterval(t);
  }, [playing, mode, trace.length, speed]);
  function manual(action: string) {
    if (local.status !== "playing") return;
    const next = advance(local, action);
    setLiveRows((r) => [...r, { state: local, action, source: "you" }]);
    setLocal(next);
    setIndex(liveRows.length);
  }
  async function tick() {
    if (busy || latest.current.status !== "playing") return;
    if (!getApiKey()) {
      setError(
        "Use Connect live in the header to provide your Vercel AI Gateway key.",
      );
      setPlaying(false);
      return;
    }
    const generation = ++epoch.current;
    const current = latest.current;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    try {
      const r = await run(
        { policy: "Play the game described in the independent question." },
        { action: question(current) },
        controller.signal,
      );
      if (generation !== epoch.current || controller.signal.aborted) return;
      const a = r.answers.action;
      setLiveRows((rows) => {
        setIndex(rows.length);
        return [
          ...rows,
          {
            state: current,
            action: a.value,
            probabilities: a.probabilities,
            source: "typesafe-ai/jev",
            latency_ms: r.latency_ms,
          },
        ];
      });
      setLocal(advance(current, a.value));
    } catch (e) {
      if (generation === epoch.current && !controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        setPlaying(false);
      }
    } finally {
      if (generation === epoch.current) {
        setBusy(false);
        abort.current = null;
      }
    }
  }
  useEffect(() => {
    if (mode === "live" && playing && !busy && local.status === "playing") {
      const t = setTimeout(tick, 200);
      return () => clearTimeout(t);
    }
  }, [mode, playing, busy, local]);
  const action = mode === "replay" ? (entry ?? trace.at(-1)) : liveRows.at(-1);
  const probabilities = Object.entries(action?.probabilities ?? {}).sort(
    (a: any, b: any) => b[1] - a[1],
  );
  return (
    <div className="arcade-workspace">
      <div className="arcade-toolbar">
        <div className="arcade-modes">
          {[
            ["replay", "Watch Jev"],
            ["live", "Run live"],
            ["manual", "Play yourself"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => reset(id)}
            >
              {id === "manual" ? (
                <Gamepad2 size={15} />
              ) : id === "live" ? (
                <Radio size={15} />
              ) : (
                <Play size={15} />
              )}{" "}
              {label}
            </button>
          ))}
        </div>
        <label>
          Seed{" "}
          <select
            aria-label="Game seed"
            value={seed}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSeed(n);
              reset(mode, n);
            }}
          >
            {[7, 19, 42].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="arcade-layout">
        <div>
          <div
            className="arcade-stage"
            tabIndex={mode === "manual" ? 0 : undefined}
            role="group"
            aria-label="Game arena"
            onKeyDown={(e) => {
              if (mode !== "manual") return;
              const keys: Record<string, string> =
                game === "snake"
                  ? {
                      ArrowLeft: "left",
                      ArrowRight: "right",
                      ArrowUp: "straight",
                    }
                  : {
                      ArrowLeft: "west",
                      ArrowRight: "east",
                      ArrowUp: "north",
                      ArrowDown: "south",
                      w: "up",
                      s: "down",
                    };
              if (keys[e.key]) {
                e.preventDefault();
                e.stopPropagation();
                manual(keys[e.key]);
              }
            }}
          >
            <div className="arcade-hud">
              <div>
                <small>
                  {game === "snake" ? "Snake · survival" : "Orbital · rescue"}
                </small>
                <strong>
                  {game === "snake"
                    ? `${state.score} food`
                    : `${state.score} / 3 cores`}
                </strong>
              </div>
              <div>
                <small>
                  {mode === "replay"
                    ? "Recorded run"
                    : mode === "live"
                      ? "Live Jev"
                      : "Your controls"}
                </small>
                <strong>{busy ? "Choosing…" : `Move ${state.tick}`}</strong>
              </div>
            </div>
            {game === "snake" ? (
              <SnakeBoard state={state} />
            ) : (
              <Suspense fallback={<div className="orbital-canvas">Loading the 3D arena…</div>}>
                <OrbitalScene state={state} />
              </Suspense>
            )}
            <div className="arcade-status">
              {state.status === "playing"
                ? game === "snake"
                  ? "Keep an escape route open."
                  : `Collect the green cores. Return to the beacon. Hull ${state.health}/3.`
                : state.reason}
            </div>
          </div>
          <div className="arcade-playback">
            <Button secondary onClick={() => reset()} aria-label="Restart game">
              <RotateCcw size={16} />
            </Button>
            {mode !== "manual" && (
              <Button
                onClick={() => {
                  if (mode === "replay" && index >= trace.length) setIndex(0);
                  setPlaying(!playing);
                }}
                disabled={mode === "live" && local.status !== "playing"}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
                {playing
                  ? "Pause"
                  : mode === "replay"
                    ? "Play replay"
                    : "Start Jev"}
              </Button>
            )}
            {mode === "replay" ? (
              <>
                <input
                  aria-label="Game replay position"
                  type="range"
                  min="0"
                  max={trace.length}
                  value={index}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                />
                <Button
                  secondary
                  aria-label="Next game move"
                  onClick={() => {
                    setPlaying(false);
                    setIndex((i) => Math.min(trace.length, i + 1));
                  }}
                >
                  <ChevronRight size={16} />
                </Button>
              </>
            ) : mode === "live" ? (
              <Button
                secondary
                disabled={busy || local.status !== "playing"}
                onClick={tick}
              >
                One move
              </Button>
            ) : null}
          </div>
          {mode === "manual" && (
            <div className="manual-controls">
              {Object.keys(options(local)).map((a) => (
                <Button
                  key={a}
                  secondary
                  disabled={local.status !== "playing"}
                  onClick={() => manual(a)}
                >
                  {a}
                </Button>
              ))}
            </div>
          )}
          {mode === "manual" && (
            <p className="fine">
              Focus the arena to use{" "}
              {game === "snake"
                ? "← / → to turn and ↑ to continue straight."
                : "arrow keys to move horizontally, W to rise, and S to descend."}
            </p>
          )}
          {error && <Notice error>{error}</Notice>}
          <div className="arcade-score-strip">
            <Stat label="Food or cores" value={String(state.score)} />
            <Stat label="Current decision" value={action?.action ?? "Ready"} />
            <Stat
              label="Request time"
              value={
                action?.latency_ms
                  ? `${Math.round(action.latency_ms)} ms`
                  : "No API call"
              }
            />
          </div>
        </div>
        <aside className="arcade-explanation">
          <Pane title="Inside the decision">
            <p>
              Game rules supply the immediate consequences of each move. Jev
              chooses one action. There is no hidden route planner.
            </p>
            <div className="action-probabilities">
              {probabilities.length ? (
                probabilities.map(([a, p]) => (
                  <div key={a}>
                    <span>{a}</span>
                    <div>
                      <motion.i animate={{ width: `${Number(p) * 100}%` }} />
                    </div>
                    <strong>{(Number(p) * 100).toFixed(1)}%</strong>
                  </div>
                ))
              ) : (
                <p className="fine">
                  {mode === "manual"
                    ? "You are choosing the moves; no model is being called."
                    : "Advance one move to inspect the action distribution."}
                </p>
              )}
            </div>
            <StateView
              title="What the model sees"
              value={observe(action?.state ?? state)}
            />
          </Pane>
          {mode === "replay" && (
            <Pane title="Same world, two controllers">
              <label>
                Controller
                <select
                  aria-label="Recorded game controller"
                  value={policy}
                  onChange={(e) => {
                    setPolicy(e.target.value);
                    setIndex(0);
                    setPlaying(false);
                  }}
                >
                  <option value="jev">Jev</option>
                  <option value="greedy">Greedy code baseline</option>
                </select>
              </label>
              <label>
                Playback speed
                <select
                  aria-label="Game playback speed"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value={700}>Slow</option>
                  <option value={350}>Normal</option>
                  <option value={120}>Fast</option>
                </select>
              </label>
              <p className="fine">
                Both controllers start from the same seeded world. Playback uses
                a fixed game clock. Request time is shown separately.
              </p>
              <div className="episode-results">
                {episodes.map((e: any) => (
                  <div key={e.id}>
                    <span>
                      {e.policy === "jev" ? "Jev" : "Greedy"} · seed {e.seed}
                    </span>
                    <strong>
                      {e.state.score}
                      {game === "snake"
                        ? ` food · ${e.state.status === "timeout" ? "90 turns" : e.state.status}`
                        : ` cores · ${e.state.status}`}
                    </strong>
                  </div>
                ))}
              </div>
            </Pane>
          )}
          <p className="fine">
            An original{" "}
            {game === "snake" ? "Snake environment" : "Three.js game"}, inspired
            by{" "}
            <a href="https://typesafe.ai/blog/introducing-system-one-models-and-jev">
              TypeSafe’s structured-state Doom demo
            </a>
            . These short seeded runs are demonstrations, not a general
            game-playing benchmark.
          </p>
        </aside>
      </div>
    </div>
  );
}
