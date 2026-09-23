import { useEffect, useRef, useState } from "react";
import { cells, COLS, ROWS, ghost, type Game } from "../../../live-worlds/tetris/engine";
import { heuristic, randomPlayer, TetrisArena, timedReplay, type Contestant, type LogEntry } from "../../../packages/arena/src/tetris";
import { framedJev, perfectReader, recordedFraming, type FramingId } from "../../../packages/arena/src/tetris-framings";
import type { Card } from "../../../packages/arena/src/data/schema";
import { getApiKey, run } from "../api";
import { loadChunk } from "./data";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const describeLanding = (id: string) => { const xs = id.split("-").map((c) => +c.split("_")[0]); const lo = Math.min(...xs) + 1, hi = Math.max(...xs) + 1; return lo === hi ? `column ${lo}` : `columns ${lo}–${hi}`; };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export const LIVE_ID = "jev.live";

function Canvas({ game, target, color }: { game: Game; target?: string; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const css = getComputedStyle(canvas), size = canvas.width / COLS, ctx = canvas.getContext("2d")!;
    ctx.fillStyle = css.getPropertyValue("--arena-cell"); ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fill = (x: number, y: number, c: string) => { if (y < 0) return; ctx.fillStyle = c; ctx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2); };
    game.board.forEach((row, y) => row.forEach((v, x) => v && fill(x, y, css.getPropertyValue("--arena-stack"))));
    if (game.status === "playing") {
      ctx.strokeStyle = css.getPropertyValue("--arena-ghost"); ctx.lineWidth = 1.5;
      cells(ghost(game)).forEach(([x, y]) => y >= 0 && ctx.strokeRect(x * size + 2, y * size + 2, size - 4, size - 4));
      if (target) { ctx.strokeStyle = color; ctx.lineWidth = 2; target.split("-").forEach((cell) => { const [x, y] = cell.split("_").map(Number); ctx.strokeRect(x * size + 1.5, y * size + 1.5, size - 3, size - 3); }); }
      cells(game.active).forEach(([x, y]) => fill(x, y, color));
    }
  });
  return <canvas ref={ref} className="arena-board" width={COLS * 14} height={ROWS * 14} aria-label={`Board: ${game.lines} lines, ${game.pieces} pieces${game.status === "over" ? ", game over" : ""}`} />;
}

/** Builds a playable contestant for a card contestant id from its replay chunk, code, or a live key. */
async function contestantFor(card: Card, id: string, seed: string): Promise<Contestant> {
  const c = card.contestants.find((x) => x.id === id);
  const name = c?.name ?? "Jev · live";
  if (id === "code.planner") return { ...heuristic(0), name };
  if (id === "code.random") return { ...randomPlayer(1), name };
  if (id === "code.reader") return { ...perfectReader(), name };
  if (id === LIVE_ID) {
    const budget = card.id === "tetris-realtime" ? { deadlineMs: 4000, maxAttempts: 2 } : undefined;
    return { ...framedJev("spot-clean-confident", (body, signal) => run(body.state, body.questions, signal, budget)), name: "Jev · live (your key)" };
  }
  const path = card.chunks.replay?.[id]?.[seed];
  if (!path) return { id, name, source: "recorded", ask: () => ({ missing: "Not recorded on this seed" }) };
  const chunk = await loadChunk(path);
  if (chunk.schema === "arena.replay.timed/1") return timedReplay(chunk.events, name, id, chunk.retryPolicy);
  return { ...recordedFraming(chunk.exchanges, chunk.framing as FramingId), name };
}

export function BoardLens({ card, selected, colorOf, seed, onSeed }: { card: Card; selected: string[]; colorOf: (id: string) => string; seed: string; onSeed: (s: string) => void }) {
  const mode = card.id === "tetris-realtime" ? "realtime" : "turns";
  const [arena, setArena] = useState<TetrisArena | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(mode === "turns" ? 4 : 2);
  const [, setFrame] = useState(0);
  const ids = useRef<string[]>([]);
  const reset = async () => {
    setRunning(false);
    const list = await Promise.all(selected.map((id) => contestantFor(card, id, seed)));
    ids.current = selected;
    setArena(new TetrisArena(+seed, list, mode, { pieceLimit: 40 }));
  };
  useEffect(() => { reset(); }, [card.id, seed, selected.join(",")]);
  useEffect(() => {
    if (!running || !arena) return;
    let raf = 0, last = performance.now(), busy = false, cancelled = false;
    const loop = (now: number) => {
      if (arena.mode === "realtime") { arena.advance((now - last) * speed); last = now; }
      else if (!busy && now - last > 240 / speed) { busy = true; last = now; arena.turn().then(() => { busy = false; }); }
      if (arena.over) { arena.stop(); setRunning(false); }
      setFrame((f) => f + 1);
      if (!cancelled) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [running, speed, arena]);
  if (!arena) return <p className="arena-muted">Loading the recorded games…</p>;
  const last = (i: number): LogEntry | undefined => [...arena.log].reverse().find((e) => e.lane === i && e.status !== "pending");
  return (
    <div className="arena-board-lens">
      <div className="arena-controls" role="group" aria-label="Board controls">
        <button className="primary" onClick={() => setRunning((r) => !r)} disabled={arena.over}>{running ? "Pause" : arena.log.length ? "Resume" : "Play"}</button>
        {mode === "turns" && <button onClick={() => arena.turn().then(() => setFrame((f) => f + 1))} disabled={running || arena.over}>Next piece</button>}
        <button onClick={reset}>Restart</button>
        <label>Seed <select value={seed} onChange={(e) => onSeed(e.target.value)}>{card.items?.map((it) => <option key={it.id} value={it.id}>{it.id}</option>)}</select></label>
        <label>Speed <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>{[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}</select></label>
        <span className="arena-clock">{mode === "realtime" ? `${(arena.clockMs / 1000).toFixed(1)} s of game time` : `Piece ${Math.min(40, Math.max(0, ...arena.lanes.map((l) => l.game.pieces)) + 1)} of 40`}</span>
      </div>
      <div className="arena-lanes">
        {arena.lanes.map((lane, i) => {
          const e = last(i), color = colorOf(ids.current[i]), lat = median(lane.stats.latencyMs);
          const top = e?.probabilities ? Object.entries(e.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
          return (
            <article key={ids.current[i] ?? i} className="arena-lane" style={{ ["--lane" as any]: color }}>
              <header><span className="arena-dot" style={{ background: color }} /><h3>{lane.contestant.name}</h3><span className={`arena-source ${lane.contestant.source}`}>{lane.contestant.source}</span></header>
              <Canvas game={lane.game} target={lane.plan?.target} color={color} />
              <dl className="arena-stats">
                <div><dt>Lines</dt><dd>{lane.game.lines}</dd></div><div><dt>Pieces</dt><dd>{lane.game.pieces}</dd></div>
                <div><dt>Median answer</dt><dd>{lat == null ? "—" : `${Math.round(lat)} ms`}</dd></div><div><dt>Retried</dt><dd>{lane.stats.failed}</dd></div>
              </dl>
              <p className="arena-status">{lane.game.status === "over" ? "Topped out" : lane.recordingEnded !== null ? "Stopped where the recording ends" : arena.finished(lane) ? "Finished 40 pieces" : lane.pending ? "Waiting for an answer" : ""}</p>
              {top.length > 0 && <ol className="arena-top">{top.map(([id, p]) => <li key={id} className={id === e!.choice ? "chosen" : ""}><span style={{ width: `${Math.max(2, p * 100)}%`, background: id === e!.choice ? color : undefined }} /> <b>{pct(p)}</b> <code title={id}>{describeLanding(id)}</code></li>)}</ol>}
            </article>
          );
        })}
      </div>
      {!getApiKey() && <p className="arena-muted">Connect a key in Settings to add a live Jev lane.</p>}
    </div>
  );
}
