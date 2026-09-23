import { useEffect, useMemo, useRef, useState } from "react";
import gamesUrl from "../../../roadmap/tetris/games.jsonl?url";
import framingsUrl from "../../../packages/arena/recordings/tetris-framings.replay.jsonl?url";
import realtimeUrl from "../../../packages/arena/recordings/realtime.replay.json?url";
import realtime2Url from "../../../packages/arena/recordings/realtime-2.replay.json?url";
import { framedJev, recordedFraming, FRAMING_NAMES, type Exchange, type FramingId } from "../../../packages/arena/src/tetris-framings";
import { cells, COLS, ROWS, ghost, type Game } from "../../../live-worlds/tetris/engine";
import { heuristic, randomPlayer, recorded, timedReplay, TetrisArena, type Contestant, type TimedEvent, type LogEntry, type RecordedEvent, type TimingMode } from "../../../packages/arena/src/tetris";
import { questions, scoreboard, verdict, type Study, type StudyQuestion } from "../../../packages/arena/src/study";
import { getApiKey, run } from "../api";
import "./arena.css";

const SEEDS = [7, 19, 42];
const LANDING_LANE = 1;
const pct = (n: number) => `${Math.round(n * 100)}%`;
/** "6_16-5_17-6_17-5_18" → "columns 5–6" */
const describeLanding = (id: string) => { const xs = id.split("-").map((c) => +c.split("_")[0]); const lo = Math.min(...xs) + 1, hi = Math.max(...xs) + 1; return lo === hi ? `column ${lo}` : `columns ${lo}–${hi}`; };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---------- game lane ----------
type RealtimeGame = { seed: number; design: FramingId; retryPolicy?: "fixed" | "backoff"; events: TimedEvent[] };
type Recordings = { games: Record<number, RecordedEvent[]>; framings: Record<number, Exchange[]>; realtime: RealtimeGame[] };
const jsonl = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
function useRecordings() {
  const [recordings, setRecordings] = useState<Recordings | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([fetch(gamesUrl).then((r) => r.text()), fetch(framingsUrl).then((r) => r.text()), fetch(realtimeUrl).then((r) => r.json()), fetch(realtime2Url).then((r) => r.json())]).then(([games, framings, realtime, realtime2]) => {
      if (!alive) return;
      const byseed: Record<number, Exchange[]> = {};
      for (const x of jsonl(framings)) (byseed[x.seed] ??= []).push(x);
      setRecordings({ games: Object.fromEntries(jsonl(games).map((g: any) => [g.summary.seed, g.events.filter((e: any) => e.lane === LANDING_LANE)])), framings: byseed, realtime: [...realtime.games.map((g: RealtimeGame) => ({ ...g, retryPolicy: "fixed" as const })), ...realtime2.games] });
    });
    return () => { alive = false; };
  }, []);
  return recordings;
}

type Lineup = "baselines" | "designs";
function lineup(kind: Lineup, seed: number, recordings: Recordings, jevLive: boolean, mode: TimingMode): Contestant[] {
  if (kind === "designs") {
    if (mode === "realtime") {
      // The most recent recording of each design (run 2 backs off after rate limits).
      const lane = (d: FramingId) => { const g = [...recordings.realtime].reverse().find((x) => x.seed === seed && x.design === d); return timedReplay(g?.events ?? [], `Jev · ${FRAMING_NAMES[d]}`, `jev-${d}-realtime`, g?.retryPolicy ?? "backoff"); };
      return [lane("landing-choice"), lane("spot-clean"), lane("spot-clean-confident"), heuristic(0, "Code planner")];
    }
    const x = recordings.framings[seed] ?? [];
    return [recordedFraming(x, "landing-choice"), recordedFraming(x, "spot-clean"), recordedFraming(x, "spot-score"), heuristic(0, "Code planner")];
  }
  // Live Jev asks the best design, with a short budget in real time: a late answer is useless.
  const budget = mode === "realtime" ? { deadlineMs: 4000, maxAttempts: 2 } : undefined;
  const jev = jevLive
    ? { ...framedJev("spot-clean-cached", (body, signal) => run(body.state, body.questions, signal, budget)), name: "Jev · live" }
    : recorded(recordings.games[seed] ?? [], "Jev · recorded");
  return [jev, heuristic(0, "Code planner"), heuristic(900, "Code planner · 900 ms"), randomPlayer(seed)];
}

function Board({ game, target }: { game: Game; target?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const css = getComputedStyle(canvas), size = canvas.width / COLS, ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = css.getPropertyValue("--arena-cell"); ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fill = (x: number, y: number, color: string) => { if (y < 0) return; ctx.fillStyle = color; ctx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2); };
    game.board.forEach((row, y) => row.forEach((v, x) => v && fill(x, y, css.getPropertyValue("--arena-stack"))));
    if (game.status === "playing") {
      const g = ghost(game);
      ctx.strokeStyle = css.getPropertyValue("--arena-ghost"); ctx.lineWidth = 1.5;
      cells(g).forEach(([x, y]) => y >= 0 && ctx.strokeRect(x * size + 2, y * size + 2, size - 4, size - 4));
      if (target) {
        ctx.strokeStyle = css.getPropertyValue("--arena-target"); ctx.lineWidth = 2;
        target.split("-").forEach((cell) => { const [x, y] = cell.split("_").map(Number); ctx.strokeRect(x * size + 1.5, y * size + 1.5, size - 3, size - 3); });
      }
      cells(game.active).forEach(([x, y]) => fill(x, y, css.getPropertyValue("--arena-active")));
    }
  });
  return <canvas ref={ref} className="arena-board" width={COLS * 14} height={ROWS * 14} aria-label={`Board: ${game.lines} lines, ${game.pieces} pieces${game.status === "over" ? ", game over" : ""}`} />;
}

function TopChoices({ entry }: { entry?: LogEntry }) {
  if (!entry?.probabilities) return <p className="arena-muted">No distribution yet</p>;
  const top = Object.entries(entry.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return <ol className="arena-top">{top.map(([id, p]) => <li key={id} className={id === entry.choice ? "chosen" : ""}><span style={{ width: `${Math.max(2, p * 100)}%` }} /> <b>{pct(p)}</b> <code title={id}>{describeLanding(id)}</code></li>)}</ol>;
}

function GameLane() {
  const recordings = useRecordings();
  const [seed, setSeed] = useState(7);
  const [mode, setMode] = useState<TimingMode>("realtime");
  const [kind, setKind] = useState<Lineup>("baselines");
  const [jevLive, setJevLive] = useState(false);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [, setFrame] = useState(0);
  const arena = useRef<TetrisArena | null>(null);
  const hasKey = !!getApiKey();

  const reset = () => { if (!recordings) return; arena.current = new TetrisArena(seed, lineup(kind, seed, recordings, jevLive && hasKey, mode), mode, { pieceLimit: kind === "designs" ? 40 : undefined }); setRunning(false); setFrame((f) => f + 1); };
  useEffect(reset, [recordings, seed, mode, jevLive, kind]);

  useEffect(() => {
    if (!running || !arena.current) return;
    let raf = 0, last = performance.now(), cancelled = false, busy = false;
    const loop = (now: number) => {
      const a = arena.current!;
      if (a.mode === "realtime") { a.advance((now - last) * speed); last = now; }
      else if (!busy && now - last > 260 / speed) { busy = true; last = now; a.turn().then(() => { busy = false; }); }
      if (a.over) { a.stop(); setRunning(false); }
      setFrame((f) => f + 1);
      if (!cancelled) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [running, speed]);

  const a = arena.current;
  if (!recordings || !a) return <p className="arena-muted">Loading recorded games…</p>;
  const lastBy = (lane: number) => [...a.log].reverse().find((e) => e.lane === lane && e.status !== "pending");
  const pendingBy = (lane: number) => a.lanes[lane].pending;

  return (
    <section className="arena-section" aria-labelledby="arena-game">
      <header className="arena-section-head">
        <h2 id="arena-game">Same seed, four brains</h2>
        <p>Four copies of one Tetris game get the same pieces in the same order. Each copy has a different decision-maker answering one typed question per piece: <i>which reachable landing?</i></p>
      </header>
      <div className="arena-controls" role="group" aria-label="Game controls">
        {a.mode === "realtime" ? (
          <button className="primary" onClick={() => setRunning((r) => !r)} disabled={a.over}>{running ? "Pause" : a.clockMs ? "Resume" : "Play"}</button>
        ) : (<>
          <button className="primary" onClick={() => setRunning((r) => !r)} disabled={a.over}>{running ? "Pause" : "Play turns"}</button>
          <button onClick={() => a.turn().then(() => setFrame((f) => f + 1))} disabled={running || a.over}>Next piece</button>
        </>)}
        <button onClick={reset}>Reset</button>
        <label>Players <select value={kind} onChange={(e) => setKind(e.target.value as Lineup)}><option value="baselines">Jev and code players</option><option value="designs">Three ways to ask Jev</option></select></label>
        <label>Timing <select value={mode} onChange={(e) => setMode(e.target.value as TimingMode)}><option value="realtime">Real time: gravity keeps going</option><option value="turns">Turns: the world waits</option></select></label>
        <label>Seed <select value={seed} onChange={(e) => setSeed(+e.target.value)}>{SEEDS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Speed <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>{[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}</select></label>
        <label className="arena-check"><input type="checkbox" checked={jevLive && hasKey} disabled={!hasKey} onChange={(e) => setJevLive(e.target.checked)} /> Jev live {hasKey ? "(uses your key)" : "(connect a key in Settings)"}</label>
        <span className="arena-clock">{a.mode === "realtime" ? `${(a.clockMs / 1000).toFixed(1)} s of game time` : `Piece ${Math.min(a.pieceLimit, Math.max(...a.lanes.map((l) => l.game.pieces)) + 1)}`}{Number.isFinite(a.pieceLimit) ? ` · ${a.pieceLimit}-piece games` : ""}</span>
      </div>
      <div className="arena-lanes">
        {a.lanes.map((lane, i) => {
          const last = lastBy(i), pending = pendingBy(i), lat = median(lane.stats.latencyMs);
          return (
            <article key={i} className="arena-lane" aria-label={lane.contestant.name}>
              <header><h3>{lane.contestant.name}</h3><span className={`arena-source ${lane.contestant.source}`}>{lane.contestant.source}</span></header>
              <Board game={lane.game} target={lane.plan?.target} />
              <dl className="arena-stats">
                <div><dt>Lines</dt><dd>{lane.game.lines}</dd></div>
                <div><dt>Pieces</dt><dd>{lane.game.pieces}</dd></div>
                <div><dt>Score</dt><dd>{lane.game.score}</dd></div>
                <div><dt>Median answer</dt><dd>{lat == null ? "—" : `${Math.round(lat)} ms`}</dd></div>
              </dl>
              <p className="arena-decisions">{lane.stats.applied} answers used · {lane.stats.stale} too late{lane.stats.failed ? ` · ${lane.stats.failed} requests failed and were asked again` : ""}{lane.stats.missing ? ` · ${lane.stats.missing} unanswered` : ""}</p>
              <p className="arena-status">{lane.game.status === "over" ? "Game over" : lane.recordingEnded !== null ? "Stopped where the recording ends" : a.finished(lane) ? `Finished ${a.pieceLimit} pieces` : a.mode === "turns" ? "Waits for the next turn" : pending ? "Waiting for an answer while gravity continues" : lane.plan ? "Moving to its chosen landing" : "Falling with no plan"}</p>
              {lane.recordingEnded !== null && <p className="arena-marker">The recorded answers cover this game up to piece {lane.recordingEnded}. Beyond that the board differs from anything recorded, so the lane stops rather than guess.</p>}
              <TopChoices entry={last} />
            </article>
          );
        })}
      </div>
      {kind === "designs" ? <p className="arena-note">{mode === "turns"
        ? "Turns, recorded 22 September 2026, 40 pieces. Picking one landing from a list of numbers cleared 2, 7 and 7 lines on seeds 7, 19 and 42. Describing each distinct spot in a sentence and asking Jev to judge it cleared 13, 14 and 12; rating each spot 0–3 cleared 15, 8 and 13. The code planner cleared 15, 14 and 12. Code does the counting and picks the best-judged spot; Jev judges."
        : "Real time, recorded 22 September 2026, 40 pieces, gravity never waits. Picking one landing cleared 5, 6 and 7 lines. Judging each spot cleared 13, 14 and 12 but took 68–88 s of game time, mostly waiting out rate limits. Remembering only confident judgements, and asking again about unsure ones with every spot in view, cleared 12, 11 and 10 in 40–51 s, reusing about 390 judgements per game. Each Jev lane played its own game with one request in flight; they are shown side by side here from their recordings."}</p> :
      <p className="arena-note">Jev's answers come from live games recorded on 20 September 2026 through AI Gateway, replayed exactly at their recorded world times, including its late and failed answers. On a different board or with different timing the recording no longer applies, and the lane says so. The code planner is the same rule in both lanes; the second answers 900 ms later, so the difference between them is the cost of latency alone.</p>}
      <DecisionLog log={a.log} lanes={a.lanes.map((l) => l.contestant.name)} />
    </section>
  );
}

function DecisionLog({ log, lanes }: { log: LogEntry[]; lanes: string[] }) {
  const rows = log.slice(-18).reverse();
  return (
    <details className="arena-log">
      <summary>Decision log · {log.length} questions</summary>
      <table>
        <thead><tr><th>#</th><th>Lane</th><th>Piece</th><th>Asked</th><th>Answered</th><th>Status</th><th>Top probability</th><th>Note</th></tr></thead>
        <tbody>{rows.map((e) => <tr key={e.seq}><td>{e.seq}</td><td>{lanes[e.lane]}</td><td>{e.pieceId}</td><td>{(e.sentAt / 1000).toFixed(2)} s</td><td>{e.resolvedAt == null ? "—" : `${(e.resolvedAt / 1000).toFixed(2)} s`}</td><td><span className={`arena-status-pill ${e.status}`}>{e.status}</span></td><td>{e.probabilities && e.choice ? pct(e.probabilities[e.choice] ?? 0) : "—"}</td><td>{e.reason ?? ""}</td></tr>)}</tbody>
      </table>
    </details>
  );
}

// ---------- static lane ----------
const DEFAULT_MODELS = ["jev", "laya-tuned", "Qwen3-4B-Instruct-2507-4bit", "train-prior", "uniform"];

function Reliability({ bins }: { bins: { lo: number; hi: number; count: number; confidence: number; agreement: number }[] }) {
  const s = 96;
  return (
    <svg className="arena-reliability" viewBox={`0 0 ${s} ${s}`} role="img" aria-label="Agreement by stated confidence; the diagonal is perfect calibration">
      <line x1="0" y1={s} x2={s} y2="0" className="diag" />
      {bins.map((b) => <rect key={b.lo} x={b.lo * s + 1} width={s / 10 - 2} y={s - b.agreement * s} height={b.agreement * s} opacity={Math.min(1, 0.25 + b.count / 150)} />)}
    </svg>
  );
}

function Bars({ values, keys, highlight }: { values: number[]; keys: string[]; highlight?: number }) {
  const sum = values.reduce((a, b) => a + b, 0);
  return <div className="arena-bars">{values.map((v, i) => <div key={keys[i]} className={i === highlight ? "top" : ""} title={`${keys[i]} ${pct(v / sum)}`}><span style={{ height: `${Math.max(2, (v / sum) * 100)}%` }} /></div>)}</div>;
}

function StaticLane() {
  const [study, setStudy] = useState<Study | null>(null);
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [workflow, setWorkflow] = useState("");
  const [type, setType] = useState<"" | StudyQuestion["type"]>("");
  const [caseIndex, setCaseIndex] = useState(0);
  useEffect(() => { let alive = true; fetch("/data/local-models.json").then((r) => r.json()).then((d) => alive && setStudy(d.result)); return () => { alive = false; }; }, []);
  const board = useMemo(() => study ? scoreboard(study, models, { workflow: workflow || undefined, type: type || undefined }) : null, [study, models, workflow, type]);
  if (!study || !board) return <p className="arena-muted">Loading 400 recorded cases…</p>;
  const cases = study.cases.filter((c) => !workflow || c.workflow === workflow);
  const current = cases[caseIndex % cases.length];
  const nameOf = (id: string) => study.models.find((m) => m.id === id)?.name ?? id;
  const decisions = questions(study, { workflow: workflow || undefined, type: type || undefined }).length;
  return (
    <section className="arena-section" aria-labelledby="arena-static">
      <header className="arena-section-head">
        <h2 id="arena-static">Same case, many models</h2>
        <p>Every model answered the same {study.cases.length} cases, five typed questions each, with a probability for every option. The reference is a soft label from another model, so these numbers measure agreement with it, not correctness.</p>
      </header>
      <div className="arena-controls" role="group" aria-label="Comparison filters">
        <label>Workflow <select value={workflow} onChange={(e) => { setWorkflow(e.target.value); setCaseIndex(0); }}><option value="">All four</option>{study.workflows.map((w) => <option key={w} value={w}>{w.replaceAll("_", " ")}</option>)}</select></label>
        <label>Question type <select value={type} onChange={(e) => setType(e.target.value as any)}><option value="">All</option><option value="choice">choice</option><option value="score">score</option><option value="noul">noul (yes/no)</option></select></label>
        <details className="arena-picker"><summary>Models ({models.length})</summary>
          {study.models.map((m) => <label key={m.id} className="arena-check"><input type="checkbox" checked={models.includes(m.id)} onChange={(e) => setModels((ms) => e.target.checked ? [...ms, m.id] : ms.filter((x) => x !== m.id))} /> {m.name}</label>)}
        </details>
        <span className="arena-clock">{decisions} decisions</span>
      </div>
      <table className="arena-scoreboard">
        <thead><tr><th>Model</th><th>Agrees with reference</th><th>Calibration error</th><th>Brier</th><th>Confident but disagrees</th><th>Mean confidence</th><th>Local time per case</th><th>Agreement by confidence</th></tr></thead>
        <tbody>{models.map((id) => { const s = board[id], m = study.models.find((x) => x.id === id)!; return (
          <tr key={id}><th scope="row">{m.name}<small>{m.kind}</small></th><td>{pct(s.agreement)}</td><td>{s.ece.toFixed(3)}</td><td>{s.brier.toFixed(3)}</td><td>{s.confidentButWrong}</td><td>{pct(s.meanConfidence)}</td><td>{m.case_latency_ms ? `${Math.round(m.case_latency_ms.median)} ms` : id === "jev" ? "hosted" : "—"}</td><td><Reliability bins={s.reliability} /></td></tr>); })}</tbody>
      </table>
      <div className="arena-case">
        <div className="arena-case-head">
          <h3>Case {current.id.replace(/_/g, " ")}</h3>
          <button onClick={() => setCaseIndex((i) => (i - 1 + cases.length) % cases.length)}>Previous</button>
          <button onClick={() => setCaseIndex((i) => (i + 1) % cases.length)}>Next</button>
          <button onClick={() => setCaseIndex(Math.floor(Math.random() * cases.length))}>Random</button>
        </div>
        <details><summary>State the models saw</summary><pre>{JSON.stringify(current.state, null, 2)}</pre></details>
        {current.questions.filter((q) => !type || q.type === type).map((q) => (
          <div key={q.key} className="arena-question">
            <p><b>{q.instructions}</b> <span className="arena-muted">{q.type}</span></p>
            <div className="arena-answer-row">
              <figure><Bars values={q.target} keys={q.keys} highlight={q.target.indexOf(Math.max(...q.target))} /><figcaption>Reference</figcaption></figure>
              {models.map((id) => { const v = verdict(q, id); return (
                <figure key={id} className={v.confidentButWrong ? "wrong" : ""}><Bars values={q.predictions[id]} keys={q.keys} highlight={v.index} /><figcaption>{nameOf(id)}<br /><span>{q.keys[v.index].replaceAll("_", " ")} · {pct(v.confidence)}{v.confidentButWrong ? " · confident, disagrees" : ""}</span></figcaption></figure>); })}
            </div>
            <p className="arena-options">{q.keys.map((k, i) => <span key={k}><b>{k.replaceAll("_", " ")}</b>: {q.options[i]}</span>)}</p>
          </div>
        ))}
      </div>
      <p className="arena-note">Recorded {study.hardware} on 20 September 2026 from <a href={study.provenance.url}>{study.provenance.name}</a> ({study.provenance.license}, revision {study.provenance.revision.slice(0, 7)}). Per the dataset card, the reference is the mean of three samples from an unnamed teacher of roughly 4B-class capability; agreement saturates near 75%. Local times are sequential per case on that machine; Jev's hosted times include the network and are not comparable.</p>
    </section>
  );
}

export function ArenaPage() {
  return (
    <main id="main-content" tabIndex={-1} className="arena-page">
      <header className="arena-intro">
        <p className="arena-kicker">Arena · working draft</p>
        <h1>Several models, one world.</h1>
        <p>Run the same situation with different decision-makers side by side. Recorded answers replay without a key; connect a key and Jev plays live.</p>
      </header>
      <GameLane />
      <StaticLane />
    </main>
  );
}
