/**
 * The Tetris lane: one world clock, N copies of the same game, one decision-maker per copy.
 * Both the arena boards and the live Tetris page (live-worlds/tetris/session.ts) run on this
 * module, so a recorded run replays exactly wherever it was recorded.
 *
 * Real time: every lane shares one world clock (20 ms steps). A lane asks its contestant about
 * the falling piece when its previous question resolves and its request interval has passed;
 * the answer lands when the contestant delivers it, and gravity keeps going while it waits. A
 * lane may also be played by hand, or fall back to the code planner after a wait.
 *
 * Turns: the world waits. Every lane places piece N before any lane sees
 * piece N+1, so only choice quality differs.
 */
import {
  advanceGame,
  chooseLanding,
  command,
  createGame,
  landings,
  lcg,
  STEP_MS,
  type Command,
  type Game,
  type Intent,
  type Landing,
  type Pose,
} from "./tetris-engine";

export type TimingMode = "realtime" | "turns";

export type Source = "recorded" | "live" | "code";

/** What a lane asks for: a reachable landing, one short control, or the code planner's objective. */
export type Framing = "landing" | "button" | "intent";

export const DECISION_INSTRUCTIONS: Record<Framing, string> = {
  button:
    "Choose one short control for the falling piece. Rotations and hard drop happen once; left/right/soft drop repeat for 240ms. Gravity continues. Prefer moves that avoid holes and complete rows. The answer expires after 300ms of world time.",
  landing:
    "Choose a reachable landing for this piece. Candidate features are computed by code after line clearing. Avoid top-out and buried empty cells, keep the stack low, and clear lines. Code will execute the route to your chosen landing if it remains reachable.",
  intent:
    "Choose the code planner's objective for this piece. You choose a policy, not a landing or direct control. Code searches reachable landings and follows the selected objective.",
};

/** How a lane asks and what code does between answers. */
export type LaneSettings = {
  framing: Framing;
  /** World time between request starts. */
  intervalMs: number;
  /** Without a usable plan, the code planner takes over once a piece is this old. */
  assisted: boolean;
  fallbackWaitMs: number;
};

const ARENA_SETTINGS: LaneSettings = {
  framing: "landing",
  intervalMs: 900,
  assisted: false,
  fallbackWaitMs: 700,
};

export type Probabilities = Record<string, number>;

export type Answer =
  | {
      choice: string;
      probabilities?: Probabilities;
      confidence?: number | null;
      latencyMs?: number;
    }
  | { error: string; latencyMs?: number; retryAfterMs?: number };

export type Question = {
  id: string;
  lane: number;
  pieceId: number;
  sentAt: number;
  framing: Framing;
  state: {
    rules: string;
    board: string[];
    active: Pose;
    pieceId: number;
    next: string[];
    score: number;
    lines: number;
    level: number;
    worldMs: number;
  };
  options: Landing[];
  request: {
    state: Question["state"];
    questions: {
      decision: { type: "choice"; instructions: string; criteria: Record<string, string> };
    };
  };
};

/**
 * A scheduled answer lands at a world time. A promise lands when it resolves. In real time,
 * `later` means the caller hands the answer over with `deliver()` (the live page's own request loop).
 */
export type Reply =
  | { receiveAt: number; answer: Answer }
  | { missing: string }
  | { later: true }
  | Promise<Answer>;

export type Contestant = {
  id: string;
  name: string;
  source: Source;
  /** Real time only: may hold a question until a recorded send time. */
  readyToAsk?(lane: number, clockMs: number): boolean;
  /** Re-ask about a piece every interval even after an answer was used (the original live protocol). */
  reask?: boolean;
  /** After a failure: "backoff" (default) doubles the wait up to 4 s; "fixed" re-asks after 400 ms, as the first real-time recordings did. */
  retryPolicy?: "backoff" | "fixed";
  /** The signal aborts a live request whose answer can no longer be used. */
  ask(question: Question, mode: TimingMode, signal?: AbortSignal): Reply;
};

export type DecisionStatus = "pending" | "applied" | "stale" | "failed" | "missing" | "cancelled";

export type LogEntry = {
  seq: number;
  lane: number;
  contestant: string;
  source: Source;
  questionId: string;
  pieceId: number;
  sentAt: number;
  resolvedAt?: number;
  latencyMs?: number;
  status: DecisionStatus;
  reason?: string;
  choice?: string;
  probabilities?: Probabilities;
  confidence?: number | null;
  optionCount: number;
};

/** Who moves the piece: a hand, gravity alone, the code fallback, or a contestant's plan. */
export type Control = "human" | "gravity" | "fallback" | "over" | Source;

/** Code follows a chosen landing's route, or repeats one short control. */
export type Plan = {
  pieceId: number;
  origin: Source | "fallback";
  target?: string;
  action?: Command;
  expires: number;
  nextAt: number;
  intent?: Intent;
  used?: boolean;
};

type Pending = {
  question: Question;
  entry: LogEntry;
  receiveAt?: number;
  answer?: Answer;
  abort?: AbortController;
};

export type LaneStats = {
  applied: number;
  stale: number;
  failed: number;
  missing: number;
  cancelled: number;
  latencyMs: number[];
  /** World time under each kind of control. */
  controlMs: Record<Exclude<Control, "over">, number>;
};

export type Lane = {
  contestant: Contestant;
  game: Game;
  settings: LaneSettings;
  /** Played by hand: no questions, no plans; `input()` moves the piece. */
  human: boolean;
  control: Control;
  plan: Plan | null;
  pending: Pending | null;
  nextRequestAt: number;
  trackedPieceId: number;
  pieceStartedAt: number;
  revision: number;
  stats: LaneStats;
  recordingEnded: number | null;
  missingPiece: number | null;
  answeredPiece: number | null;
  /** Consecutive failed requests, for backing off. */
  failures: number;
};

export const laneStats = (): LaneStats => ({
  applied: 0,
  stale: 0,
  failed: 0,
  missing: 0,
  cancelled: 0,
  latencyMs: [],
  controlMs: { human: 0, gravity: 0, fallback: 0, recorded: 0, live: 0, code: 0 },
});

const RULES =
  "10 columns, 20 rows; gravity continues while you decide; choose one option. Every candidate landing is reachable in the observed state. Code executes a chosen landing route. Intent delegates landing search to a code planner.";

const DEADLINE_MS = 5000,
  PLAN_MS = 5000,
  BUTTON_DEADLINE_MS = 300,
  BUTTON_MS = 240,
  FALLBACK_START_MS = 160,
  FALLBACK_PLAN_MS = 10000,
  MOVE_MS = 80,
  RETRY_MS = 400,
  RETRY_CAP_MS = 4000;

const BUTTONS = {
  left: "Hold left briefly",
  right: "Hold right briefly",
  cw: "Rotate clockwise once",
  ccw: "Rotate counterclockwise once",
  soft: "Hold soft drop briefly",
  drop: "Hard drop and lock now",
  wait: "Let gravity act",
} satisfies Partial<Record<Command, string>>;

const INTENTS = {
  clear_lines: "Code planner favors immediate cleared lines",
  keep_low: "Code planner favors lower total column height",
  avoid_holes: "Code planner strongly penalizes buried empty cells",
} satisfies Record<Intent, string>;

const REPEATING: Command[] = ["left", "right", "soft"];

export function optionCriteria(options: Landing[]) {
  return Object.fromEntries(
    options.map((o) => [
      o.id,
      JSON.stringify({
        cells: o.id,
        clears: o.features.lines,
        buriedEmptyCells: o.features.holes,
        highestColumn: o.features.height,
        totalColumnHeight: o.features.aggregateHeight,
        unevenness: o.features.bumpiness,
        topOut: o.features.topOut,
        inputCount: o.path.length,
      }),
    ]),
  );
}

const criteriaFor = (framing: Framing, options: Landing[]) =>
  framing === "button" ? BUTTONS : framing === "intent" ? INTENTS : optionCriteria(options);

/** The answer code would give: the planner's landing, its first input, or its default objective. */
export function suggestion(framing: Framing, options: Landing[]) {
  const best = chooseLanding(options);

  return framing === "button" ? best.path[0] : framing === "intent" ? "avoid_holes" : best.id;
}

export function observe(game: Game, clockMs: number): Question["state"] {
  return {
    rules: RULES,
    board: game.board.map((row) => row.map((v) => (v ? "#" : ".")).join("")),
    active: game.active,
    pieceId: game.pieceId,
    next: game.queue.slice(0, 3),
    score: game.score,
    lines: game.lines,
    level: game.level,
    worldMs: clockMs,
  };
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
  constructor(
    public seed: number,
    contestants: Contestant[],
    public mode: TimingMode = "realtime",
    options: { pieceLimit?: number; settings?: (lane: number) => LaneSettings } = {},
  ) {
    if (options.pieceLimit) this.pieceLimit = options.pieceLimit;
    this.lanes = contestants.map((contestant, i) => {
      const game = createGame(seed);

      return {
        contestant,
        game,
        settings: options.settings?.(i) ?? { ...ARENA_SETTINGS },
        human: false,
        control: "gravity",
        plan: null,
        pending: null,
        nextRequestAt: 0,
        trackedPieceId: game.pieceId,
        pieceStartedAt: 0,
        revision: 0,
        stats: laneStats(),
        recordingEnded: null,
        missingPiece: null,
        answeredPiece: null,
        failures: 0,
      };
    });
  }
  /** A lane stops at game over, at the piece limit, or where its recording ends (no loss is invented past the data). */
  finished(lane: Lane) {
    return (
      lane.game.status === "over" ||
      lane.game.pieces >= this.pieceLimit ||
      lane.recordingEnded !== null
    );
  }
  get over() {
    return this.lanes.every((l) => this.finished(l));
  }

  private question(index: number): Question | null {
    const lane = this.lanes[index],
      g = lane.game,
      framing = lane.settings.framing,
      options = landings(g);

    if (!options.length) return null;
    const state = observe(g, this.clockMs);
    const criteria = criteriaFor(framing, options);

    return {
      id: `${index}:${++this.serial}`,
      lane: index,
      pieceId: g.pieceId,
      sentAt: this.clockMs,
      framing,
      state,
      options,
      request: structuredClone({
        state,
        questions: {
          decision: { type: "choice", instructions: DECISION_INSTRUCTIONS[framing], criteria },
        },
      }),
    };
  }
  private record(lane: number, q: Question): LogEntry {
    const c = this.lanes[lane].contestant;

    const entry: LogEntry = {
      seq: this.log.length + 1,
      lane,
      contestant: c.id,
      source: c.source,
      questionId: q.id,
      pieceId: q.pieceId,
      sentAt: q.sentAt,
      status: "pending",
      optionCount: q.options.length,
    };

    this.log.push(entry);

    return entry;
  }
  private resolve(
    lane: Lane,
    entry: LogEntry,
    status: DecisionStatus,
    extra: Partial<LogEntry> = {},
  ): DecisionStatus {
    Object.assign(entry, { status, resolvedAt: this.clockMs, ...extra });

    if (status === "applied") lane.stats.applied++;
    else if (status === "stale") lane.stats.stale++;
    else if (status === "failed") lane.stats.failed++;
    else if (status === "missing") lane.stats.missing++;
    else if (status === "cancelled") lane.stats.cancelled++;

    // Median answer time counts answers that were used, not failed attempts.
    if (extra.latencyMs !== undefined && status === "applied")
      lane.stats.latencyMs.push(extra.latencyMs);

    return status;
  }

  // ---------- real time ----------
  /** Retains unprocessed time so a slow renderer never drops world time. */
  advance(elapsedMs: number) {
    if (this.mode !== "realtime") return;
    this.remainder += Math.max(0, elapsedMs);
    let steps = 0;

    while (this.remainder >= STEP_MS && steps < 250 && !this.over) {
      this.remainder -= STEP_MS;
      this.step();
      steps++;
    }
  }
  /** One world step: lanes move, due lanes ask, and scheduled answers land. */
  step() {
    // The first question goes out at world time 0, before gravity moves anything.
    if (!this.started) {
      this.started = true;
      this.askDue();
    }

    this.tick();
    this.askDue();
    this.lanes.forEach((lane) => {
      const p = lane.pending;

      if (p && p.answer && p.receiveAt !== undefined && p.receiveAt <= this.clockMs)
        this.receive(lane, p, p.answer);
    });
  }
  /** Moves every lane one step of world time, without asking anything. */
  tick() {
    this.clockMs += STEP_MS;
    this.lanes.forEach((_, i) => this.stepLane(i));
  }
  /** Asks every lane's contestant that is due a question now. */
  askDue() {
    this.lanes.forEach((_, i) => this.maybeAsk(i));
  }
  private track(lane: Lane) {
    if (lane.trackedPieceId !== lane.game.pieceId) {
      lane.trackedPieceId = lane.game.pieceId;
      lane.pieceStartedAt = this.clockMs;

      if (lane.plan?.pieceId !== lane.game.pieceId) lane.plan = null;
      lane.control = lane.human ? "human" : "gravity";
    }

    if (lane.game.status === "over") lane.control = "over";
  }
  private stepLane(i: number) {
    const lane = this.lanes[i],
      g = lane.game,
      now = this.clockMs;

    this.track(lane);

    if (this.finished(lane)) return;

    if (lane.plan && (lane.plan.pieceId !== g.pieceId || lane.plan.expires < now)) lane.plan = null;

    if (
      !lane.human &&
      !lane.plan &&
      lane.settings.assisted &&
      now - lane.pieceStartedAt >= lane.settings.fallbackWaitMs
    ) {
      const pick = chooseLanding(landings(g));

      if (pick)
        lane.plan = {
          pieceId: g.pieceId,
          origin: "fallback",
          target: pick.id,
          expires: now + FALLBACK_PLAN_MS,
          nextAt: now + FALLBACK_START_MS,
        };
    }

    const p = lane.human ? null : lane.plan;
    lane.control = lane.human ? "human" : p ? p.origin : "gravity";
    lane.stats.controlMs[lane.control] += STEP_MS;

    if (p && now >= p.nextAt) {
      p.nextAt = now + MOVE_MS;

      if (p.target) {
        // Regenerate the route from the moving piece, not from the old observation.
        const target = landings(g).find((o) => o.id === p.target);

        if (target) command(g, target.path[0]);
        else lane.plan = null;
      } else if (p.action) {
        if (REPEATING.includes(p.action) || !p.used) command(g, p.action);
        p.used = true;
      }
    }

    advanceGame(g, STEP_MS);
    this.track(lane);
    this.supersede(lane);
  }
  /** A hand on the controls: one input on a lane played by hand. */
  input(index: number, input: Command) {
    const lane = this.lanes[index];

    command(lane.game, input);
    this.track(lane);
  }
  /**
   * An answer for a piece that has already locked can never be used. Drop it
   * now so the lane can ask about the new piece at once, rather than wait for
   * a reply that no longer matters. (The original live protocol waited; lanes
   * replaying it keep that behaviour.)
   */
  private supersede(lane: Lane) {
    const p = lane.pending;

    if (!p || lane.contestant.reask || p.question.pieceId === lane.game.pieceId) return;
    p.abort?.abort();
    lane.pending = null;
    lane.revision++;
    lane.nextRequestAt = this.clockMs;
    this.resolve(lane, p.entry, "stale", { reason: "The piece locked before the answer arrived" });
  }
  private maybeAsk(i: number) {
    const lane = this.lanes[i];

    if (lane.human || lane.pending || this.finished(lane) || this.clockMs < lane.nextRequestAt)
      return;

    if (!lane.contestant.reask && lane.answeredPiece === lane.game.pieceId) return;

    // A contestant without an answer for this piece is asked again only for the next piece.
    if (lane.missingPiece === lane.game.pieceId) return;

    if (lane.contestant.readyToAsk && !lane.contestant.readyToAsk(i, this.clockMs)) return;
    const q = this.question(i);

    if (!q) return;
    const entry = this.record(i, q);
    lane.nextRequestAt = this.clockMs + lane.settings.intervalMs;
    const abort = new AbortController();
    const pending: Pending = { question: q, entry, abort };
    lane.pending = pending;
    const reply = lane.contestant.ask(q, "realtime", abort.signal);

    if (reply instanceof Promise) {
      const revision = lane.revision;
      reply.then(
        (answer) => {
          if (lane.pending === pending && lane.revision === revision) {
            pending.answer = answer;
            pending.receiveAt = this.clockMs;
            this.receive(lane, pending, answer);
          }
        },
        (error) => {
          if (lane.pending === pending && lane.revision === revision) {
            const failure: Answer = { error: String(error?.message ?? error) };
            pending.answer = failure;
            pending.receiveAt = this.clockMs;
            this.receive(lane, pending, failure);
          }
        },
      );
    } else if ("later" in reply) {
      // The caller delivers the answer.
    } else if ("missing" in reply) {
      lane.pending = null;
      lane.missingPiece = q.pieceId;

      if (lane.recordingEnded === null) lane.recordingEnded = q.pieceId;
      this.resolve(lane, entry, "missing", { reason: reply.missing });
    } else {
      pending.answer = reply.answer;
      pending.receiveAt = reply.receiveAt;

      if (reply.receiveAt <= this.clockMs) this.receive(lane, pending, reply.answer);
    }
  }
  /** Hands over the answer to a question asked with a `later` reply. A question no longer in flight is "cancelled". */
  deliver(index: number, questionId: string, answer: Answer): DecisionStatus {
    const lane = this.lanes[index],
      p = lane.pending;

    if (!p || p.question.id !== questionId) return "cancelled";
    p.answer = answer;
    p.receiveAt = this.clockMs;

    return this.receive(lane, p, answer);
  }
  private receive(lane: Lane, p: Pending, a: Answer): DecisionStatus {
    lane.pending = null;

    const q = p.question,
      latencyMs = a.latencyMs ?? this.clockMs - q.sentAt;

    if ("error" in a) {
      // Back off 0.4, 0.8, 1.6, 3.2, then 4 s, and never stop asking. Rate limits often
      // suggest waiting 60 s; that would freeze the game, so a suggestion is used only when short.
      if (!lane.contestant.reask) {
        const backoff =
          lane.contestant.retryPolicy === "fixed"
            ? RETRY_MS
            : Math.min(RETRY_CAP_MS, RETRY_MS * 2 ** lane.failures);

        const suggested =
          lane.contestant.retryPolicy !== "fixed" &&
          a.retryAfterMs &&
          a.retryAfterMs <= RETRY_CAP_MS
            ? a.retryAfterMs
            : 0;

        lane.nextRequestAt = this.clockMs + Math.max(backoff, suggested);
        lane.failures++;
      }

      return this.resolve(lane, p.entry, "failed", { reason: a.error, latencyMs });
    }

    lane.failures = 0;

    const common = {
      choice: a.choice,
      probabilities: a.probabilities,
      confidence: a.confidence,
      latencyMs,
    };

    if (!Object.hasOwn(q.request.questions.decision.criteria, a.choice))
      return this.resolve(lane, p.entry, "failed", {
        ...common,
        reason: "Answer is not one of the offered landings",
      });

    if (lane.game.status !== "playing" || lane.game.pieceId !== q.pieceId)
      return this.resolve(lane, p.entry, "stale", {
        ...common,
        reason: "The piece locked before the answer arrived",
      });

    const button = q.framing === "button";

    if (this.clockMs - q.sentAt > (button ? BUTTON_DEADLINE_MS : DEADLINE_MS))
      return this.resolve(lane, p.entry, "stale", {
        ...common,
        reason: "Answer arrived after its useful window",
      });
    const origin = lane.contestant.source;

    if (button)
      lane.plan = {
        pieceId: q.pieceId,
        origin,
        // SAFETY: the choice is one of a button question's criteria keys (checked above), which are controls.
        action: a.choice as Command,
        expires: this.clockMs + BUTTON_MS,
        nextAt: this.clockMs,
      };
    else {
      const options = landings(lane.game),
        // SAFETY: an intent question's criteria keys are exactly the planner's objectives.
        intent = q.framing === "intent" ? (a.choice as Intent) : undefined;

      const target = intent
        ? chooseLanding(options, intent)
        : options.find((o) => o.id === a.choice);

      if (!target)
        return this.resolve(lane, p.entry, "stale", {
          ...common,
          reason: "The chosen landing is no longer reachable",
        });
      lane.plan = {
        pieceId: q.pieceId,
        origin,
        target: target.id,
        expires: this.clockMs + PLAN_MS,
        nextAt: this.clockMs,
        ...(intent && { intent }),
      };
    }

    lane.answeredPiece = q.pieceId;

    return this.resolve(lane, p.entry, "applied", common);
  }
  /** Drops a lane's question in flight; its answer can no longer land. */
  cancel(index: number, reason: string) {
    const lane = this.lanes[index];

    if (!lane.pending) return;
    lane.pending.abort?.abort();
    this.resolve(lane, lane.pending.entry, "cancelled", { reason });
    lane.pending = null;
  }
  /** Ends a run the way the recorder did: in-flight questions become cancelled. */
  stop() {
    this.lanes.forEach((lane, i) => {
      if (lane.pending) {
        this.cancel(i, "Run stopped");
        lane.revision++;
      }
    });
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

      let answer: Answer | null = null,
        missing: string | null = null;

      if (reply instanceof Promise)
        answer = await reply.catch((e) => ({ error: String(e?.message ?? e) }));
      else if ("missing" in reply) missing = reply.missing;
      else if ("answer" in reply) answer = reply.answer;

      return { lane, q, entry, answer, missing };
    });

    for (const r of await Promise.all(asks)) {
      if (!r) continue;
      const { lane, q, entry, answer, missing } = r;

      if (missing !== null || answer === null) {
        if (lane.recordingEnded === null) lane.recordingEnded = q.pieceId;
        this.resolve(lane, entry, "missing", { reason: missing ?? "No answer" });
        command(lane.game, "drop");
        continue;
      }

      if ("error" in answer) {
        this.resolve(lane, entry, "failed", {
          reason: answer.error,
          latencyMs: answer.latencyMs,
        });
        command(lane.game, "drop");
        continue;
      }

      const target = q.options.find((o) => o.id === answer.choice);

      if (!target) {
        this.resolve(lane, entry, "failed", {
          reason: "Answer is not one of the offered landings",
          choice: answer.choice,
        });
        command(lane.game, "drop");
        continue;
      }

      for (const input of target.path) command(lane.game, input);
      this.resolve(lane, entry, "applied", {
        choice: target.id,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        latencyMs: answer.latencyMs,
      });
    }
  }
}

// ---------- contestants ----------
/** A code planner answering after a fixed world-time delay. */
export function heuristic(
  delayMs = 0,
  name = delayMs ? `Code planner · ${delayMs} ms` : "Code planner",
): Contestant {
  return {
    id: `heuristic-${delayMs}`,
    name,
    source: "code",
    ask(q) {
      const pick = chooseLanding(q.options);

      if (!pick) throw new Error(`No reachable landing for piece ${q.pieceId}`);

      return {
        receiveAt: q.sentAt + delayMs,
        answer: { choice: pick.id, probabilities: { [pick.id]: 1 }, latencyMs: delayMs },
      };
    },
  };
}

/** Uniform over reachable landings; seeded so runs repeat. */
export function randomPlayer(seed = 1, delayMs = 0): Contestant {
  return {
    id: "random",
    name: "Random landing",
    source: "code",
    ask(q) {
      const r = lcg(seed * 7919 + q.pieceId * 104729) / 4294967296;
      const pick = q.options[Math.floor(r * q.options.length)];

      return {
        receiveAt: q.sentAt + delayMs,
        answer: {
          choice: pick.id,
          probabilities: Object.fromEntries(q.options.map((o) => [o.id, 1 / q.options.length])),
          latencyMs: delayMs,
        },
      };
    },
  };
}

export type RecordedEvent = {
  lane: number;
  sentAt: number;
  receivedAt?: number;
  resolvedAt?: number;
  latencyMs?: number;
  pieceId: number;
  status: string;
  answer?: string;
  reason?: string;
  state: Question["state"];
  response?: RecordedResponse;
};

/** The part of a recorded gateway response the replay reads. */
type RecordedResponse = {
  answers?: { decision?: { probabilities?: Probabilities; confidence?: number | null } };
};

const sameWorld = (a: Question["state"], b: Question["state"], includeTime: boolean) =>
  a.pieceId === b.pieceId &&
  a.score === b.score &&
  a.lines === b.lines &&
  JSON.stringify(a.board) === JSON.stringify(b.board) &&
  JSON.stringify(a.active) === JSON.stringify(b.active) &&
  JSON.stringify(a.next) === JSON.stringify(b.next) &&
  (!includeTime || a.worldMs === b.worldMs);

const sameDecision = (a: Question["state"], b: Question["state"]) =>
  a.pieceId === b.pieceId &&
  a.active.type === b.active.type &&
  JSON.stringify(a.board) === JSON.stringify(b.board) &&
  JSON.stringify(a.next) === JSON.stringify(b.next);

/**
 * Replays one recorded lane. A recorded answer is used only for the exact
 * world it was recorded against; otherwise the recording has ended.
 */
export function recorded(
  events: RecordedEvent[],
  name = "Jev · recorded",
  id = "jev-recorded",
): Contestant {
  const queue = [...events].sort((a, b) => a.sentAt - b.sentAt);

  const toAnswer = (e: RecordedEvent): Answer => {
    const d = e.response?.answers?.decision;

    if (e.status === "failed" || e.answer === undefined)
      return { error: e.reason ?? "Provider failure in the recording", latencyMs: e.latencyMs };

    return {
      choice: e.answer,
      probabilities: d?.probabilities,
      confidence: d?.confidence ?? null,
      latencyMs: e.latencyMs,
    };
  };

  return {
    id,
    name,
    source: "recorded",
    reask: true,
    readyToAsk(_lane, clockMs) {
      const next = queue.find((e) => e.sentAt >= clockMs);

      return next ? next.sentAt === clockMs : true;
    },
    ask(q, mode) {
      if (mode === "realtime") {
        const e = queue.find((x) => x.sentAt === q.sentAt);

        if (!e) return { missing: "The recording has no answer for this moment" };

        if (!sameWorld(e.state, q.state, true))
          return { missing: "This board differs from the recorded one" };

        // Sent but never answered before the recording stopped: it stays in flight until the run stops.
        if (e.status === "cancelled" || e.receivedAt === undefined)
          return {
            receiveAt: Number.POSITIVE_INFINITY,
            answer: { error: "Cancelled when the recording stopped" },
          };

        return { receiveAt: e.receivedAt, answer: toAnswer(e) };
      }

      // Turns ask at spawn; the live recording asked mid-fall. A landing is a final resting
      // place, so the same stack, piece and queue is the same decision.
      const e = queue.find(
        (x) =>
          x.status === "accepted" &&
          sameDecision(x.state, q.state) &&
          q.options.some((o) => o.id === x.answer),
      );

      return e
        ? { receiveAt: q.sentAt, answer: toAnswer(e) }
        : { missing: "No recorded answer for this exact stack and piece" };
    },
  };
}

/** A hosted contestant; the caller supplies the transport (e.g. the site's /api/evaluate with a visitor key). */
export function live(
  name: string,
  id: string,
  send: (
    request: Question["request"],
    signal?: AbortSignal,
  ) => Promise<{
    answers: { decision: { value: string; probabilities?: Probabilities; confidence?: number } };
  }>,
): Contestant {
  return {
    id,
    name,
    source: "live",
    ask(q, _mode, signal) {
      const started = performance.now();

      return send(q.request, signal).then((r) => ({
        choice: r.answers.decision.value,
        probabilities: r.answers.decision.probabilities,
        confidence: r.answers.decision.confidence ?? null,
        latencyMs: performance.now() - started,
      }));
    },
  };
}

/** One recorded real-time decision, with world times. */
export type TimedEvent = {
  sentAt: number;
  pieceId: number;
  board: string[];
  receivedAt?: number;
  choice?: string;
  probabilities?: Probabilities;
  error?: string;
  latencyMs?: number;
};

/**
 * Replays a real-time recording made with ask-once lanes: each question goes
 * out at its recorded world time and its answer lands at its recorded time.
 */
export function timedReplay(
  events: TimedEvent[],
  name: string,
  id: string,
  retryPolicy: "backoff" | "fixed" = "backoff",
): Contestant {
  const queue = [...events].sort((a, b) => a.sentAt - b.sentAt);

  return {
    id,
    name,
    source: "recorded",
    retryPolicy,
    readyToAsk(_lane, clockMs) {
      const next = queue.find((e) => e.sentAt >= clockMs);

      return next ? next.sentAt === clockMs : true;
    },
    ask(q) {
      const e = queue.find(
        (x) =>
          x.sentAt === q.sentAt &&
          x.pieceId === q.pieceId &&
          JSON.stringify(x.board) === JSON.stringify(q.state.board),
      );

      if (!e) return { missing: "The recording has no answer for this moment" };
      const receiveAt = e.receivedAt ?? Number.POSITIVE_INFINITY;

      if (e.error) return { receiveAt, answer: { error: e.error, latencyMs: e.latencyMs } };

      if (e.choice === undefined)
        return { receiveAt, answer: { error: "Superseded before it arrived" } };

      return {
        receiveAt,
        answer: {
          choice: e.choice,
          probabilities: e.probabilities,
          confidence: null,
          latencyMs: e.latencyMs,
        },
      };
    },
  };
}
