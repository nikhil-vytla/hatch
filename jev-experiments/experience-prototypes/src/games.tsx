import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  KeyRound,
  DoorClosed,
  Flag,
  ArrowUp,
} from "lucide-react";
import { Pane, Field, Button, Pills, Stat, State } from "./shared";
export function GameGrid({
  state,
  small = false,
}: {
  state: any;
  small?: boolean;
}) {
  const grid =
    state?.visible_grid ??
    Array.from({ length: 7 }, () => Array(7).fill("unseen"));
  return (
    <div className={"game-grid " + (small ? "small" : "")}>
      {grid.flatMap((row: string[], y: number) =>
        row.map((cell, x) => (
          <motion.div
            animate={{ opacity: cell === "unseen" ? 0.25 : 1 }}
            transition={{ duration: 0.17 }}
            key={`${x},${y}`}
            className={
              "game-cell " +
              (cell.includes("wall")
                ? "wall"
                : cell.includes("goal")
                  ? "goal"
                  : cell.includes("door")
                    ? "door"
                    : cell.includes("key")
                      ? "key"
                      : "floor")
            }
          >
            {y === 6 && x === 3 ? (
              <motion.span
                className="agent"
                animate={{ scale: [1, 1.09, 1] }}
                transition={{ duration: 0.8, repeat: Infinity }}
              >
                <ArrowUp size={small ? 12 : 23} />
              </motion.span>
            ) : cell.includes("key") ? (
              <KeyRound />
            ) : cell.includes("door") ? (
              <DoorClosed />
            ) : cell.includes("goal") ? (
              <Flag />
            ) : null}
          </motion.div>
        )),
      )}
    </div>
  );
}
export function Games({ result }: { result: any }) {
  const interrupted = (result.episodes ?? []).filter((e: any) => e.errors > 0);
  const episodes = (result.episodes ?? []).filter((e: any) => !e.errors),
    [policy, setPolicy] = useState("jev_memory"),
    [env, setEnv] = useState("MiniGrid-DoorKey-5x5-v0"),
    [seed, setSeed] = useState(1),
    [step, setStep] = useState(0),
    [playing, setPlaying] = useState(
      !matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [speed, setSpeed] = useState(350);
  const policies = [...new Set<string>(episodes.map((e: any) => e.policy))];
  const episode =
    episodes.find(
      (e: any) => e.policy === policy && e.env === env && e.seed === seed,
    ) ??
    episodes.find((e: any) => e.policy === policy && e.env === env) ??
    episodes[0];
  const trace = episode?.trace ?? [],
    entry = trace[step],
    state = entry?.observation ?? result.observations?.[entry?.state_id];
  useEffect(() => {
    setStep(0);
  }, [policy, env, seed]);
  useEffect(() => {
    if (!playing || !trace.length) return;
    const timer = setInterval(
      () =>
        setStep((s) => {
          if (s >= trace.length - 1) {
            setPlaying(false);
            return s;
          }
          return s + 1;
        }),
      speed,
    );
    return () => clearInterval(timer);
  }, [playing, trace, speed]);
  if (!episode)
    return (
      <Pane title="Navigation replays">No recorded episode is available.</Pane>
    );
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="game-stage">
          <div className="game-mission">
            <span>MISSION / DOOR & KEY</span>
            <h2>{state?.mission ?? "Find the way to the goal"}</h2>
          </div>
          <GameGrid state={state} />
          <div className="game-caption">
            <span className="badge">Agent’s actual field of view</span>
            <span>
              {state?.carrying ? "Carrying " + state.carrying : "Empty hands"}
            </span>
          </div>
          <div className="playback">
            <Button
              secondary
              onClick={() => {
                setStep(0);
                setPlaying(false);
              }}
              aria-label="Restart"
            >
              <SkipBack size={16} />
            </Button>
            <Button
              onClick={() => {
                if (step === trace.length - 1) setStep(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
              {playing ? "Pause" : "Play episode"}
            </Button>
            <input
              aria-label="Episode step"
              type="range"
              min="0"
              max={Math.max(0, trace.length - 1)}
              value={step}
              onChange={(e) => {
                setStep(Number(e.target.value));
                setPlaying(false);
              }}
            />
            <span>
              {step + 1} / {trace.length}
            </span>
          </div>
        </div>
        <div className="stats-row">
          <Stat
            label="Current action"
            value={(entry?.action ?? "").replaceAll("_", " ")}
          />
          <Stat
            label="Recorded outcome"
            value={episode.success ? "Goal reached" : "Goal not reached"}
          />
          <Stat label="Episode length" value={`${episode.steps} steps`} />
        </div>
      </div>
      <aside className="controls">
        <Pane title="Watch the decisions unfold">
          <p>
            The agent sees a small view in front of it. The grid rotates with
            its point of view; the arrow stays at the bottom. These are recorded
            actions from an actual MiniGrid run.
          </p>
          <Field label="Policy">
            <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              {policies.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="World">
            <select value={env} onChange={(e) => setEnv(e.target.value)}>
              {[...new Set<string>(episodes.map((e: any) => e.env))].map(
                (p) => (
                  <option key={p}>{p}</option>
                ),
              )}
            </select>
          </Field>
          <Field label="Episode seed">
            <select
              value={episode.seed}
              onChange={(e) => setSeed(Number(e.target.value))}
            >
              {episodes
                .filter((e: any) => e.policy === policy && e.env === env)
                .map((e: any) => (
                  <option key={e.seed} value={e.seed}>
                    {e.seed}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Playback speed">
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value={750}>Slow</option>
              <option value={350}>Normal</option>
              <option value={120}>Fast</option>
            </select>
          </Field>
          <div className="action-log">
            {trace
              .slice(Math.max(0, step - 4), step + 1)
              .map((s: any, i: number) => (
                <div key={i}>
                  <span>{s.step + 1}</span>
                  <strong>{s.action.replaceAll("_", " ")}</strong>
                  <small>
                    {s.cache_hit
                      ? "cached decision"
                      : s.latency_ms
                        ? Math.round(s.latency_ms) + " ms"
                        : "baseline"}
                  </small>
                </div>
              ))}
          </div>
          <p className="fine">
            {episodes.length} completed episodes, including unsuccessful
            attempts. {interrupted.length} interrupted episode is excluded from
            playback and retained in the downloadable evidence.
          </p>
          <State
            title="Inspect the agent’s observation"
            value={{
              observation: state,
              action: entry,
              episode: {
                policy: episode.policy,
                seed: episode.seed,
                success: episode.success,
              },
            }}
          />
        </Pane>
      </aside>
    </div>
  );
}
