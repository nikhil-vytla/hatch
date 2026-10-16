import type {
  ActorId,
  BranchName,
  CommitSha,
  EventOrigin,
  EventSeq,
  SessionId,
  Timestamp,
  TurnId,
} from "../kernel/index.js";
import type { Actor, RepoRef } from "../identity/index.js";
import type { Freshness } from "../slot/index.js";

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
