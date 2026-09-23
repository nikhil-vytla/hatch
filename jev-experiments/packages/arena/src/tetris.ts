/**
 * N copies of the same Tetris world, one decision-maker per copy.
 *
 * Real time: every lane shares one world clock (20 ms steps). A lane asks
 * "which reachable landing?" when its previous question resolves; the answer
 * lands when the lane's contestant delivers it, and gravity keeps going while
 * it waits. Lane mechanics mirror live-worlds/tetris/session.ts so recorded
 * live runs replay exactly.
 *
 * Turns: the world waits. Every lane places piece N before any lane sees
 * piece N+1, so only choice quality differs.
 */
import { advanceGame, chooseLanding, command, createGame, landings, STEP_MS, type Game, type Landing, type Pose } from "../../../live-worlds/tetris/engine";
import { DECISION_INSTRUCTIONS } from "../../../live-worlds/tetris/session";

export type TimingMode = "realtime" | "turns";
export type Source = "recorded" | "live" | "code";
export type Probabilities = Record<string, number>;
export type Answer = { choice: string; probabilities?: Probabilities; confidence?: number | null; latencyMs?: number } | { error: string; latencyMs?: number };

export type Question = {
  id: string; lane: number; pieceId: number; sentAt: number;
  state: {
    rules: string; board: string[]; active: Pose; pieceId: number; next: string[];
    score: number; lines: number; level: number; worldMs: number;
  };
  options: Landing[];
  request: { state: Question["state"]; questions: { decision: { type: "choice"; instructions: string; criteria: Record<string, string> } } };
};

/** A scheduled answer lands at a world time. A promise lands when it resolves. */
export type Reply = { receiveAt: number; answer: Answer } | { missing: string } | Promise<Answer>;

export type Contestant = {
  id: string; name: string; source: Source;
  /** Real time only: may hold a question until a recorded send time. */
  readyToAsk?(lane: number, clockMs: number): boolean;
  /** Re-ask about a piece every interval even after an answer was used (the original live protocol). */
  reask?: boolean;
  ask(question: Question, mode: TimingMode): Reply;
};

export type DecisionStatus = "pending" | "applied" | "stale" | "failed" | "missing" | "cancelled";
export type LogEntry = {
  seq: number; lane: number; contestant: string; source: Source; questionId: string; pieceId: number;
  sentAt: number; resolvedAt?: number; latencyMs?: number; status: DecisionStatus; reason?: string;
  choice?: string; probabilities?: Probabilities; confidence?: number | null; optionCount: number;
};

type Plan = { pieceId: number; target: string; expires: number; nextAt: number };
type Pending = { question: Question; entry: LogEntry; receiveAt?: number; answer?: Answer };
export type Lane = {
  contestant: Contestant; game: Game; plan: Plan | null; pending: Pending | null;
  nextRequestAt: number; trackedPieceId: number; pieceStartedAt: number; revision: number;
  stats: { applied: number; stale: number; failed: number; missing: number; latencyMs: number[] };
  recordingEnded: number | null;
  missingPiece: number | null;
  answeredPiece: number | null;
};

const RULES = "10 columns, 20 rows; gravity continues while you decide; choose one option. Every candidate landing is reachable in the observed state. Code executes a chosen landing route. Intent delegates landing search to a code planner.";
const INTERVAL_MS = 900, DEADLINE_MS = 5000, PLAN_MS = 5000, MOVE_MS = 80;

export function optionCriteria(options: Landing[]) {
  return Object.fromEntries(options.map((o) => [o.id, JSON.stringify({ cells: o.id, clears: o.features.lines, buriedEmptyCells: o.features.holes, highestColumn: o.features.height, totalColumnHeight: o.features.aggregateHeight, unevenness: o.features.bumpiness, topOut: o.features.topOut, inputCount: o.path.length })]));
}

export function observe(game: Game, clockMs: number): Question["state"] {
  return { rules: RULES, board: game.board.map((row) => row.map((v) => (v ? "#" : ".")).join("")), active: game.active, pieceId: game.pieceId, next: game.queue.slice(0, 3), score: game.score, lines: game.lines, level: game.level, worldMs: clockMs };
}

export class TetrisArena {
  clockMs = 0;
  lanes: Lane[];
  log: LogEntry[] = [];
  private serial = 0;
  private remainder = 0;
  private started = false;
  /** Lanes stop placing pieces at this count, so every lane is compared over the same game length. */
  pieceLimit = Infinity;
  constructor(public seed: number, contestants: Contestant[], public mode: TimingMode = "realtime", options: { pieceLimit?: number } = {}) {
    if (options.pieceLimit) this.pieceLimit = options.pieceLimit;
    this.lanes = contestants.map((contestant) => {
      const game = createGame(seed);
      return { contestant, game, plan: null, pending: null, nextRequestAt: 0, trackedPieceId: game.pieceId, pieceStartedAt: 0, revision: 0, stats: { applied: 0, stale: 0, failed: 0, missing: 0, latencyMs: [] }, recordingEnded: null, missingPiece: null, answeredPiece: null };
    });
  }
  /** A lane stops at game over, at the piece limit, or where its recording ends (no loss is invented past the data). */
  finished(lane: Lane) { return lane.game.status === "over" || lane.game.pieces >= this.pieceLimit || lane.recordingEnded !== null; }
  get over() { return this.lanes.every((l) => this.finished(l)); }

  private question(index: number): Question | null {
    const lane = this.lanes[index], g = lane.game, options = landings(g);
    if (!options.length) return null;
    const state = observe(g, this.clockMs);
    const criteria = optionCriteria(options);
    return { id: `${index}:${++this.serial}`, lane: index, pieceId: g.pieceId, sentAt: this.clockMs, state, options, request: structuredClone({ state, questions: { decision: { type: "choice", instructions: DECISION_INSTRUCTIONS.landing, criteria } } }) };
  }
  private record(lane: number, q: Question): LogEntry {
    const c = this.lanes[lane].contestant;
    const entry: LogEntry = { seq: this.log.length + 1, lane, contestant: c.id, source: c.source, questionId: q.id, pieceId: q.pieceId, sentAt: q.sentAt, status: "pending", optionCount: q.options.length };
    this.log.push(entry);
    return entry;
  }
  private resolve(lane: Lane, entry: LogEntry, status: DecisionStatus, extra: Partial<LogEntry> = {}) {
    Object.assign(entry, { status, resolvedAt: this.clockMs, ...extra });
    if (status === "applied") lane.stats.applied++;
    else if (status === "stale") lane.stats.stale++;
    else if (status === "failed") lane.stats.failed++;
    else if (status === "missing") lane.stats.missing++;
    if (extra.latencyMs !== undefined && status !== "missing") lane.stats.latencyMs.push(extra.latencyMs);
  }

  // ---------- real time ----------
  /** Retains unprocessed time so a slow renderer never drops world time. */
  advance(elapsedMs: number) {
    if (this.mode !== "realtime") return;
    this.remainder += Math.max(0, elapsedMs);
    let steps = 0;
    while (this.remainder >= STEP_MS && steps < 250 && !this.over) { this.remainder -= STEP_MS; this.step(); steps++; }
  }
  step() {
    // The first question goes out at world time 0, before gravity moves anything.
    if (!this.started) { this.started = true; this.lanes.forEach((_, i) => this.maybeAsk(i)); }
    this.clockMs += STEP_MS;
    this.lanes.forEach((_, i) => this.stepLane(i));
    this.lanes.forEach((_, i) => this.maybeAsk(i));
    this.lanes.forEach((lane) => { const p = lane.pending; if (p && p.answer && p.receiveAt !== undefined && p.receiveAt <= this.clockMs) this.receive(lane, p); });
  }
  private track(lane: Lane) {
    if (lane.trackedPieceId !== lane.game.pieceId) {
      lane.trackedPieceId = lane.game.pieceId; lane.pieceStartedAt = this.clockMs;
      if (lane.plan?.pieceId !== lane.game.pieceId) lane.plan = null;
    }
  }
  private stepLane(i: number) {
    const lane = this.lanes[i], g = lane.game, now = this.clockMs;
    this.track(lane);
    if (this.finished(lane)) return;
    if (lane.plan && (lane.plan.pieceId !== g.pieceId || lane.plan.expires < now)) lane.plan = null;
    const p = lane.plan;
    if (p && now >= p.nextAt) {
      p.nextAt = now + MOVE_MS;
      // Regenerate the route from the moving piece, not from the old observation.
      const target = landings(g).find((o) => o.id === p.target);
      if (target) command(g, target.path[0]); else lane.plan = null;
    }
    advanceGame(g, STEP_MS);
    this.track(lane);
  }
  private maybeAsk(i: number) {
    const lane = this.lanes[i];
    if (lane.pending || this.finished(lane) || this.clockMs < lane.nextRequestAt) return;
    if (!lane.contestant.reask && lane.answeredPiece === lane.game.pieceId) return;
    // A contestant without an answer for this piece is asked again only for the next piece.
    if (lane.missingPiece === lane.game.pieceId) return;
    if (lane.contestant.readyToAsk && !lane.contestant.readyToAsk(i, this.clockMs)) return;
    const q = this.question(i);
    if (!q) return;
    const entry = this.record(i, q);
    lane.nextRequestAt = this.clockMs + INTERVAL_MS;
    const pending: Pending = { question: q, entry };
    lane.pending = pending;
    const reply = lane.contestant.ask(q, "realtime");
    if (reply instanceof Promise) {
      const revision = lane.revision;
      reply.then((answer) => { if (lane.pending === pending && lane.revision === revision) { pending.answer = answer; pending.receiveAt = this.clockMs; this.receive(lane, pending); } },
        (error) => { if (lane.pending === pending && lane.revision === revision) { pending.answer = { error: String(error?.message ?? error) }; pending.receiveAt = this.clockMs; this.receive(lane, pending); } });
    } else if ("missing" in reply) {
      lane.pending = null; lane.missingPiece = q.pieceId;
      if (lane.recordingEnded === null) lane.recordingEnded = q.pieceId;
      this.resolve(lane, entry, "missing", { reason: reply.missing });
    } else {
      pending.answer = reply.answer; pending.receiveAt = reply.receiveAt;
      if (reply.receiveAt <= this.clockMs) this.receive(lane, pending);
    }
  }
  private receive(lane: Lane, p: Pending) {
    lane.pending = null;
    const a = p.answer!, q = p.question, latencyMs = a.latencyMs ?? this.clockMs - q.sentAt;
    if ("error" in a) return this.resolve(lane, p.entry, "failed", { reason: a.error, latencyMs });
    const common = { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence, latencyMs };
    if (!q.options.some((o) => o.id === a.choice)) return this.resolve(lane, p.entry, "failed", { ...common, reason: "Answer is not one of the offered landings" });
    if (lane.game.status !== "playing" || lane.game.pieceId !== q.pieceId) return this.resolve(lane, p.entry, "stale", { ...common, reason: "The piece locked before the answer arrived" });
    if (this.clockMs - q.sentAt > DEADLINE_MS) return this.resolve(lane, p.entry, "stale", { ...common, reason: "Answer arrived after its useful window" });
    const target = landings(lane.game).find((o) => o.id === a.choice);
    if (!target) return this.resolve(lane, p.entry, "stale", { ...common, reason: "The chosen landing is no longer reachable" });
    lane.plan = { pieceId: q.pieceId, target: target.id, expires: this.clockMs + PLAN_MS, nextAt: this.clockMs };
    lane.answeredPiece = q.pieceId;
    this.resolve(lane, p.entry, "applied", common);
  }
  /** Ends a run the way the recorder did: in-flight questions become cancelled. */
  stop() {
    for (const lane of this.lanes) if (lane.pending) { this.resolve(lane, lane.pending.entry, "cancelled", { reason: "Run stopped" }); lane.pending = null; lane.revision++; }
  }

  // ---------- turns ----------
  /** Places the current piece on every live lane. Resolves once every contestant has answered. */
  async turn(): Promise<void> {
    if (this.mode !== "turns") return;
    const asks = this.lanes.map(async (lane, i) => {
      if (this.finished(lane)) return;
      const q = this.question(i);
      if (!q) return;
      const entry = this.record(i, q);
      const reply = lane.contestant.ask(q, "turns");
      let answer: Answer | null = null, missing: string | null = null;
      if (reply instanceof Promise) answer = await reply.catch((e) => ({ error: String(e?.message ?? e) }));
      else if ("missing" in reply) missing = reply.missing;
      else answer = reply.answer;
      return { lane, q, entry, answer, missing };
    });
    for (const r of await Promise.all(asks)) {
      if (!r) continue;
      const { lane, q, entry, answer, missing } = r;
      if (missing !== null) {
        if (lane.recordingEnded === null) lane.recordingEnded = q.pieceId;
        this.resolve(lane, entry, "missing", { reason: missing });
        command(lane.game, "drop");
        continue;
      }
      if ("error" in answer!) { this.resolve(lane, entry, "failed", { reason: answer!.error, latencyMs: answer!.latencyMs }); command(lane.game, "drop"); continue; }
      const target = q.options.find((o) => o.id === (answer as any).choice);
      if (!target) { this.resolve(lane, entry, "failed", { reason: "Answer is not one of the offered landings", choice: (answer as any).choice }); command(lane.game, "drop"); continue; }
      for (const input of target.path) command(lane.game, input);
      this.resolve(lane, entry, "applied", { choice: target.id, probabilities: (answer as any).probabilities, confidence: (answer as any).confidence, latencyMs: answer!.latencyMs });
    }
  }
}

// ---------- contestants ----------
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

/** A code planner answering after a fixed world-time delay. */
export function heuristic(delayMs = 0, name = delayMs ? `Code planner · ${delayMs} ms` : "Code planner"): Contestant {
  return {
    id: `heuristic-${delayMs}`, name, source: "code",
    ask(q) { const pick = chooseLanding(q.options)!; return { receiveAt: q.sentAt + delayMs, answer: { choice: pick.id, probabilities: { [pick.id]: 1 }, latencyMs: delayMs } }; },
  };
}

/** Uniform over reachable landings; seeded so runs repeat. */
export function randomPlayer(seed = 1, delayMs = 0): Contestant {
  return {
    id: "random", name: "Random landing", source: "code",
    ask(q) {
      const r = rng(seed * 7919 + q.pieceId * 104729)();
      const pick = q.options[Math.floor(r * q.options.length)];
      return { receiveAt: q.sentAt + delayMs, answer: { choice: pick.id, probabilities: Object.fromEntries(q.options.map((o) => [o.id, 1 / q.options.length])), latencyMs: delayMs } };
    },
  };
}

export type RecordedEvent = {
  lane: number; sentAt: number; receivedAt?: number; resolvedAt?: number; latencyMs?: number; pieceId: number;
  status: string; answer?: string; reason?: string; state: Question["state"]; response?: any;
};

const sameWorld = (a: Question["state"], b: Question["state"], includeTime: boolean) =>
  a.pieceId === b.pieceId && a.score === b.score && a.lines === b.lines && JSON.stringify(a.board) === JSON.stringify(b.board) &&
  JSON.stringify(a.active) === JSON.stringify(b.active) && JSON.stringify(a.next) === JSON.stringify(b.next) && (!includeTime || a.worldMs === b.worldMs);

const sameDecision = (a: Question["state"], b: Question["state"]) =>
  a.pieceId === b.pieceId && a.active.type === b.active.type && JSON.stringify(a.board) === JSON.stringify(b.board) && JSON.stringify(a.next) === JSON.stringify(b.next);

/**
 * Replays one recorded lane. A recorded answer is used only for the exact
 * world it was recorded against; otherwise the recording has ended.
 */
export function recorded(events: RecordedEvent[], name = "Jev · recorded", id = "jev-recorded"): Contestant {
  const queue = [...events].sort((a, b) => a.sentAt - b.sentAt);
  const toAnswer = (e: RecordedEvent): Answer => {
    const d = e.response?.answers?.decision;
    if (e.status === "failed" || typeof e.answer !== "string") return { error: e.reason ?? "Provider failure in the recording", latencyMs: e.latencyMs };
    return { choice: e.answer, probabilities: d?.probabilities, confidence: d?.confidence ?? null, latencyMs: e.latencyMs };
  };
  return {
    id, name, source: "recorded", reask: true,
    readyToAsk(_lane, clockMs) {
      const next = queue.find((e) => e.sentAt >= clockMs);
      return next ? next.sentAt === clockMs : true;
    },
    ask(q, mode) {
      if (mode === "realtime") {
        const e = queue.find((x) => x.sentAt === q.sentAt);
        if (!e) return { missing: "The recording has no answer for this moment" };
        if (!sameWorld(e.state, q.state, true)) return { missing: "This board differs from the recorded one" };
        // Sent but never answered before the recording stopped: it stays in flight until the run stops.
        if (e.status === "cancelled" || e.receivedAt === undefined) return { receiveAt: Number.POSITIVE_INFINITY, answer: { error: "Cancelled when the recording stopped" } };
        return { receiveAt: e.receivedAt, answer: toAnswer(e) };
      }
      // Turns ask at spawn; the live recording asked mid-fall. A landing is a final resting
      // place, so the same stack, piece and queue is the same decision.
      const e = queue.find((x) => x.status === "accepted" && sameDecision(x.state, q.state) && q.options.some((o) => o.id === x.answer));
      return e ? { receiveAt: q.sentAt, answer: toAnswer(e) } : { missing: "No recorded answer for this exact stack and piece" };
    },
  };
}

/** A hosted contestant; the caller supplies the transport (e.g. the site's /api/evaluate with a visitor key). */
export function live(name: string, id: string, send: (request: Question["request"], signal?: AbortSignal) => Promise<{ answers: { decision: { value: string; probabilities?: Probabilities; confidence?: number } } }>): Contestant {
  return {
    id, name, source: "live",
    ask(q) {
      const started = performance.now();
      return send(q.request).then((r) => ({ choice: r.answers.decision.value, probabilities: r.answers.decision.probabilities, confidence: r.answers.decision.confidence ?? null, latencyMs: performance.now() - started }));
    },
  };
}
