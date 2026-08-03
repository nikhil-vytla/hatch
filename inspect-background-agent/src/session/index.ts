import type {
  ActorId,
  BranchName,
  CommitSha,
  EffectId,
  EventOrigin,
  EventSeq,
  InstallationToken,
  SessionId,
  Timestamp,
  TurnId,
  UserToken,
  WorkspaceId,
} from "../kernel/index.js";
import type { Actor, ConversationRef, RepoRef } from "../identity/index.js";
import type { Freshness, LeasedSlot, MutableSlot, ToolKind } from "../slot/index.js";

export type TurnState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly startedAt: Timestamp }
  | { readonly kind: "finished"; readonly summary: string }
  | { readonly kind: "stopped"; readonly by: ActorId };

export type Turn = {
  readonly id: TurnId;
  readonly author: Actor;
  readonly text: string;
  readonly clientToken?: string;
  readonly state: TurnState;
};

export type SessionEvent =
  | { readonly kind: "session.started"; readonly repo: RepoRef; readonly by: Actor }
  | { readonly kind: "freshness"; readonly freshness: Freshness }
  | { readonly kind: "turn.queued"; readonly turn: Turn }
  | { readonly kind: "turn.started"; readonly turnId: TurnId }
  | { readonly kind: "agent.delta"; readonly turnId: TurnId; readonly text: string }
  | { readonly kind: "turn.finished"; readonly turnId: TurnId; readonly summary: string }
  | { readonly kind: "turn.stopped"; readonly turnId: TurnId; readonly by: ActorId }
  | { readonly kind: "git.pushed"; readonly branch: BranchName; readonly head: CommitSha }
  | { readonly kind: "pr.opened"; readonly number: number; readonly url: string; readonly by: ActorId }
  | { readonly kind: "session.closed"; readonly reason: string };

export type SessionEventEnvelope = {
  readonly seq: EventSeq;
  readonly at: Timestamp;
  readonly origin: EventOrigin;
  readonly event: SessionEvent;
};

export type PullRequestView = {
  readonly number: number;
  readonly url: string;
  readonly branch: BranchName;
};

export type StopScope = "current-turn" | "queue";

export type SessionView = {
  readonly id: SessionId;
  readonly repo: RepoRef;
  readonly branch: BranchName;
  readonly freshness: Freshness;
  readonly queue: readonly Turn[];
  readonly authors: readonly Actor[];
  readonly pr?: PullRequestView;
  readonly ideUrl: string | null;
  readonly vncUrl: string | null;
  readonly ttyUrl: string | null;
};

export type SessionCommand =
  | {
      readonly kind: "submit";
      readonly author: Actor;
      readonly text: string;
      readonly clientToken?: string;
    }
  | { readonly kind: "stop"; readonly by: ActorId; readonly scope: StopScope }
  | {
      readonly kind: "publish";
      readonly by: ActorId;
      readonly title?: string;
      readonly body?: string;
    }
  | { readonly kind: "close"; readonly reason: string };

export type AdvanceQueueInput = {
  readonly turns: readonly Turn[];
  readonly queuePaused: boolean;
  readonly now: Timestamp;
};

export type AdvanceQueueResult =
  | { readonly kind: "idle" }
  | { readonly kind: "paused" }
  | {
      readonly kind: "start";
      readonly turnId: TurnId;
      readonly turns: readonly Turn[];
    };

/** Pure: pick the next queued turn, or report idle/paused. */
export function advanceQueue(input: AdvanceQueueInput): AdvanceQueueResult {
  if (input.queuePaused) return { kind: "paused" };
  const running = input.turns.find((t) => t.state.kind === "running");
  if (running) return { kind: "idle" };
  const next = input.turns.find((t) => t.state.kind === "queued");
  if (!next) return { kind: "idle" };
  const turns = input.turns.map((t) =>
    t.id === next.id
      ? { ...t, state: { kind: "running" as const, startedAt: input.now } }
      : t,
  );
  return { kind: "start", turnId: next.id, turns };
}

export function branchOfSession(
  prefix: string,
  sessionId: SessionId,
): BranchName {
  return `${prefix}${sessionId}` as BranchName;
}

export function sessionOfBranch(
  prefix: string,
  branch: BranchName,
): SessionId | undefined {
  if (!branch.startsWith(prefix)) return undefined;
  return branch.slice(prefix.length) as SessionId;
}

export function authorsOf(turns: readonly Turn[], opener: Actor): readonly Actor[] {
  const map = new Map<string, Actor>();
  map.set(opener.id, opener);
  for (const t of turns) map.set(t.author.id, t.author);
  return [...map.values()];
}

export interface Session {
  readonly id: SessionId;
  view(): Promise<SessionView>;
  submit(args: {
    readonly author: Actor;
    readonly text: string;
    readonly clientToken?: string;
  }): Promise<TurnId>;
  stop(args: { readonly by: ActorId; readonly scope: StopScope }): Promise<void>;
  events(opts?: { readonly from?: EventSeq }): AsyncIterable<SessionEventEnvelope>;
  publish(args: {
    readonly by: ActorId;
    readonly title?: string;
    readonly body?: string;
  }): Promise<PullRequestView>;
  ideUrl(): Promise<string | null>;
}

export type SessionPorts = {
  readonly acquireSlot: () => Promise<LeasedSlot>;
  readonly runTurn: (args: {
    readonly turn: Turn;
    readonly slot: LeasedSlot;
    readonly onDelta: (text: string) => void;
    readonly shouldStop: () => boolean;
    readonly toolGate: (kind: ToolKind) => Promise<"allow" | "park-then-allow">;
  }) => Promise<{ readonly summary: string; readonly changedCode: boolean }>;
  readonly sidecars: (sessionId: SessionId) => {
    readonly ideUrl: string;
    readonly vncUrl: string | null;
    readonly ttyUrl: string | null;
  };
  readonly eventBus: {
    publish(sessionId: SessionId, envelope: SessionEventEnvelope): void;
  };
  readonly installationToken: () => Promise<InstallationToken>;
  readonly userTokenFor: (actorId: ActorId) => Promise<UserToken>;
  readonly openPullRequest: (args: {
    readonly repo: RepoRef;
    readonly branch: BranchName;
    readonly title: string;
    readonly body: string;
    readonly token: UserToken;
    readonly effectId: EffectId;
  }) => Promise<PullRequestView>;
  readonly now: () => Timestamp;
  readonly newTurnId: () => TurnId;
  readonly newEffectId: (label: string) => EffectId;
  readonly branchPrefix: string;
  readonly workspaceId: WorkspaceId;
};

export type SessionRecord = {
  readonly id: SessionId;
  readonly repo: RepoRef;
  readonly opener: Actor;
  readonly conversation: ConversationRef;
  turns: Turn[];
  queuePaused: boolean;
  lastSeq: number;
  events: SessionEventEnvelope[];
  pr?: PullRequestView;
  slot?: LeasedSlot;
  mutable?: MutableSlot;
  ideUrl: string | null;
  vncUrl: string | null;
  ttyUrl: string | null;
};

export function createSessionActor(
  record: SessionRecord,
  ports: SessionPorts,
): Session {
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function emit(origin: EventOrigin, event: SessionEvent): SessionEventEnvelope {
    record.lastSeq += 1;
    const envelope: SessionEventEnvelope = {
      seq: record.lastSeq as EventSeq,
      at: ports.now(),
      origin,
      event,
    };
    record.events.push(envelope);
    for (const sub of subscribers) sub(envelope);
    ports.eventBus.publish(record.id, envelope);
    return envelope;
  }

  const subscribers = new Set<(e: SessionEventEnvelope) => void>();

  async function ensureSlot(): Promise<LeasedSlot> {
    if (record.slot) return record.slot;
    const slot = await ports.acquireSlot();
    record.slot = slot;
    const urls = ports.sidecars(record.id);
    record.ideUrl = urls.ideUrl;
    record.vncUrl = urls.vncUrl;
    record.ttyUrl = urls.ttyUrl;
    emit("sandbox", { kind: "freshness", freshness: slot.freshness() });
    return slot;
  }

  async function toolGate(kind: ToolKind): Promise<"allow" | "park-then-allow"> {
    const { toolEffect } = await import("../slot/index.js");
    if (toolEffect(kind) === "read-only") return "allow";
    const slot = await ensureSlot();
    if (slot.freshness().kind === "fresh") {
      if (!record.mutable) record.mutable = await slot.admitWrites();
      return "allow";
    }
    emit("sandbox", { kind: "freshness", freshness: slot.freshness() });
    record.mutable = await slot.admitWrites();
    emit("sandbox", { kind: "freshness", freshness: record.mutable.freshness() });
    return "park-then-allow";
  }

  async function pump(): Promise<void> {
    const result = advanceQueue({
      turns: record.turns,
      queuePaused: record.queuePaused,
      now: ports.now(),
    });
    if (result.kind !== "start") return;
    record.turns = [...result.turns];
    emit("system", { kind: "turn.started", turnId: result.turnId });
    const turn = record.turns.find((t) => t.id === result.turnId);
    if (!turn) return;
    const slot = await ensureSlot();
    let stopFlag = false;
    const stopWatcher = () => {
      const current = record.turns.find((t) => t.id === turn.id);
      if (current?.state.kind === "stopped") stopFlag = true;
      return stopFlag;
    };
    try {
      const outcome = await ports.runTurn({
        turn,
        slot,
        onDelta: (text) =>
          emit("agent", { kind: "agent.delta", turnId: turn.id, text }),
        shouldStop: stopWatcher,
        toolGate,
      });
      const latest = record.turns.find((t) => t.id === turn.id);
      if (latest?.state.kind === "stopped") {
        emit("user", {
          kind: "turn.stopped",
          turnId: turn.id,
          by: latest.state.by,
        });
      } else {
        record.turns = record.turns.map((t) =>
          t.id === turn.id
            ? { ...t, state: { kind: "finished" as const, summary: outcome.summary } }
            : t,
        );
        emit("agent", {
          kind: "turn.finished",
          turnId: turn.id,
          summary: outcome.summary,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record.turns = record.turns.map((t) =>
        t.id === turn.id
          ? { ...t, state: { kind: "finished" as const, summary: `error: ${message}` } }
          : t,
      );
      emit("system", {
        kind: "turn.finished",
        turnId: turn.id,
        summary: `error: ${message}`,
      });
    }
    await pump();
  }

  async function handle(cmd: SessionCommand): Promise<unknown> {
    switch (cmd.kind) {
      case "submit": {
        if (cmd.clientToken) {
          const existing = record.turns.find((t) => t.clientToken === cmd.clientToken);
          if (existing) return existing.id;
        }
        const turn: Turn = {
          id: ports.newTurnId(),
          author: cmd.author,
          text: cmd.text,
          ...(cmd.clientToken !== undefined ? { clientToken: cmd.clientToken } : {}),
          state: { kind: "queued" },
        };
        record.turns = [...record.turns, turn];
        record.queuePaused = false;
        emit("user", { kind: "turn.queued", turn });
        void enqueue(() => pump());
        return turn.id;
      }
      case "stop": {
        record.queuePaused = cmd.scope === "queue" ? true : record.queuePaused;
        record.turns = record.turns.map((t) =>
          t.state.kind === "running"
            ? { ...t, state: { kind: "stopped" as const, by: cmd.by } }
            : t,
        );
        if (cmd.scope === "queue") {
          // leave queued turns; just pause
        }
        return undefined;
      }
      case "publish": {
        const slot = await ensureSlot();
        const mutable = record.mutable ?? (await slot.admitWrites());
        record.mutable = mutable;
        const branch = branchOfSession(ports.branchPrefix, record.id);
        const head = await mutable.push(
          branch,
          await ports.installationToken(),
          ports.newEffectId(`push:${record.id}`),
        );
        emit("sandbox", { kind: "git.pushed", branch, head });
        if (record.pr) return record.pr;
        const title = cmd.title ?? `Inspect: ${record.turns[0]?.text.slice(0, 72) ?? record.id}`;
        const body =
          cmd.body ??
          record.turns
            .map((t) => `- (${t.author.display}) ${t.text}`)
            .join("\n");
        const pr = await ports.openPullRequest({
          repo: record.repo,
          branch,
          title,
          body,
          token: await ports.userTokenFor(cmd.by),
          effectId: ports.newEffectId(`pr:${record.id}`),
        });
        record.pr = pr;
        emit("user", {
          kind: "pr.opened",
          number: pr.number,
          url: pr.url,
          by: cmd.by,
        });
        return pr;
      }
      case "close": {
        emit("system", { kind: "session.closed", reason: cmd.reason });
        return undefined;
      }
      default: {
        const _exhaustive: never = cmd;
        return _exhaustive;
      }
    }
  }

  // Boot event
  emit("system", {
    kind: "session.started",
    repo: record.repo,
    by: record.opener,
  });

  const api: Session = {
    id: record.id,
    async view(): Promise<SessionView> {
      const freshness = record.slot?.freshness() ?? { kind: "unknown" };
      const view: SessionView = {
        id: record.id,
        repo: record.repo,
        branch: branchOfSession(ports.branchPrefix, record.id),
        freshness,
        queue: record.turns.filter((t) => t.state.kind === "queued" || t.state.kind === "running"),
        authors: authorsOf(record.turns, record.opener),
        ideUrl: record.ideUrl,
        vncUrl: record.vncUrl,
        ttyUrl: record.ttyUrl,
      };
      if (record.pr) {
        return { ...view, pr: record.pr };
      }
      return view;
    },
    submit(args) {
      return enqueue(() =>
        handle({
          kind: "submit",
          author: args.author,
          text: args.text,
          ...(args.clientToken !== undefined ? { clientToken: args.clientToken } : {}),
        }),
      ) as Promise<TurnId>;
    },
    stop(args) {
      return enqueue(() => handle({ kind: "stop", by: args.by, scope: args.scope })).then(
        () => undefined,
      );
    },
    async *events(opts) {
      const from = opts?.from ? Number(opts.from) : 0;
      for (const e of record.events) {
        if (Number(e.seq) > from) yield e;
      }
      let closed = false;
      const q: SessionEventEnvelope[] = [];
      let wake: (() => void) | undefined;
      const sub = (e: SessionEventEnvelope) => {
        q.push(e);
        wake?.();
        if (e.event.kind === "session.closed") closed = true;
      };
      subscribers.add(sub);
      try {
        while (!closed) {
          if (q.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
            });
          }
          while (q.length) {
            const e = q.shift()!;
            yield e;
            if (e.event.kind === "session.closed") return;
          }
        }
      } finally {
        subscribers.delete(sub);
      }
    },
    publish(args) {
      return enqueue(() =>
        handle({
          kind: "publish",
          by: args.by,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
        }),
      ) as Promise<PullRequestView>;
    },
    async ideUrl() {
      await ensureSlot();
      return record.ideUrl;
    },
  };

  return api;
}
