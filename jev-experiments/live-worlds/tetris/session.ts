/**
 * The live Tetris page's paired session: two lanes of the arena's Tetris lane module
 * (packages/arena/src/tetris.ts) plus what only the page needs. That is a timeline of
 * checkpoints (scrub, branch, compare, restore), decision receipts that keep the exact request
 * and reply, and a ticket loop the page drives itself, local timing demo or Jev with the
 * visitor's key. Lane mechanics (gravity, plans, fallback, stale answers) live in the lane module.
 */
import {
  DECISION_INSTRUCTIONS,
  laneStats,
  suggestion,
  TetrisArena,
  type Contestant,
  type Control,
  type Framing,
  type Lane as ArenaLane,
  type LaneSettings,
  type LaneStats,
  type Plan as LanePlan,
  type Question,
} from "../../packages/arena/src/tetris";
import { cloneGame, STEP_MS, type Command, type Game, type Intent } from "../../packages/arena/src/tetris-engine";

export { DECISION_INSTRUCTIONS, type Framing };
export type Source = "local" | "jev";
export type DecisionRequest = Question["request"];
export type Settings = { source: Source; framing: Framing; assisted: boolean; delayMs: number; intervalMs: number; fallbackWaitMs: number };
export type Authority = "human" | "Jev decision" | "local demo decision" | "local fallback" | "gravity only" | "game over";
type Plan = { pieceId: number; origin: Source | "fallback"; target?: string; action?: Command; expires: number; nextAt: number; intent?: Intent; used?: boolean };
export type Stats = { accepted: number; stale: number; failed: number; cancelled: number; jevMs: number; demoMs: number; fallbackMs: number; humanMs: number; gravityMs: number };
/** One lane as the page shows, checkpoints and exports it. */
export type Lane = { game: Game; settings: Settings; human: boolean; revision: number; plan: Plan | null; nextRequestAt: number; pending: string | null; authority: Authority; stats: Stats; trackedPieceId: number; pieceStartedAt: number };
export type Pair = { clockMs: number; seed: number; lanes: [Lane, Lane] };
export type DecisionEvent = { id: string; lane: number; sentAt: number; receivedAt?: number; resolvedAt?: number; latencyMs?: number; source: Source; framing: Framing; pieceId: number; status: "pending" | "accepted" | "stale" | "failed" | "cancelled"; reason?: string; answer?: string; state: unknown; options: Record<string, string>; request: DecisionRequest; response?: unknown; httpStatus?: number };
export type Ticket = { id: string; question: string; lane: number; epoch: number; revision: number; pieceId: number; sentAt: number; framing: Framing; settings: Settings; state: unknown; options: Record<string, string>; request: DecisionRequest; suggested: string; deadline: number };
export type SavedRun = { id: number; label: string; tail: Pair; history: Pair[]; events: DecisionEvent[] };

// The page's names for the lane module's controls and contestant sources.
const SOURCE = { local: "code", jev: "live" } as const;
const ORIGIN: Record<LanePlan["origin"], Plan["origin"]> = { code: "local", live: "jev", recorded: "jev", fallback: "fallback" };
const AUTHORITY: Record<Control, Authority> = { human: "human", gravity: "gravity only", fallback: "local fallback", over: "game over", live: "Jev decision", recorded: "Jev decision", code: "local demo decision" };
const CONTROL = Object.fromEntries(Object.entries(AUTHORITY).filter(([c]) => c !== "recorded").map(([c, a]) => [a, c])) as Record<Authority, Control>;
const toPlan = (p: LanePlan | null): Plan | null => p && { ...p, origin: ORIGIN[p.origin] };
const fromPlan = (p: Plan | null): LanePlan | null => p && { ...p, origin: p.origin === "fallback" ? "fallback" : SOURCE[p.origin] };
const toStats = (s: LaneStats): Stats => ({ accepted: s.applied, stale: s.stale, failed: s.failed, cancelled: s.cancelled, jevMs: s.controlMs.live, demoMs: s.controlMs.code, fallbackMs: s.controlMs.fallback, humanMs: s.controlMs.human, gravityMs: s.controlMs.gravity });
const fromStats = (s: Stats): LaneStats => ({ ...laneStats(), applied: s.accepted, stale: s.stale, failed: s.failed, cancelled: s.cancelled, controlMs: { human: s.humanMs, gravity: s.gravityMs, fallback: s.fallbackMs, recorded: 0, live: s.jevMs, code: s.demoMs } });
/** The page words two stale outcomes its own way; its receipts and recordings keep these. */
const REASON: Record<string, string> = { "The piece locked before the answer arrived": "The observed piece or controller changed", "Answer arrived after its useful window": "Decision arrived beyond its useful world-time window" };
const STATUS = { applied: "accepted", stale: "stale", failed: "failed", missing: "failed", cancelled: "cancelled", pending: "pending" } as const;
const laneSettings = ({ framing, intervalMs, assisted, fallbackWaitMs }: Settings): LaneSettings => ({ framing, intervalMs, assisted, fallbackWaitMs });
const defaults = (assisted: boolean): Settings => ({ source: "local", framing: "landing", assisted, delayMs: 450, intervalMs: 900, fallbackWaitMs: 700 });

export const snapshot = (pair: Pair): Pair => structuredClone(pair);
function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown) => {
    if (node && typeof node === "object") { Object.values(node).forEach(freeze); Object.freeze(node); }
  };
  freeze(copy); return copy;
}
export class TetrisSession {
  history: Pair[];
  events: DecisionEvent[] = [];
  saved: SavedRun[] = [];
  running = false;
  cursor = -1;
  epoch = 0;
  serial = 0;
  private arena!: TetrisArena;
  private seed: number;
  /** What the lane module doesn't know: which source answers each lane, and the local demo's delay. */
  private sources: Pick<Settings, "source" | "delayMs">[] = [];
  private tickets = new Map<string, Ticket>();
  private outbox: Ticket[] = [];
  private hasKey = false;
  private remainder = 0;
  private lastSnapshotAt = 0;
  constructor(seed = 19) {
    this.seed = seed;
    this.start(seed, [defaults(true), defaults(false)]);
    this.history = [snapshot(this.pair)];
  }
  private start(seed: number, settings: Settings[]) {
    this.seed = seed;
    this.sources = settings.map(({ source, delayMs }) => ({ source, delayMs }));
    this.arena = new TetrisArena(seed, [0, 1].map(i => this.contestant(i)), "realtime", { settings: i => laneSettings(settings[i]) });
    this.tickets.clear(); this.outbox = [];
  }
  /** Each lane's contestant turns a due question into a ticket; the page sends it and calls `receive`. */
  private contestant(index: number): Contestant {
    const session = this;
    return {
      id: `lane-${index}`, name: `Lane ${index === 0 ? "A" : "B"}`, reask: true,
      get source() { return SOURCE[session.sources[index].source]; },
      readyToAsk: () => this.sources[index].source !== "jev" || this.hasKey,
      ask: q => { this.issue(index, q); return { later: true }; },
    };
  }
  private issue(index: number, q: Question) {
    const lane = this.arena.lanes[index], id = `${this.epoch}:${++this.serial}:${index}`, settings = this.settingsOf(index), framing = q.framing;
    const request = immutableCopy<DecisionRequest>(q.request);
    const t: Ticket = { id, question: q.id, lane: index, epoch: this.epoch, revision: lane.revision, pieceId: q.pieceId, sentAt: q.sentAt, framing, settings, state: request.state, options: request.questions.decision.criteria, request, suggested: suggestion(framing, q.options), deadline: framing === "button" ? 300 : 5000 };
    this.tickets.set(q.id, t); this.outbox.push(t);
    this.events.push({ id, lane: index, sentAt: t.sentAt, source: settings.source, framing, pieceId: t.pieceId, status: "pending", state: request.state, options: request.questions.decision.criteria, request });
  }
  private settingsOf(index: number): Settings {
    const { framing, assisted, intervalMs, fallbackWaitMs } = this.arena.lanes[index].settings, { source, delayMs } = this.sources[index];
    return { source, framing, assisted, delayMs, intervalMs, fallbackWaitMs };
  }
  private view(index: number): Lane {
    const l = this.arena.lanes[index];
    return { game: l.game, settings: this.settingsOf(index), human: l.human, revision: l.revision, plan: toPlan(l.plan), nextRequestAt: l.nextRequestAt, pending: l.pending ? this.tickets.get(l.pending.question.id)?.id ?? null : null, authority: AUTHORITY[l.control], stats: toStats(l.stats), trackedPieceId: l.trackedPieceId, pieceStartedAt: l.pieceStartedAt };
  }
  /** The current pair. Games are live; everything else is a copy. */
  get pair(): Pair { return { clockMs: this.arena.clockMs, seed: this.seed, lanes: [this.view(0), this.view(1)] }; }
  /** Puts a checkpoint's worlds and controls back on the lanes; nothing stays in flight. */
  private load(pair: Pair) {
    this.seed = pair.seed; this.arena.clockMs = pair.clockMs;
    pair.lanes.forEach((v, i) => {
      const lane: ArenaLane = this.arena.lanes[i];
      this.sources[i] = { source: v.settings.source, delayMs: v.settings.delayMs };
      Object.assign(lane, { game: cloneGame(v.game), settings: laneSettings(v.settings), human: v.human, revision: v.revision, plan: fromPlan(structuredClone(v.plan)), nextRequestAt: v.nextRequestAt, pending: null, control: CONTROL[v.authority], stats: fromStats(v.stats), trackedPieceId: v.trackedPieceId, pieceStartedAt: v.pieceStartedAt });
    });
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
    for (const i of lane === undefined ? [0, 1] : [lane]) {
      const pending = this.arena.lanes[i].pending;
      if (pending) {
        const e = this.events.find(e => e.id === this.tickets.get(pending.question.id)?.id);
        if (e) { e.status = "cancelled"; e.resolvedAt = this.arena.clockMs; e.reason = "Controls or timeline changed"; }
        this.arena.cancel(i, "Controls or timeline changed");
      }
    }
    if (lane !== undefined) { const l = this.arena.lanes[lane]; l.revision++; l.plan = null; l.nextRequestAt = this.arena.clockMs; }
  }
  pause() { this.running = false; this.invalidate(); this.checkpoint(); }
  play() { if (this.cursor < 0) this.running = true; }
  configure(index: number, settings: Partial<Settings>) {
    if (this.cursor >= 0) return;
    // Changing only the fallback wait does not change a model question or a valid plan.
    if (Object.keys(settings).some(key => key !== "fallbackWaitMs")) this.invalidate(index);
    if (settings.fallbackWaitMs !== undefined) settings = { ...settings, fallbackWaitMs: Number.isFinite(settings.fallbackWaitMs) ? Math.max(0, Math.min(2400, Math.round(settings.fallbackWaitMs))) : this.arena.lanes[index].settings.fallbackWaitMs };
    const next = { ...this.settingsOf(index), ...settings };
    this.arena.lanes[index].settings = laneSettings(next); this.sources[index] = { source: next.source, delayMs: next.delayMs };
    this.checkpoint();
  }
  takeover(index: number) {
    if (this.cursor >= 0) return;
    this.invalidate(index); const l = this.arena.lanes[index]; l.human = !l.human;
    l.control = l.human ? "human" : "gravity"; this.checkpoint();
  }
  input(index: number, input: Command) {
    if (!this.running || this.cursor >= 0 || !this.arena.lanes[index].human) return;
    this.arena.input(index, input); this.checkpoint();
  }
  /** Retains unprocessed elapsed time; a slow renderer does not discard world time. */
  advance(elapsedMs: number) {
    if (!this.running || this.cursor >= 0) return;
    this.remainder += Math.max(0, elapsedMs);
    let steps = 0;
    while (this.remainder >= STEP_MS && steps < 250) {
      this.remainder -= STEP_MS; steps++;
      this.arena.tick();
      if (this.arena.clockMs - this.lastSnapshotAt >= 200) { this.history.push(snapshot(this.pair)); this.lastSnapshotAt = this.arena.clockMs; }
    }
    if (this.arena.lanes.every(l => l.game.status === "over")) this.pause();
  }
  /** Caller sends these asynchronously. Missing BYOK prevents Jev tickets only. */
  requests(hasKey: boolean): Ticket[] {
    if (!this.running || this.cursor >= 0) return [];
    this.hasKey = hasKey; this.arena.askDue();
    const tickets = this.outbox.splice(0);
    if (tickets.length) this.checkpoint();
    return tickets;
  }
  receive(ticket: Ticket, answer: string | undefined, latencyMs: number, error?: string, response?: unknown, httpStatus?: number) {
    const event = this.events.find(e => e.id === ticket.id);
    if (ticket.epoch !== this.epoch || this.arena.lanes[ticket.lane].pending?.question.id !== ticket.question || !event || event.status !== "pending") return "cancelled";
    const valid = !error && typeof answer === "string" && Object.hasOwn(ticket.options, answer);
    const status = this.arena.deliver(ticket.lane, ticket.question, valid ? { choice: answer, latencyMs } : { error: error ?? "No valid choice returned", latencyMs });
    const entry = this.arena.log.find(e => e.questionId === ticket.question);
    event.receivedAt = this.arena.clockMs; event.resolvedAt = this.arena.clockMs; event.latencyMs = latencyMs; event.answer = answer;
    if (response !== undefined) event.response = immutableCopy(response);
    if (httpStatus !== undefined) event.httpStatus = httpStatus;
    event.status = STATUS[status];
    if (entry?.reason !== undefined) event.reason = REASON[entry.reason] ?? entry.reason;
    this.checkpoint(); return event.status;
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
    this.preserve(`Before branch ${this.saved.length + 1}`); this.load(selected);
    this.cursor = -1; this.epoch++; this.remainder = 0;
    for (const l of this.arena.lanes) { l.nextRequestAt = this.arena.clockMs; l.revision++; }
    this.lastSnapshotAt = this.arena.clockMs; this.history = [snapshot(this.pair)]; this.events = [];
  }
  compareFrom(index: number) {
    this.branch();
    const source = this.arena.lanes[index], game = cloneGame(source.game), pieceStartedAt = source.pieceStartedAt;
    // An explicit fresh-controller comparison preserves the chosen physical world,
    // including its score, RNG and queue. Old trajectories remain in saved runs.
    for (const lane of this.arena.lanes) {
      lane.game = cloneGame(game); lane.plan = null; lane.stats = laneStats();
      lane.trackedPieceId = game.pieceId; lane.pieceStartedAt = pieceStartedAt;
      lane.control = lane.human ? "human" : "gravity";
    }
    this.history = [snapshot(this.pair)];
  }
  slowReplyDemo() {
    this.compareFrom(0);
    this.arena.lanes.forEach((lane, index) => {
      lane.settings = { framing: "landing", assisted: index === 0, intervalMs: 900, fallbackWaitMs: 700 };
      this.sources[index] = { source: "local", delayMs: 1200 };
      lane.human = false; lane.control = "gravity";
    });
    this.history = [snapshot(this.pair)];
  }
  restore(id: number) {
    const run = this.saved.find(r => r.id === id); if (!run) return;
    this.preserve(`Before restoring ${id}`); this.load(run.tail);
    this.history = run.history.map(snapshot); this.events = structuredClone(run.events);
    this.cursor = -1; this.epoch++; this.remainder = 0; this.lastSnapshotAt = this.arena.clockMs;
    for (const l of this.arena.lanes) l.nextRequestAt = this.arena.clockMs;
    this.checkpoint();
  }
  restart(seed: number) {
    const settings = [this.settingsOf(0), this.settingsOf(1)];
    this.preserve(`Completed run ${this.saved.length + 1}`);
    this.start(seed, settings);
    this.history = [snapshot(this.pair)]; this.events = []; this.cursor = -1; this.remainder = 0; this.lastSnapshotAt = 0; this.epoch++;
  }
  export() { return { format: "jev-live-tetris-v1", simplifiedRules: true, current: this.pair, history: this.history, events: this.events, saved: this.saved }; }
}
