import { advanceGame, chooseLanding, cloneGame, command, createGame, landings, STEP_MS, type Command, type Game, type Intent } from "./engine";

export type Source = "local" | "jev";
export type Framing = "landing" | "button" | "intent";
export const DECISION_INSTRUCTIONS: Record<Framing, string> = {
  button: "Choose one short control for the falling piece. Rotations and hard drop happen once; left/right/soft drop repeat for 240ms. Gravity continues. Prefer moves that avoid holes and complete rows. The answer expires after 300ms of world time.",
  landing: "Choose a reachable landing for this piece. Candidate features are computed by code after line clearing. Avoid top-out and buried empty cells, keep the stack low, and clear lines. Code will execute the route to your chosen landing if it remains reachable.",
  intent: "Choose the code planner's objective for this piece. You choose a policy, not a landing or direct control. Code searches reachable landings and follows the selected objective.",
};
export type DecisionRequest = { state: unknown; questions: { decision: { type: "choice"; instructions: string; criteria: Record<string, string> } } };
export type Settings = { source: Source; framing: Framing; assisted: boolean; delayMs: number; intervalMs: number; fallbackWaitMs: number };
export type Authority = "human" | "Jev decision" | "local demo decision" | "local fallback" | "gravity only" | "game over";
type Plan = { pieceId: number; origin: Source | "fallback"; target?: string; action?: Command; expires: number; nextAt: number; intent?: Intent; used?: boolean };
export type Stats = { accepted: number; stale: number; failed: number; cancelled: number; jevMs: number; demoMs: number; fallbackMs: number; humanMs: number; gravityMs: number };
export type Lane = { game: Game; settings: Settings; human: boolean; revision: number; plan: Plan | null; nextRequestAt: number; pending: string | null; authority: Authority; stats: Stats; trackedPieceId: number; pieceStartedAt: number };
export type Pair = { clockMs: number; seed: number; lanes: [Lane, Lane] };
export type DecisionEvent = { id: string; lane: number; sentAt: number; receivedAt?: number; resolvedAt?: number; latencyMs?: number; source: Source; framing: Framing; pieceId: number; status: "pending" | "accepted" | "stale" | "failed" | "cancelled"; reason?: string; answer?: string; state: unknown; options: Record<string, string>; request: DecisionRequest; response?: unknown; httpStatus?: number };
export type Ticket = { id: string; lane: number; epoch: number; revision: number; pieceId: number; sentAt: number; framing: Framing; settings: Settings; state: unknown; options: Record<string, string>; request: DecisionRequest; suggested: string; deadline: number };
export type SavedRun = { id: number; label: string; tail: Pair; history: Pair[]; events: DecisionEvent[] };
const BUTTONS: Record<string, string> = { left: "Hold left briefly", right: "Hold right briefly", cw: "Rotate clockwise once", ccw: "Rotate counterclockwise once", soft: "Hold soft drop briefly", drop: "Hard drop and lock now", wait: "Let gravity act" };
const INTENTS: Record<string, string> = { clear_lines: "Code planner favors immediate cleared lines", keep_low: "Code planner favors lower total column height", avoid_holes: "Code planner strongly penalizes buried empty cells" };
const stats = (): Stats => ({ accepted: 0, stale: 0, failed: 0, cancelled: 0, jevMs: 0, demoMs: 0, fallbackMs: 0, humanMs: 0, gravityMs: 0 });
const makeLane = (game: Game, assisted: boolean): Lane => ({ game, settings: { source: "local", framing: "landing", assisted, delayMs: 450, intervalMs: 900, fallbackWaitMs: 700 }, human: false, revision: 0, plan: null, nextRequestAt: 0, pending: null, authority: "gravity only", stats: stats(), trackedPieceId: game.pieceId, pieceStartedAt: 0 });
export const snapshot = (pair: Pair): Pair => structuredClone(pair);
function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown) => {
    if (node && typeof node === "object") { Object.values(node).forEach(freeze); Object.freeze(node); }
  };
  freeze(copy); return copy;
}
export class TetrisSession {
  pair: Pair;
  history: Pair[];
  events: DecisionEvent[] = [];
  saved: SavedRun[] = [];
  running = false;
  cursor = -1;
  epoch = 0;
  serial = 0;
  private remainder = 0;
  private lastSnapshotAt = 0;
  constructor(seed = 19) {
    const game = createGame(seed);
    this.pair = { clockMs: 0, seed, lanes: [makeLane(cloneGame(game), true), makeLane(cloneGame(game), false)] };
    this.history = [snapshot(this.pair)];
  }
  get shown() { return this.cursor < 0 ? this.pair : this.history[this.cursor]; }
  eventsThrough(clockMs: number): DecisionEvent[] {
    return this.events.filter(e => e.sentAt <= clockMs).map(e => e.resolvedAt !== undefined && e.resolvedAt > clockMs
      ? { ...e, status: "pending", receivedAt: undefined, resolvedAt: undefined, latencyMs: undefined, reason: undefined, answer: undefined, response: undefined, httpStatus: undefined }
      : e);
  }
  private checkpoint() {
    const current = snapshot(this.pair);
    if (this.history.at(-1)?.clockMs === current.clockMs) this.history[this.history.length - 1] = current;
    else this.history.push(current);
    this.lastSnapshotAt = current.clockMs;
  }
  private invalidate(lane?: number) {
    if (lane === undefined) this.epoch++;
    for (const l of lane === undefined ? this.pair.lanes : [this.pair.lanes[lane]]) {
      if (l.pending) { const e = this.events.find(e => e.id === l.pending); if (e) { e.status = "cancelled"; e.resolvedAt = this.pair.clockMs; e.reason = "Controls or timeline changed"; } l.stats.cancelled++; }
      l.pending = null;
    }
    if (lane !== undefined) { this.pair.lanes[lane].revision++; this.pair.lanes[lane].plan = null; this.pair.lanes[lane].nextRequestAt = this.pair.clockMs; }
  }
  pause() { this.running = false; this.invalidate(); this.checkpoint(); }
  play() { if (this.cursor < 0) this.running = true; }
  configure(index: number, settings: Partial<Settings>) {
    if (this.cursor >= 0) return;
    // Changing only the fallback wait does not change a model question or a valid plan.
    if (Object.keys(settings).some(key => key !== "fallbackWaitMs")) this.invalidate(index);
    if (settings.fallbackWaitMs !== undefined) settings = { ...settings, fallbackWaitMs: Number.isFinite(settings.fallbackWaitMs) ? Math.max(0, Math.min(2400, Math.round(settings.fallbackWaitMs))) : this.pair.lanes[index].settings.fallbackWaitMs };
    Object.assign(this.pair.lanes[index].settings, settings); this.checkpoint();
  }
  takeover(index: number) {
    if (this.cursor >= 0) return;
    this.invalidate(index); const l = this.pair.lanes[index]; l.human = !l.human;
    l.authority = l.human ? "human" : "gravity only"; this.checkpoint();
  }
  input(index: number, input: Command) {
    if (!this.running || this.cursor >= 0 || !this.pair.lanes[index].human) return;
    const lane = this.pair.lanes[index]; command(lane.game, input); this.trackPiece(lane); this.checkpoint();
  }
  private trackPiece(lane: Lane) {
    if (lane.trackedPieceId !== lane.game.pieceId) {
      lane.trackedPieceId = lane.game.pieceId; lane.pieceStartedAt = this.pair.clockMs;
      if (lane.plan?.pieceId !== lane.game.pieceId) lane.plan = null;
      lane.authority = lane.human ? "human" : "gravity only";
    }
    if (lane.game.status === "over") lane.authority = "game over";
  }
  /** Retains unprocessed elapsed time; a slow renderer does not discard world time. */
  advance(elapsedMs: number) {
    if (!this.running || this.cursor >= 0) return;
    this.remainder += Math.max(0, elapsedMs);
    let steps = 0;
    while (this.remainder >= STEP_MS && steps < 250) {
      this.remainder -= STEP_MS; this.pair.clockMs += STEP_MS; steps++;
      for (let i = 0; i < 2; i++) this.stepLane(i);
      if (this.pair.clockMs - this.lastSnapshotAt >= 200) { this.history.push(snapshot(this.pair)); this.lastSnapshotAt = this.pair.clockMs; }
    }
    if (this.pair.lanes.every(l => l.game.status === "over")) this.pause();
  }
  private stepLane(index: number) {
    const lane = this.pair.lanes[index], g = lane.game, now = this.pair.clockMs;
    this.trackPiece(lane);
    if (g.status === "over") { lane.authority = "game over"; return; }
    if (lane.plan && (lane.plan.pieceId !== g.pieceId || lane.plan.expires < now)) lane.plan = null;
    if (!lane.human && !lane.plan && lane.settings.assisted && now - lane.pieceStartedAt >= lane.settings.fallbackWaitMs) {
      const pick = chooseLanding(landings(g));
      if (pick) lane.plan = { pieceId: g.pieceId, origin: "fallback", target: pick.id, expires: now + 10000, nextAt: now + 160 };
    }
    const p = lane.human ? null : lane.plan;
    lane.authority = lane.human ? "human" : p ? p.origin === "fallback" ? "local fallback" : p.origin === "jev" ? "Jev decision" : "local demo decision" : "gravity only";
    if (lane.human) lane.stats.humanMs += STEP_MS;
    else if (!p) lane.stats.gravityMs += STEP_MS;
    else if (p.origin === "jev") lane.stats.jevMs += STEP_MS;
    else if (p.origin === "local") lane.stats.demoMs += STEP_MS;
    else lane.stats.fallbackMs += STEP_MS;
    if (p && now >= p.nextAt) {
      p.nextAt = now + 80;
      if (p.target) {
        // Regenerate the route from the moving piece, not from the old observation.
        const target = landings(g).find(o => o.id === p.target);
        if (target) command(g, target.path[0]);
        else lane.plan = null;
      } else if (p.action) {
        const repeat = ["left", "right", "soft"].includes(p.action);
        if (repeat || !p.used) command(g, p.action);
        p.used = true;
      }
    }
    advanceGame(g, STEP_MS);
    this.trackPiece(lane);
  }
  /** Caller sends these asynchronously. Missing BYOK prevents Jev tickets only. */
  requests(hasKey: boolean): Ticket[] {
    if (!this.running || this.cursor >= 0) return [];
    const tickets: Ticket[] = [];
    this.pair.lanes.forEach((lane, index) => {
      if (lane.human || lane.game.status !== "playing" || lane.pending || this.pair.clockMs < lane.nextRequestAt || (lane.settings.source === "jev" && !hasKey)) return;
      const g = lane.game, options = landings(g), best = chooseLanding(options), framing = lane.settings.framing;
      if (!best) return;
      const choices = framing === "button" ? BUTTONS : framing === "intent" ? INTENTS : Object.fromEntries(options.map(o => [o.id, JSON.stringify({ cells: o.id, clears: o.features.lines, buriedEmptyCells: o.features.holes, highestColumn: o.features.height, totalColumnHeight: o.features.aggregateHeight, unevenness: o.features.bumpiness, topOut: o.features.topOut, inputCount: o.path.length })]));
      const state = { rules: "10 columns, 20 rows; gravity continues while you decide; choose one option. Every candidate landing is reachable in the observed state. Code executes a chosen landing route. Intent delegates landing search to a code planner.", board: g.board.map(row => row.map(v => v ? "#" : ".").join("")), active: g.active, pieceId: g.pieceId, next: g.queue.slice(0, 3), score: g.score, lines: g.lines, level: g.level, worldMs: this.pair.clockMs };
      const id = `${this.epoch}:${++this.serial}:${index}`;
      const request = immutableCopy<DecisionRequest>({ state, questions: { decision: { type: "choice", instructions: DECISION_INSTRUCTIONS[framing], criteria: choices } } });
      const t: Ticket = { id, lane: index, epoch: this.epoch, revision: lane.revision, pieceId: g.pieceId, sentAt: this.pair.clockMs, framing, settings: { ...lane.settings }, state: request.state, options: request.questions.decision.criteria, request, suggested: framing === "button" ? best.path[0] : framing === "intent" ? "avoid_holes" : best.id, deadline: framing === "button" ? 300 : 5000 };
      lane.pending = id; lane.nextRequestAt = this.pair.clockMs + lane.settings.intervalMs;
      this.events.push({ id, lane: index, sentAt: t.sentAt, source: t.settings.source, framing, pieceId: t.pieceId, status: "pending", state: request.state, options: request.questions.decision.criteria, request }); tickets.push(t);
    });
    if (tickets.length) this.checkpoint();
    return tickets;
  }
  receive(ticket: Ticket, answer: string | undefined, latencyMs: number, error?: string, response?: unknown, httpStatus?: number) {
    const lane = this.pair.lanes[ticket.lane], event = this.events.find(e => e.id === ticket.id);
    if (ticket.epoch !== this.epoch || lane.pending !== ticket.id || !event || event.status !== "pending") return "cancelled";
    lane.pending = null; event.receivedAt = this.pair.clockMs; event.resolvedAt = this.pair.clockMs; event.latencyMs = latencyMs; event.answer = answer;
    if (response !== undefined) event.response = immutableCopy(response);
    if (httpStatus !== undefined) event.httpStatus = httpStatus;
    const stale = (reason: string) => { event.status = "stale"; event.reason = reason; lane.stats.stale++; this.checkpoint(); return "stale"; };
    if (error || typeof answer !== "string" || !Object.hasOwn(ticket.options, answer)) { event.status = "failed"; event.reason = error ?? "No valid choice returned"; lane.stats.failed++; this.checkpoint(); return "failed"; }
    if (lane.revision !== ticket.revision || lane.human || lane.game.status !== "playing" || lane.game.pieceId !== ticket.pieceId) return stale("The observed piece or controller changed");
    if (this.pair.clockMs - ticket.sentAt > ticket.deadline) return stale("Decision arrived beyond its useful world-time window");
    const now = this.pair.clockMs;
    if (ticket.framing === "button") lane.plan = { pieceId: ticket.pieceId, origin: ticket.settings.source, action: answer as Command, expires: now + 240, nextAt: now };
    else {
      const options = landings(lane.game), intent = ticket.framing === "intent" ? answer as Intent : undefined;
      const target = intent ? chooseLanding(options, intent) : options.find(o => o.id === answer);
      if (!target) return stale("The chosen landing is no longer reachable");
      lane.plan = { pieceId: ticket.pieceId, origin: ticket.settings.source, target: target.id, expires: now + 5000, nextAt: now, intent };
    }
    event.status = "accepted"; lane.stats.accepted++; this.checkpoint(); return "accepted";
  }
  scrub(index: number) { this.pause(); this.cursor = Math.max(0, Math.min(this.history.length - 1, index)); }
  latest() { this.cursor = -1; }
  preserve(label = `Run ${this.saved.length + 1}`) {
    this.pause();
    const run: SavedRun = { id: this.saved.length + 1, label, tail: snapshot(this.pair), history: this.history.map(snapshot), events: structuredClone(this.events) };
    this.saved.push(run); return run;
  }
  branch() {
    const selected = snapshot(this.shown);
    this.preserve(`Before branch ${this.saved.length + 1}`); this.pair = selected;
    this.cursor = -1; this.epoch++; this.remainder = 0;
    for (const l of this.pair.lanes) { l.pending = null; l.nextRequestAt = this.pair.clockMs; l.revision++; }
    this.lastSnapshotAt = this.pair.clockMs; this.history = [snapshot(this.pair)]; this.events = [];
  }
  compareFrom(index: number) {
    this.branch();
    const source = this.pair.lanes[index], game = cloneGame(source.game), pieceStartedAt = source.pieceStartedAt;
    // An explicit fresh-controller comparison preserves the chosen physical world,
    // including its score, RNG and queue. Old trajectories remain in saved runs.
    for (const lane of this.pair.lanes) {
      lane.game = cloneGame(game); lane.plan = null; lane.stats = stats();
      lane.trackedPieceId = game.pieceId; lane.pieceStartedAt = pieceStartedAt;
      lane.authority = lane.human ? "human" : "gravity only";
    }
    this.history = [snapshot(this.pair)];
  }
  slowReplyDemo() {
    this.compareFrom(0);
    this.pair.lanes.forEach((lane, index) => {
      lane.settings = { source: "local", framing: "landing", assisted: index === 0, delayMs: 1200, intervalMs: 900, fallbackWaitMs: 700 };
      lane.human = false; lane.authority = "gravity only";
    });
    this.history = [snapshot(this.pair)];
  }
  restore(id: number) {
    const run = this.saved.find(r => r.id === id); if (!run) return;
    this.preserve(`Before restoring ${id}`); this.pair = snapshot(run.tail);
    this.history = run.history.map(snapshot); this.events = structuredClone(run.events);
    this.cursor = -1; this.epoch++; this.remainder = 0; this.lastSnapshotAt = this.pair.clockMs;
    for (const l of this.pair.lanes) { l.pending = null; l.nextRequestAt = this.pair.clockMs; }
    this.checkpoint();
  }
  restart(seed: number) {
    const settings = this.pair.lanes.map(l => ({ ...l.settings }));
    this.preserve(`Completed run ${this.saved.length + 1}`);
    const fresh = new TetrisSession(seed); this.pair = fresh.pair;
    this.pair.lanes.forEach((l, i) => { l.settings = settings[i]; });
    this.history = [snapshot(this.pair)]; this.events = []; this.cursor = -1; this.remainder = 0; this.lastSnapshotAt = 0; this.epoch++;
  }
  export() { return { format: "jev-live-tetris-v1", simplifiedRules: true, current: this.pair, history: this.history, events: this.events, saved: this.saved }; }
}
