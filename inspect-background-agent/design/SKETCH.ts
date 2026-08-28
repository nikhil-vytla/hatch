/**
 * Synthesized type sketch — workspace-first Inspect hatch.
 * Refined for three planes: control (SessionAgent + EventBus + PromptIngress),
 * orchestration (Workspace), execution (Runner → agent + sidecars).
 * Bodies filled in under src/; this file is the contract snapshot.
 */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Timestamp = Branded<number, "Timestamp">;
export type WorkspaceId = Branded<string, "WorkspaceId">;
export type SessionId = Branded<string, "SessionId">;
export type TurnId = Branded<string, "TurnId">;
export type SlotId = Branded<string, "SlotId">;
export type LeaseEpoch = Branded<number, "LeaseEpoch">;
export type EventSeq = Branded<number, "EventSeq">;
export type CommitSha = Branded<string, "CommitSha">;
export type BranchName = Branded<string, "BranchName">;
export type EffectId = Branded<string, "EffectId">;
export type InstallationToken = Branded<string, "InstallationToken">;
export type UserToken = Branded<string, "UserToken">;
export type ActorId = Branded<string, "ActorId">;
export type ClientToken = Branded<string, "ClientToken">;

export type EventOrigin = "user" | "agent" | "sandbox" | "webhook" | "system";

export type Freshness =
  | { readonly kind: "unknown" }
  | { readonly kind: "stale"; readonly base: CommitSha; readonly origin: CommitSha }
  | { readonly kind: "syncing"; readonly base: CommitSha; readonly origin: CommitSha }
  | { readonly kind: "fresh"; readonly head: CommitSha }
  | { readonly kind: "diverged"; readonly base: CommitSha; readonly origin: CommitSha };

export type Actor = {
  readonly id: ActorId;
  readonly display: string;
  readonly github: string | null;
};

export type RepoRef = { readonly owner: string; readonly name: string };

export type ConversationRef =
  | { readonly surface: "slack"; readonly channel: string; readonly thread: string }
  | { readonly surface: "web"; readonly key: string }
  | { readonly surface: "api"; readonly key: string };

export type DemandHint = {
  readonly kind: "composing";
  readonly actorId: ActorId;
};

export type TurnState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly startedAt: Timestamp }
  | { readonly kind: "finished"; readonly summary: string }
  | { readonly kind: "stopped"; readonly by: ActorId };

export type Turn = {
  readonly id: TurnId;
  readonly author: Actor;
  readonly text: string;
  readonly clientToken?: ClientToken;
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

export interface Workspace {
  readonly id: WorkspaceId;
  readonly repo: RepoRef;
  start(req: {
    readonly opener: Actor;
    readonly conversation: ConversationRef;
    readonly intent?: string;
  }): Promise<Session>;
  hint(hint: DemandHint): void;
  stats(): Promise<{ readonly sessions: number; readonly humansPrompting: number }>;
}

export type DispatchResult =
  | { readonly kind: "started"; readonly session: Session }
  | { readonly kind: "continued"; readonly session: Session }
  | { readonly kind: "ambiguous"; readonly candidates: readonly RepoRef[] }
  | { readonly kind: "unknown" };

export interface Inspect {
  workspace(repo: RepoRef): Promise<Workspace>;
  dispatch(msg: {
    readonly surface: "slack" | "web";
    readonly conversation: ConversationRef;
    readonly speaker: Actor;
    readonly text: string;
    readonly hints?: { readonly channelName?: string; readonly recentText?: string };
    readonly repo?: RepoRef;
  }): Promise<DispatchResult>;
}

/** Read-only capability until sync completes. */
export interface LeasedSlot {
  readonly id: SlotId;
  readonly epoch: LeaseEpoch;
  freshness(): Freshness;
  read(path: string): Promise<string>;
  admitWrites(): Promise<MutableSlot>;
}

export interface MutableSlot extends LeasedSlot {
  write(path: string, content: string): Promise<void>;
  push(branch: BranchName, token: InstallationToken, effectId: EffectId): Promise<CommitSha>;
}
