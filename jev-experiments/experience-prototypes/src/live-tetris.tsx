import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { download, EvaluationError, getApiKey, run } from "./api";
import { boardFeatures, cells, ghost, PIECES, type Command, type Game, type Piece } from "../../live-worlds/tetris/engine";
import { DECISION_INSTRUCTIONS as instructions, TetrisSession, type DecisionEvent, type Lane, type Settings, type Ticket } from "../../live-worlds/tetris/session";
import "./live-tetris.css";

const COLORS = ["transparent", "#86cfe3", "#e4c87c", "#c3a9de", "#a9cba5", "#e9a090", "#8faedb", "#edbc88"];
const pct = (value: number, total: number) => `${total ? Math.round(value * 100 / total) : 0}%`;
function MiniPiece({ type, label }: { type: Piece | null; label: string }) {
  return <svg className="lt-mini" viewBox="0 0 90 55" role="img" aria-label={`${label}: ${type ?? "empty"}`}>
    {type && cells({ type, rotation: 0, x: 0, y: 0 }).map(([x, y]) => <rect key={`${x}/${y}`} x={x * 18 + 8} y={y * 18 + 7} width="16" height="16" rx="3" fill={COLORS[PIECES.indexOf(type) + 1]} />)}
  </svg>;
}
function Board({ game, label }: { game: Game; label: string }) {
  const landing = ghost(game), filled = game.board.flat().filter(Boolean).length;
  return <svg className="lt-board" viewBox="0 0 240 464" role="img" aria-label={`${label}. ${filled} occupied cells, ${game.lines} lines, ${game.score} points. Active ${game.active.type} at column ${game.active.x + 1}, row ${game.active.y + 1}. ${game.status === "over" ? "Game over." : "Outlined cells show the hard-drop landing."}`}>
    <rect width="240" height="464" rx="13" fill="#11222b" />
    {game.board.flatMap((row, y) => row.map((cell, x) => <rect key={`${x}/${y}`} x={x * 22 + 10} y={y * 22 + 10} width="20" height="20" rx="3" fill={cell ? COLORS[cell] : "#1c3039"} />))}
    {game.status === "playing" && <>
      {cells(landing).filter(([, y]) => y >= 0).map(([x, y]) => <rect key={`g${x}/${y}`} x={x * 22 + 10} y={y * 22 + 10} width="20" height="20" rx="3" stroke={COLORS[PIECES.indexOf(game.active.type) + 1]} fill="none" strokeWidth="1.5" opacity=".65" />)}
      {cells(game.active).filter(([, y]) => y >= 0).map(([x, y]) => <rect key={`a${x}/${y}`} x={x * 22 + 10} y={y * 22 + 10} width="20" height="20" rx="3" fill={COLORS[PIECES.indexOf(game.active.type) + 1]} stroke="#ffffff55" strokeWidth="1" />)}
    </>}
    {game.status === "over" && <g><rect x="10" y="165" width="220" height="115" rx="8" fill="#11222bf2" /><text x="120" y="212" textAnchor="middle" fill="#e9ecde" fontSize="23">Topped out</text><text x="120" y="244" textAnchor="middle" fill="#b8c5bc" fontSize="12">Restart both or rewind</text></g>}
  </svg>;
}
export function LiveTetris({ active = true }: { result?: unknown; active?: boolean } = {}) {
  const sessionRef = useRef<TetrisSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new TetrisSession(19);
  const session = sessionRef.current;
  const [, setVersion] = useState(0), [focus, setFocus] = useState(0);
  const arena = useRef<(HTMLElement | null)[]>([]);
  const liveRequests = useRef(new Map<string, { abort: AbortController; timer?: ReturnType<typeof setTimeout> }>());
  const refresh = () => setVersion(n => n + 1);
  function mutate(fn: () => void) { fn(); refresh(); }
  useEffect(() => {
    if (!active) { session.pause(); refresh(); return; }
    let disposed = false, last = performance.now(), lastPaint = 0, raf = 0;
    const launch = (ticket: Ticket) => {
      const abort = new AbortController(), started = performance.now();
      const entry: { abort: AbortController; timer?: ReturnType<typeof setTimeout> } = { abort };
      liveRequests.current.set(ticket.id, entry);
      const finish = (answer?: string, error?: string, response?: unknown, httpStatus?: number) => {
        if (disposed || abort.signal.aborted) return;
        session.receive(ticket, answer, performance.now() - started, error, response, httpStatus); liveRequests.current.delete(ticket.id);
      };
      if (ticket.settings.source === "local") entry.timer = setTimeout(() => finish(ticket.suggested, undefined, { source: "local-timing-demo", modelCalled: false, artificialDelayMs: ticket.settings.delayMs, choice: ticket.suggested }), ticket.settings.delayMs);
      else void run(ticket.request.state, ticket.request.questions, abort.signal)
        .then(response => finish(response.answers?.decision?.value, undefined, response, 200))
        .catch(error => { if (!abort.signal.aborted) finish(undefined, error instanceof Error ? error.message : String(error), error instanceof EvaluationError ? error.response : undefined, error instanceof EvaluationError ? error.status : undefined); });
    };
    const loop = (now: number) => {
      const elapsed = now - last; last = now;
      session.advance(elapsed);
      for (const [id, pending] of liveRequests.current) {
        if (!session.pair.lanes.some(l => l.pending === id)) { pending.abort.abort(); clearTimeout(pending.timer); liveRequests.current.delete(id); }
      }
      session.requests(Boolean(getApiKey())).forEach(launch);
      if (now - lastPaint >= 50) { lastPaint = now; refresh(); }
      raf = requestAnimationFrame(loop);
    };
    const hide = () => { if (document.hidden) { session.pause(); last = performance.now(); refresh(); } };
    document.addEventListener("visibilitychange", hide); raf = requestAnimationFrame(loop);
    return () => { disposed = true; cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", hide); session.pause(); for (const request of liveRequests.current.values()) { request.abort.abort(); clearTimeout(request.timer); } liveRequests.current.clear(); };
  }, [session, active]);
  const shown = session.shown, replay = session.cursor >= 0, seed = shown.seed;
  const update = (i: number, settings: Partial<Settings>) => mutate(() => session.configure(i, settings));
  const input = (i: number, action: Command) => mutate(() => session.input(i, action));
  function take(i: number) { mutate(() => session.takeover(i)); setFocus(i); arena.current[i]?.focus(); }
  const allOver = session.pair.lanes.every(l => l.game.status === "over");
  return <div className="lt-root">
    <header className="lt-intro"><span className="eyebrow">A world that keeps moving</span><h2>Gravity won't wait.</h2><p>Play a complete game, or let two controllers share the same starting point. The blocks keep falling while decisions arrive.</p></header>
    <div className="lt-toolbar">
      <button className="lt-primary" disabled={replay || allOver} onClick={() => mutate(() => session.running ? session.pause() : session.play())}>{session.running ? <Pause size={16} /> : <Play size={16} />}{session.running ? "Pause both" : "Start both"}</button>
      <button onClick={() => mutate(() => session.restart(seed))}><RotateCcw size={16} /> Restart both</button>
      <button title="Preserve this run; compare board A with local code, 1200ms artificial replies and a 700ms fallback wait." onClick={() => mutate(() => session.slowReplyDemo())}>Local slow-reply demo <span className="lt-preset-delay">1200ms artificial delay</span></button>
      <label>Piece sequence<select value={seed} onChange={e => mutate(() => session.restart(Number(e.target.value)))}>{[7, 19, 42, 73, 101].map(s => <option key={s} value={s}>Seed {s}</option>)}</select></label>
      <span className="lt-clock"><b>{(shown.clockMs / 1000).toFixed(1)}s</b> {replay ? "shared checkpoint" : session.running ? "shared world clock" : "world paused"}</span>
    </div>
    <div className="lt-pair">
      {shown.lanes.map((lane, i) => <section key={i} ref={el => { arena.current[i] = el; }} className={`lt-lane ${focus === i && lane.human ? "lt-focused" : ""}`} tabIndex={0} aria-label={`Lane ${i === 0 ? "A" : "B"} game controls`} onFocus={() => setFocus(i)} onKeyDown={e => {
        if (e.target !== e.currentTarget || !lane.human) return;
        const keys: Record<string, Command> = { ArrowLeft: "left", ArrowRight: "right", ArrowDown: "soft", ArrowUp: "cw", z: "ccw", x: "cw", c: "hold", " ": "drop" };
        const key = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
        if (key) { e.preventDefault(); if (!e.repeat || ["left", "right", "soft"].includes(key)) input(i, key); }
      }}>
        <div className="lt-lane-title"><h3><span>{i === 0 ? "A" : "B"}</span> {lane.settings.assisted ? "Assisted" : "Unassisted"}</h3><span className="lt-source">{lane.settings.source === "jev" ? "Jev · your key" : "Local timing demo"}</span></div>
        <div className="lt-settings">
          <label>Decision source<select disabled={replay} aria-label={`Lane ${i + 1} decision source`} value={lane.settings.source} onChange={e => update(i, { source: e.target.value as Settings["source"] })}><option value="local">Code + artificial delay</option><option value="jev">Live Jev · your key</option></select></label>
          <label>What it chooses<select disabled={replay} aria-label={`Lane ${i + 1} framing`} value={lane.settings.framing} onChange={e => update(i, { framing: e.target.value as Settings["framing"] })}><option value="landing">A reachable landing</option><option value="button">Short button actions</option><option value="intent">A code planner's intent</option></select></label>
          <label className="lt-check"><input type="checkbox" disabled={replay} checked={lane.settings.assisted} onChange={e => update(i, { assisted: e.target.checked })} /> Local fallback when needed</label>
          <div className="lt-wait-slot">{lane.settings.assisted ? <label className="lt-fallback-wait">Wait before choosing fallback <output>{lane.settings.fallbackWaitMs}ms</output><input aria-label={`Lane ${i + 1} wait before choosing fallback`} type="range" min="0" max="2400" step="100" disabled={replay} value={lane.settings.fallbackWaitMs} onChange={e => update(i, { fallbackWaitMs: Number(e.target.value) })} /><small>From each new piece. Gravity keeps running.</small></label> : <p className="lt-fallback-off">No local fallback. The last valid decision continues, then gravity takes over.</p>}</div>
        </div>
        <div className="lt-game"><Board game={lane.game} label={`Lane ${i + 1}`} /><aside className="lt-piece-rail"><span>Next</span>{lane.game.queue.slice(0, 3).map((type, k) => <MiniPiece key={k} type={type} label={`Next ${k + 1}`} />)}<span>Hold</span><MiniPiece type={lane.game.held} label="Held piece" /><small>{lane.game.canHold ? "Available" : "Used this piece"}</small></aside></div>
        <div className="lt-authority" aria-live="off"><span className={lane.authority === "local fallback" ? "lt-fallback" : ""}>{replay ? "Recorded: " : ""}{lane.authority}</span>{lane.pending && !replay && <span className="lt-wait">decision in flight · gravity continues</span>}</div>
        <div className="lt-scores"><span><b>{lane.game.score.toLocaleString()}</b>score</span><span><b>{lane.game.lines}</b>lines</span><span><b>{lane.game.level}</b>level</span><span><b>{boardFeatures(lane.game.board).holes}</b>holes</span></div>
        <button className="lt-take" disabled={replay || lane.game.status === "over"} onClick={() => take(i)}>{lane.human ? "Hand back this board" : "Take this board"}</button>
        {lane.human && <div className="lt-manual"><button className="lt-manual-transport" disabled={replay || allOver} onClick={() => mutate(() => session.running ? session.pause() : session.play())}>{session.running ? <Pause size={15} /> : <Play size={15} />}{session.running ? "Pause both worlds" : "Resume both worlds"}</button><p>Arrows move and rotate. Z rotates back, C holds, Space drops.</p><div className="lt-touch">{([
          ["left", "Move left", ArrowLeft], ["ccw", "Rotate back", RotateCcw], ["cw", "Rotate", RotateCw], ["right", "Move right", ArrowRight], ["soft", "Soft drop", ArrowDown],
        ] as const).map(([action, label, Icon]) => <button key={action} disabled={!session.running || replay} aria-label={`Lane ${i + 1} ${label}`} onClick={() => input(i, action)}><Icon size={19} /><span>{label}</span></button>)}<button disabled={!session.running || replay} onClick={() => input(i, "hold")}>Hold</button><button disabled={!session.running || replay} onClick={() => input(i, "drop")}>Drop</button></div></div>}
        <Coverage lane={lane} />
        <DecisionStatus events={session.eventsThrough(shown.clockMs)} lane={i} />
        <details className="lt-lane-details"><summary>Timing and returned decisions</summary><label>{lane.settings.source === "local" ? "Artificial response delay" : "Local demo delay, inactive for Jev"}<input type="range" min="0" max="2400" step="50" disabled={replay || lane.settings.source === "jev"} value={lane.settings.delayMs} onChange={e => update(i, { delayMs: Number(e.target.value) })} /><output>{lane.settings.delayMs}ms</output></label><label>Time between request starts<input type="range" min="200" max="2400" step="100" disabled={replay} value={lane.settings.intervalMs} onChange={e => update(i, { intervalMs: Number(e.target.value) })} /><output>{lane.settings.intervalMs}ms</output></label><p>{lane.stats.accepted} accepted · {lane.stats.stale} stale · {lane.stats.failed} failed · {lane.stats.cancelled} cancelled</p><p>{instructions[lane.settings.framing]}</p></details>
        {lane.settings.source === "jev" && !getApiKey() && <p className="lt-note">Connect your Gateway key above for Jev decisions. Gravity and the chosen fallback keep running without a key.</p>}
      </section>)}
    </div>
    <section className="lt-timeline"><div><h3>Same moment. A different next move.</h3><span>{session.history.length} paired checkpoints</span></div><label>Rewind both worlds<input aria-label="Rewind both Tetris boards" type="range" min="0" max={session.history.length - 1} value={replay ? session.cursor : session.history.length - 1} onChange={e => mutate(() => session.scrub(Number(e.target.value)))} /></label><div className="lt-timeline-actions"><button onClick={() => mutate(() => session.branch())}>Branch from this moment</button><button disabled={!replay} onClick={() => mutate(() => session.latest())}>Return to latest</button><button onClick={() => download("live-tetris-trajectory.json", session.export())}>Export trajectory</button></div><p>Scrubbing pauses both boards and sends no requests. A branch preserves both worlds, piece queues, controls and scores. Each preserved run can be restored.</p><div className="lt-timeline-actions"><button onClick={() => mutate(() => session.compareFrom(0))}>Compare both from board A</button><button onClick={() => mutate(() => session.compareFrom(1))}>Compare both from board B</button></div><p>Start a matched comparison from either board's current checkpoint. Both receive that board and piece queue; controllers start fresh and coverage counters restart. Each lane keeps its chosen source and assistance setting.</p><div className="lt-saved">{session.saved.map(saved => <button key={saved.id} onClick={() => mutate(() => session.restore(saved.id))}>{saved.label} · {(saved.tail.clockMs / 1000).toFixed(1)}s</button>)}</div></section>
    <details className="lt-explainer"><summary>Read the rules and what this comparison measures</summary><p>This is a complete, simplified Tetris variant. A seeded seven-bag supplies pieces indefinitely. The board has 10 columns and 20 rows, hold once per piece, a ghost landing, clockwise and counterclockwise rotation with simple kicks, and a 450ms lock delay with at most 15 resets. It does not implement the official SRS rotation system, T-spin bonuses or multiplayer garbage.</p><p>One to four lines score 100, 300, 500 or 800 points times the current level. Soft drop adds one point per cell and hard drop adds two. Every ten lines raises the level and speeds up gravity. The game ends when a piece cannot spawn or locks above the board.</p><p>Both boards begin with identical state and piece order. You can run the same Jev formulation with and without local fallback. Unassisted play continues the last valid command or route; when it expires, gravity continues. Assisted play lets a deterministic search choose a new landing. Following a model-selected landing is code actuation; choosing a fallback landing is local assistance.</p><p>The local timing demo uses a code planner plus artificial delay. Its wins, line clears and latency are not Jev measurements. Landing judgments receive computed future features; short buttons receive the current board. Intent asks Jev to choose a code planner objective. These differ in information and code assistance, so they do not isolate wording.</p><p>The earlier frozen benchmark recorded 25 Jev games and zero cleared lines. This new continuous game has not been validated by new paid model runs. Its local planner cannot establish improved model ability. Coverage below each board counts controller ownership over world time, including code execution of selected targets.</p><p>Checkpoints are kept in memory every 200ms until you leave this page. Export saves the current and preserved runs. Backgrounding the tab pauses both boards and cancels requests. Failed providers leave gravity running; a failure is recorded separately from a stale decision.</p></details>
    <details className="lt-inspector"><summary>Inspect this checkpoint and its decisions</summary><pre>{JSON.stringify({ checkpoint: shown, decisionsThroughCheckpoint: session.eventsThrough(shown.clockMs).slice(-4) }, null, 2)}</pre></details>
  </div>;
}
function DecisionStatus({ events, lane }: { events: DecisionEvent[]; lane: number }) {
  const last = events.filter(event => event.lane === lane && event.status !== "pending" && event.status !== "cancelled").at(-1);
  return <p className="lt-last-decision">{last ? <>{last.source === "jev" ? "Jev" : "Local demo"}: {last.status} · {Math.round(last.latencyMs ?? 0)}ms wall time · {((last.receivedAt! - last.sentAt) / 1000).toFixed(2)}s world age{last.reason && <span>{last.reason}</span>}</> : "No completed decisions in this timeline yet"}</p>;
}
function Coverage({ lane }: { lane: Lane }) {
  const s = lane.stats, total = s.jevMs + s.demoMs + s.fallbackMs + s.humanMs + s.gravityMs;
  const segments = [{ label: "Jev", value: s.jevMs, color: "#9aba9b" }, { label: "Local demo", value: s.demoMs, color: "#9bb9cf" }, { label: "Fallback", value: s.fallbackMs, color: "#e69c7b" }, { label: "Human", value: s.humanMs, color: "#c3a9de" }, { label: "Gravity", value: s.gravityMs, color: "#8c968b" }];
  return <div className="lt-coverage"><div className="lt-coverage-bar" aria-hidden="true">{segments.map(segment => <span key={segment.label} style={{ width: pct(segment.value, total), background: segment.color }} />)}</div><p>{segments.filter(segment => segment.value > 0).map(segment => <span key={segment.label}>{segment.label} {pct(segment.value, total)}</span>)}{!total && <span>Controller time will appear here</span>}</p></div>;
}
