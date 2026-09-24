import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cells, COLS, ghost, ROWS, type Game } from "../../../live-worlds/tetris/engine";
import { replaySchema } from "../../../packages/arena/src/data/chunks";
import type { Card } from "../../../packages/arena/src/data/schema";
import {
  heuristic,
  randomPlayer,
  TetrisArena,
  timedReplay,
  type Contestant,
  type LogEntry,
} from "../../../packages/arena/src/tetris";
import {
  framedJev,
  perfectReader,
  recordedFraming,
} from "../../../packages/arena/src/tetris-framings";
import { run } from "../api";
import { loadChunk } from "./data";
import { Face, type Mood } from "./face";
import { colorVars, LIVE_ID, type CardModel } from "./model";

const PIECE_LIMIT = 40;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
};

const landingLabel = (id: string) => {
  const xs = id.split("-").map((c) => Number(c.split("_")[0]));

  const lo = Math.min(...xs) + 1,
    hi = Math.max(...xs) + 1;

  return lo === hi ? `column ${lo}` : `columns ${lo}–${hi}`;
};

function Board({ game, target }: { game: Game; target?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");

    if (!canvas || !ctx) return;

    const css = getComputedStyle(canvas),
      size = canvas.width / COLS;

    const color = (name: string) => css.getPropertyValue(name).trim();

    const fill = (x: number, y: number, c: string) => {
      if (y < 0) return;
      ctx.fillStyle = c;
      ctx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
    };

    ctx.fillStyle = color("--board-cell");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    game.board.forEach((row, y) => row.forEach((v, x) => v && fill(x, y, color("--board-stack"))));

    if (game.status !== "playing") return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color("--board-ghost");
    cells(ghost(game)).forEach(
      ([x, y]) => y >= 0 && ctx.strokeRect(x * size + 2, y * size + 2, size - 4, size - 4),
    );

    if (target) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = color("--c");

      for (const cell of target.split("-")) {
        const [x, y] = cell.split("_").map(Number);

        ctx.strokeRect(x * size + 1.5, y * size + 1.5, size - 3, size - 3);
      }
    }

    cells(game.active).forEach(([x, y]) => fill(x, y, color("--c")));
  });

  return (
    <canvas
      ref={ref}
      className="board"
      width={COLS * 14}
      height={ROWS * 14}
      aria-label={`${game.lines} lines, ${game.pieces} pieces${game.status === "over" ? ", topped out" : ""}`}
    />
  );
}

/** Builds a playable contestant from its replay chunk, code, or the visitor's key. */
async function playerFor(card: Card, id: string, seed: string, name: string): Promise<Contestant> {
  if (id === "code.planner") return { ...heuristic(0), name };

  if (id === "code.random") return { ...randomPlayer(1), name };

  if (id === "code.reader") return { ...perfectReader(), name };

  if (id === LIVE_ID) {
    const budget = card.id === "tetris-realtime" ? { deadlineMs: 4000, maxAttempts: 2 } : undefined;

    return {
      ...framedJev("spot-clean-confident", (body, signal) =>
        run(body.state, body.questions, signal, budget),
      ),
      name,
    };
  }

  const path = card.chunks.replay?.[id]?.[seed];

  if (!path)
    return { id, name, source: "recorded", ask: () => ({ missing: "Not recorded on this seed" }) };
  const chunk = await loadChunk(path, replaySchema);

  if (chunk.schema === "arena.replay.timed/1")
    return timedReplay(chunk.events, name, id, chunk.retryPolicy);

  return { ...recordedFraming(chunk.exchanges, chunk.framing), name };
}

/** Mood from how the lane is doing: happy when it leads on lines, puzzled when it topped out. */
function moodOf(arena: TetrisArena, i: number): Mood {
  const lane = arena.lanes[i];

  if (lane.game.status === "over") return "puzzled";
  const best = Math.max(...arena.lanes.map((l) => l.game.lines));

  return best > 0 && lane.game.lines === best ? "happy" : "calm";
}

export function Watch({ model: m }: { model: CardModel }) {
  const card = m.card;
  const mode = card.id === "tetris-realtime" ? "realtime" : "turns";
  const seed = m.view.seed ?? card.items?.[0]?.id ?? "7";
  const [game, setGame] = useState<{ arena: TetrisArena; ids: string[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [announcement, setAnnouncement] = useState("");
  const [generation, setGeneration] = useState(0);
  const [, setFrame] = useState(0);
  const lineup = m.ids.join(",");
  const arena = game?.arena ?? null;

  /** Builds the players for the current lineup; an effect event so it always sees the latest model. */
  const build = useEffectEvent(async () => {
    const ids = [...m.ids];
    const players = await Promise.all(ids.map((id) => playerFor(card, id, seed, m.nameOf(id))));

    return {
      arena: new TetrisArena(Number(seed), players, mode, { pieceLimit: PIECE_LIMIT }),
      ids,
    };
  });

  const finish = useEffectEvent((done: TetrisArena, ids: string[]) => {
    setRunning(false);
    setAnnouncement(
      `Finished. ${done.lanes.map((l, i) => `${m.nameOf(ids[i], true)} ${l.game.lines} lines${l.game.status === "over" ? `, topped out at piece ${l.game.pieces}` : ""}`).join("; ")}.`,
    );
  });

  useEffect(() => {
    let alive = true;

    void build().then((next) => {
      if (!alive) return;
      setRunning(false);
      setAnnouncement("");
      setGame(next);
    });

    return () => {
      alive = false;
    };
  }, [card.id, seed, lineup, generation]);

  useEffect(() => {
    if (!running || !game) return;
    const { arena, ids } = game;

    let raf = 0,
      last = performance.now(),
      busy = false,
      cancelled = false;

    const loop = (now: number) => {
      if (arena.mode === "realtime") {
        arena.advance((now - last) * speed);
        last = now;
      } else if (!busy && now - last > 240 / speed) {
        busy = true;
        last = now;
        void arena.turn().then(() => {
          busy = false;
        });
      }

      if (arena.over) {
        arena.stop();
        finish(arena, ids);
      }

      setFrame((f) => f + 1);

      if (!cancelled) raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [running, speed, game]);

  if (!game || !arena) return <p className="muted">Loading the recorded games…</p>;

  const lastEntry = (i: number): LogEntry | undefined => {
    for (let k = arena.log.length - 1; k >= 0; k--) {
      const e = arena.log[k];

      if (e.lane === i && e.status !== "pending") return e;
    }

    return undefined;
  };

  /** Lanes use short names unless two lanes share one, e.g. the same design from two protocols. */
  const shortNames = game.ids.map((id) => m.nameOf(id, true));
  const piece = Math.min(PIECE_LIMIT, Math.max(0, ...arena.lanes.map((l) => l.game.pieces)) + 1);

  return (
    <div className="watch">
      <div className="watch-controls" role="group" aria-label="Replay controls">
        <button
          type="button"
          className="primary"
          onClick={() => setRunning((r) => !r)}
          disabled={arena.over}
        >
          {arena.over ? "Finished" : running ? "Pause" : arena.log.length ? "Resume" : "Play"}
        </button>
        {mode === "turns" && (
          <button
            type="button"
            onClick={() => void arena.turn().then(() => setFrame((f) => f + 1))}
            disabled={running || arena.over}
          >
            Next piece
          </button>
        )}
        <button type="button" onClick={() => setGeneration((g) => g + 1)}>
          Restart
        </button>
        <label>
          Seed
          <select value={seed} onChange={(e) => m.set({ seed: e.target.value })}>
            {card.items?.map((it) => (
              <option key={it.id} value={it.id}>
                {it.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[1, 2, 4, 8].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="watch-clock">
          {mode === "realtime"
            ? `${(arena.clockMs / 1000).toFixed(1)} s of game time`
            : `Piece ${piece} of ${PIECE_LIMIT}`}
        </span>
      </div>
      <div className="lanes">
        {arena.lanes.map((lane, i) => {
          const id = game.ids[i];
          const c = m.contestant(id);
          const entry = lastEntry(i);
          const answer = median(lane.stats.latencyMs);

          const topChoices = entry?.probabilities
            ? Object.entries(entry.probabilities)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
            : [];

          const status =
            lane.game.status === "over"
              ? "Topped out"
              : lane.recordingEnded !== null
                ? "Recording ends here"
                : arena.finished(lane)
                  ? `Finished ${PIECE_LIMIT} pieces`
                  : lane.pending
                    ? "Thinking…"
                    : "";

          return (
            <article key={id ?? i} className="lane" style={colorVars(c)} data-kind={c?.kind}>
              <header>
                <Face kind={c?.kind ?? "hosted"} mood={moodOf(arena, i)} />
                <h4 title={lane.contestant.name}>
                  {shortNames.filter((n) => n === shortNames[i]).length > 1
                    ? lane.contestant.name
                    : shortNames[i]}
                </h4>
              </header>
              <Board game={lane.game} target={lane.plan?.target} />
              <dl className="lane-stats">
                <div>
                  <dt>Lines</dt>
                  <dd>{lane.game.lines}</dd>
                </div>
                <div>
                  <dt>Pieces</dt>
                  <dd>{lane.game.pieces}</dd>
                </div>
                {c?.kind !== "code" && (
                  <div className="wide">
                    <dt>Answer</dt>
                    <dd>{answer === null ? "—" : `${Math.round(answer)} ms`}</dd>
                  </div>
                )}
                {c?.kind !== "code" && lane.stats.failed > 0 && (
                  <div className="wide">
                    <dt>Retried</dt>
                    <dd>{lane.stats.failed}</dd>
                  </div>
                )}
              </dl>
              <p className="lane-status">{status}</p>
              {topChoices.length > 0 && (
                <ol className="choices" aria-label="Top choices for the last piece">
                  {topChoices.map(([landing, p]) => (
                    <li key={landing} data-chosen={landing === entry?.choice}>
                      <span className="choice-bar" style={{ width: `${Math.max(2, p * 100)}%` }} />
                      <b>{Math.round(p * 100)}%</b> {landingLabel(landing)}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          );
        })}
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}
