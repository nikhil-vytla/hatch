/**
 * @hatch/inspect — type sketch
 *
 * Structural axis D: **workspace-first**.
 *
 *   Workspace = repo + image lineage + warm pool + snapshot store + branch namespace +
 *               forge installation. Long-lived, shared, the root aggregate.
 *   Session   = a short-lived lease on one slot of a workspace, plus the conversation
 *               (turn queue, participants, transcript) that borrowed it.
 *
 * The load-bearing consequence: everything expensive and stale-able is repo-scoped, so it
 * lives on the workspace and is amortised across sessions. A session owns intent, not
 * compute. It cannot boot, sync, snapshot or reclaim anything; it asks the workspace for a
 * lease and the workspace decides how that lease is satisfied.
 *
 * Reading order: §0 kernel → §2 workspace → §3 slot → §4 session → §6 root. §1, §5, §7–§9
 * are supporting surfaces (identity, agent runtime, ports, pure policy, adapters).
 *
 * Bodies are `throw new Error("not implemented")`. Tricky decisions carry TODO pseudocode.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

// ═════════════════════════════════════════════════════════════════════════════════════════
// §0  Kernel — brands, results, ids
// ═════════════════════════════════════════════════════════════════════════════════════════

declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Epoch milliseconds. Always produced by `Clock`, never by `Date.now()` inside the core. */
export type Timestamp = Branded<number, "Timestamp">;
export type DurationMs = number;

export type WorkspaceId = Branded<string, "WorkspaceId">;
export type SessionId = Branded<string, "SessionId">;
export type TurnId = Branded<string, "TurnId">;
export type SlotId = Branded<string, "SlotId">;
export type LeaseId = Branded<string, "LeaseId">;
export type ImageGenerationId = Branded<string, "ImageGenerationId">;
export type SnapshotId = Branded<string, "SnapshotId">;
export type ActorId = Branded<string, "ActorId">;

export type CommitSha = Branded<string, "CommitSha">;
export type BranchName = Branded<string, "BranchName">;
export type RepoPath = Branded<string, "RepoPath">;
export type GithubLogin = Branded<string, "GithubLogin">;

/**
 * Monotonic per session. The only cursor a client keeps; it is what makes reconnect,
 * WebSocket hibernation and Slack re-render the same problem.
 */
export type EventSeq = Branded<number, "EventSeq">;

/**
 * Caller-supplied dedupe key. Two submissions with the same `(actor, clientToken)` are the
 * same submission, per make-operations-idempotent.
 */
export type ClientToken = Branded<string, "ClientToken">;

/**
 * Fencing token. Every mutating slot operation carries the lease epoch it believes it holds;
 * the compute adapter rejects operations from a superseded epoch. This is what stops a
 * session that was declared dead (missed heartbeats, reclaimed slot) from writing into a
 * sandbox that has since been handed to someone else.
 */
export type LeaseEpoch = Branded<number, "LeaseEpoch">;

// ═════════════════════════════════════════════════════════════════════════════════════════
// §1  Identity — who is asking, and whose credential is used
// ═════════════════════════════════════════════════════════════════════════════════════════

/**
 * A human. Deliberately has no token field: callers pass actors around, never credentials.
 * The authorship module exchanges an `Actor` for a token at the moment of use (§4 publish).
 */
export interface Actor {
  readonly id: ActorId;
  readonly display: string;
  readonly github: GithubLogin | null;
  readonly email: string | null;
}

/** Clone/push credential. Bound to the App installation, not to any human. */
export type InstallationToken = Branded<string, "InstallationToken">;
/** PR-opening credential. Bound to one human. Distinct brand so the two cannot be swapped. */
export type UserToken = Branded<string, "UserToken">;

export type ClientSurface = "slack" | "web" | "extension" | "pr-comment" | "api";

/**
 * How a client names a conversation it owns. Slack knows a thread; the web app knows its own
 * key. Sessions are unique per conversation ref, which is what makes `start` idempotent for
 * chat surfaces without the client tracking session ids.
 */
export type ConversationRef =
  | { readonly surface: "slack"; readonly channel: string; readonly thread: string }
  | { readonly surface: "web"; readonly key: string }
  | { readonly surface: "extension"; readonly key: string }
  | { readonly surface: "pr-comment"; readonly repo: RepoRef; readonly number: number };

// ═════════════════════════════════════════════════════════════════════════════════════════
// §2  Workspace — the root aggregate
// ═════════════════════════════════════════════════════════════════════════════════════════

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

/**
 * One build of the repo image: clone + install + setup, optionally a warm run of the app or
 * test suite. Rebuilt on a cadence (~30 min in the Ramp write-up) so a booted slot is never
 * more than one cadence behind origin.
 *
 * `baseCommit` is the single source of truth for slot staleness. Freshness (§3) is *derived*
 * from `baseCommit` vs. origin head; it is never stored on the session.
 */
export interface ImageGeneration {
  readonly id: ImageGenerationId;
  readonly workspace: WorkspaceId;
  readonly baseCommit: CommitSha;
  readonly builtAt: Timestamp;
  /** Hash of the build recipe. A change here invalidates the pool even if the commit matches. */
  readonly recipe: string;
}

/**
 * All the tuning that is repo-scoped. Set once when the workspace is opened, never passed
 * per call — keeping supply policy off the request path is most of why the session surface
 * stays small.
 */
export interface WorkspacePolicy {
  readonly defaultBranch: BranchName;
  readonly branchPrefix: string;
  readonly image: {
    readonly rebuildEveryMs: DurationMs;
    readonly warmRun: readonly ReadOnlyCommand[];
  };
  readonly pool: {
    /** Slots kept warm at steady state. 0 is legal and means "boot on demand". */
    readonly target: number;
    readonly max: number;
    readonly maxIdleMs: DurationMs;
    /** How much demand signal (§ hint) it takes to pre-boot above target. */
    readonly hintBurstThreshold: number;
  };
  readonly lease: {
    readonly ttlMs: DurationMs;
    readonly heartbeatMs: DurationMs;
    /** Idle time after which a leased slot is snapshotted and released. */
    readonly parkAfterIdleMs: DurationMs;
  };
  /**
   * If a slot's baked-in commit is further behind than this, prefer a cold boot on the newest
   * generation over syncing a large delta.
   */
  readonly syncHorizonMs: DurationMs;
}

/**
 * The public root aggregate. Six methods, and behind them: image cadence, warm pool sizing,
 * lease arbitration and fencing, snapshot lifecycle, crash reclamation, branch namespace, and
 * webhook routing. Callers coordinate none of it.
 */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly repo: RepoRef;

  /**
   * Start (or rejoin) a session. Idempotent on `conversation`: a second call for the same
   * thread returns the live session with `opener` added to the participant roster, rather
   than a duplicate. Returns as soon as the session exists — lease acquisition, sync and
   * agent attach happen behind the event stream, so time-to-first-token is not gated on this
   * promise.
   */
  start(req: StartSessionRequest): Promise<Session>;

  /**
   * Advisory demand signal — the "warm on keystroke" path. Fire-and-forget, idempotent,
   * coalesced. Never blocks the caller and never fails a request; the worst outcome of
   * spamming it is a slot booted that nobody used, which the idle reaper collects.
   */
  hint(hint: DemandHint): void;

  /** Supply-side observability: generation rolls, pool depth, reclamations. Not per session. */
  observe(opts?: StreamOptions): AsyncIterable<WorkspaceEvent>;

  stats(window: StatsWindow): Promise<WorkspaceStats>;

  /**
   * Repo-scoped forge events (PR merged/closed, branch deleted, review submitted). Lives here
   * because webhooks are repo-scoped: the workspace already owns the branch namespace, so it
   * can resolve a delivery to a session by parsing the branch name (§8 `sessionOfBranch`)
   * with no cross-repo registry.
   */
  deliver(event: ForgeEvent): Promise<void>;

  /** Adapter/test seam: force a rebuild instead of waiting for the cadence. */
  rebuildImage(reason: string): Promise<ImageGeneration>;
}

export interface StartSessionRequest {
  readonly opener: Actor;
  readonly intent: string;
  readonly conversation?: ConversationRef;
  /** Branch or commit to start from. Defaults to the workspace default branch at origin head. */
  readonly base?: BranchName | CommitSha;
  /** Set when an agent spawns a child session (§5). Absent for human-started sessions. */
  readonly parent?: ChildLink;
}

export interface ChildLink {
  readonly session: SessionId;
  readonly turn: TurnId;
  /**
   * `sibling-slot` gets its own lease and filesystem — right for independent research fan-out.
   * `share-parent-slot` takes a shared sublease on the parent's slot so edits land in one tree
   * — right for splitting a change. The parent's turn queue blocks while a sharing child runs;
   * two writers on one filesystem is the thing this union exists to make impossible by accident.
   */
  readonly isolation: "sibling-slot" | "share-parent-slot";
  readonly budget?: { readonly maxTurns?: number; readonly maxWallMs?: DurationMs };
}

export type DemandHint =
  | { readonly kind: "composing"; readonly actor: Actor }
  | { readonly kind: "scheduled"; readonly at: Timestamp; readonly count: number }
  | { readonly kind: "resuming"; readonly session: SessionId };

export type WorkspaceEvent =
  | { readonly type: "image.built"; readonly generation: ImageGeneration }
  | { readonly type: "pool.changed"; readonly warm: number; readonly leased: number }
  | { readonly type: "slot.reclaimed"; readonly slot: SlotId; readonly reason: ReclaimReason }
  | { readonly type: "session.started"; readonly session: SessionId; readonly opener: ActorId }
  | { readonly type: "session.parked"; readonly session: SessionId; readonly snapshot: SnapshotId };

export type ReclaimReason = "idle" | "lease-expired" | "generation-expired" | "explicit" | "crashed";

export interface StatsWindow {
  readonly windowMs: DurationMs;
}

/** Backs the "org stats" dashboard: merged PR rate, humans prompting in the last 5 minutes. */
export interface WorkspaceStats {
  readonly repo: RepoRef;
  readonly sessionsStarted: number;
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  readonly distinctPrompters: number;
  readonly promptersLast5m: number;
  readonly medianTimeToFirstTokenMs: number | null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// §3  Slot — one sandbox, and the write gate
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// Slot types are NOT exported from the package root. Application callers never hold one;
// the agent runtime adapter does. They live here so the gate invariant is visible in one file.

/**
 * Where a slot's filesystem stands relative to origin. Derived from the slot's baked-in
 * `ImageGeneration.baseCommit` and observed origin head — never stored on a session, so it
 * cannot go stale in two places.
 *
 * Reads are legal in every state. Writes are legal only in `fresh`, and the type system, not
 * a runtime check, is what enforces that: write methods live on `MutableSlot`, and the only
 * way to obtain one is `admitWrites`.
 */
export type Freshness =
  | { readonly kind: "unknown" }
  | { readonly kind: "stale"; readonly base: CommitSha; readonly behindMs: DurationMs }
  | { readonly kind: "syncing"; readonly base: CommitSha; readonly target: CommitSha; readonly startedAt: Timestamp }
  | { readonly kind: "fresh"; readonly head: CommitSha; readonly at: Timestamp }
  | {
      /** Sync could not fast-forward over work already in the slot. Needs a policy decision. */
      readonly kind: "diverged";
      readonly base: CommitSha;
      readonly target: CommitSha;
      readonly conflicts: readonly RepoPath[];
    };

export type SlotState =
  | { readonly kind: "provisioning"; readonly generation: ImageGenerationId }
  | { readonly kind: "warm"; readonly generation: ImageGenerationId; readonly idleSince: Timestamp }
  | { readonly kind: "leased"; readonly lease: LeaseId; readonly session: SessionId }
  | { readonly kind: "hibernated"; readonly snapshot: SnapshotId; readonly session: SessionId }
  | { readonly kind: "retired"; readonly reason: ReclaimReason };

export interface PooledSlot {
  readonly id: SlotId;
  readonly generation: ImageGenerationId;
  readonly idleSince: Timestamp;
}

export interface SnapshotRef {
  readonly id: SnapshotId;
  readonly session: SessionId;
  readonly takenAt: Timestamp;
  readonly headCommit: CommitSha;
  readonly generation: ImageGenerationId;
}

export interface SlotLease {
  readonly id: LeaseId;
  readonly epoch: LeaseEpoch;
  readonly slot: SlotId;
  readonly session: SessionId;
  readonly exclusive: boolean;
  readonly expiresAt: Timestamp;
  /** Observability only. No caller branches on this; it exists for the TTFT histogram. */
  readonly origin: "warm-pool" | "cold-boot" | "snapshot-resume" | "shared-sublease";
}

export type CommandEffect = "read-only" | "mutating";

export interface Command {
  readonly argv: readonly string[];
  readonly cwd?: RepoPath;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: DurationMs;
}
export interface ReadOnlyCommand extends Command {
  readonly effect: "read-only";
}
export interface MutatingCommand extends Command {
  readonly effect: "mutating";
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: DurationMs;
}

/**
 * What a session's compute can do before the git delta has landed. Everything here is safe
 * against a stale tree: the agent can orient itself, grep, read files, run the pre-baked
 * warm-run output. That is the whole point of the gate — reads start at t=0 while sync runs.
 */
export interface LeasedSlot {
  readonly lease: SlotLease;
  /** Value at read time. Subscribe via `watch()` for transitions. */
  readonly freshness: Freshness;

  read(path: RepoPath): Promise<Uint8Array>;
  list(path: RepoPath): Promise<readonly RepoPath[]>;
  run(cmd: ReadOnlyCommand): Promise<CommandResult>;
  watch(opts?: StreamOptions): AsyncIterable<SlotEvent>;

  /**
   * The gate. Waits for the slot to reach `fresh` and hands back the write-capable view.
   * Callers do not poll, do not read `freshness`, and do not implement backoff — this is the
   * one place where "block edits until sync completes" lives.
   *
   * Idempotent: repeated calls while already fresh return immediately with the same view.
   */
  admitWrites(opts?: { readonly deadlineMs?: DurationMs }): Promise<Result<MutableSlot, WriteDenial>>;

  /** Keeps the lease alive. Called by the session's turn loop, never by application code. */
  heartbeat(): void;
}

export interface MutableSlot extends LeasedSlot {
  write(path: RepoPath, bytes: Uint8Array): Promise<void>;
  remove(path: RepoPath): Promise<void>;
  run(cmd: ReadOnlyCommand | MutatingCommand): Promise<CommandResult>;

  /**
   * Commits with `author`'s git identity, overriding whatever the image baked in. The
   * installation token cloned this repo; it must not end up as the commit author.
   */
  commit(req: { readonly author: Actor; readonly message: string; readonly attribution: readonly TurnId[] }): Promise<CommitSha>;

  /** Pushes with the installation token. Never with a user token. */
  push(branch: BranchName): Promise<{ readonly head: CommitSha; readonly forced: boolean }>;
}

export type WriteDenial =
  | { readonly kind: "deadline"; readonly waitedMs: DurationMs; readonly freshness: Freshness }
  | { readonly kind: "diverged"; readonly conflicts: readonly RepoPath[] }
  | { readonly kind: "lease-lost"; readonly lease: LeaseId; readonly reason: ReclaimReason };

export type SlotEvent =
  | { readonly type: "freshness"; readonly freshness: Freshness }
  | { readonly type: "lease.renewed"; readonly expiresAt: Timestamp }
  | { readonly type: "lease.lost"; readonly reason: ReclaimReason };

/**
 * Maps an agent tool call to a filesystem effect. Owned here, in one module, because both the
 * OpenCode `tool.execute.before` plugin and the local fake runtime must agree on it — a second
 * copy of this table is information leakage waiting to drift.
 */
export interface ToolEffectPolicy {
  classify(call: ToolCall): CommandEffect;
}

export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export function defaultToolEffectPolicy(): ToolEffectPolicy {
  // TODO: read/grep/glob/list/webfetch → "read-only"; write/edit/patch/bash → "mutating".
  // TODO: bash needs argv sniffing; default it to "mutating" (fail closed) and allow an
  //       explicit allowlist (git log, rg, ls) that a repo can extend via WorkspacePolicy.
  throw new Error("not implemented");
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// §4  Session — the conversation that borrowed a slot
// ═════════════════════════════════════════════════════════════════════════════════════════

/**
 * A session owns intent and history. It does not own compute; it holds a lease.
 *
 * Multiplayer: a session has a roster, not an owner. `opener` is who started it, which is a
 * fact about the past, not an authorisation boundary. Any participant may submit, stop, or
 * publish, and every turn carries its own author.
 */
export interface Session {
  readonly id: SessionId;
  readonly repo: RepoRef;

  /**
   * Append a prompt to the queue. Never interrupts a running turn — the queue is append-only
   * by design, because mid-run insertion makes the agent's context nondeterministic for
   * everyone else in the thread. Idempotent on `(author, clientToken)`.
   */
  submit(req: PromptSubmission): Promise<QueuedTurn>;

  /** Remove a turn that has not started. No-op if it already started or already left the queue. */
  cancel(turn: TurnId, by: Actor): Promise<void>;

  /**
   * Stop the running turn (`current-turn`) or the running turn plus everything queued
   * (`queue`). Idempotent, and safe to call when nothing is running.
   */
  stop(req: StopRequest): Promise<void>;

  /** Cold render: everything a client needs to draw the session with no prior state. */
  view(): Promise<SessionView>;

  /**
   * Warm tail. `from` replays from that sequence; omitting it starts at the live edge. The
   * pair (`view`, `events({from})`) is the entire client sync protocol — reconnect, WebSocket
   * hibernation wake-up, and a Slack card re-render are all the same call.
   */
  events(opts?: StreamOptions): AsyncIterable<SessionEvent>;

  /**
   * Commit anything outstanding, push the session branch, and open the PR **as `opener`**,
   * crediting every participant whose turn produced a commit. Idempotent: if this session
   * already has an open PR, returns it (updating title/body when supplied) rather than
   * opening a second one.
   */
  publish(req: PublishRequest): Promise<PullRequestView>;

  /**
   * Snapshot and release the slot now. Optional — the workspace parks idle sessions on its own
   * schedule, and a parked session transparently re-acquires a lease on the next `submit`.
   * Exposed because "I'm done" is cheaper than waiting out the idle timer.
   */
  park(): Promise<void>;
}

export interface PromptSubmission {
  readonly author: Actor;
  readonly text: string;
  readonly clientToken?: ClientToken;
  readonly surface?: ClientSurface;
  /** Structured context a surface can attach: selected DOM node, file range, PR comment. */
  readonly attachments?: readonly Attachment[];
}

export type Attachment =
  | { readonly kind: "file-range"; readonly path: RepoPath; readonly from: number; readonly to: number }
  | { readonly kind: "image"; readonly mime: string; readonly bytes: Uint8Array }
  | { readonly kind: "dom-node"; readonly url: string; readonly selector: string; readonly react?: string }
  | { readonly kind: "pr-comment"; readonly number: number; readonly body: string };

export interface StopRequest {
  readonly by: Actor;
  readonly scope: "current-turn" | "queue";
  readonly reason?: string;
}

export interface PublishRequest {
  readonly opener: Actor;
  readonly title?: string;
  readonly body?: string;
  readonly draft?: boolean;
}

export interface StreamOptions {
  readonly from?: EventSeq;
  readonly signal?: AbortSignal;
}

/** A turn is one prompt and everything the agent did in response to it. */
export interface Turn {
  readonly id: TurnId;
  readonly session: SessionId;
  readonly author: Actor;
  readonly text: string;
  readonly submittedAt: Timestamp;
  readonly status: TurnStatus;
}

export type TurnStatus =
  | { readonly kind: "queued"; readonly ahead: number }
  | { readonly kind: "running"; readonly startedAt: Timestamp; readonly attempt: number }
  | { readonly kind: "stopped"; readonly at: Timestamp; readonly by: ActorId }
  | { readonly kind: "cancelled"; readonly at: Timestamp; readonly by: ActorId }
  | { readonly kind: "failed"; readonly at: Timestamp; readonly error: TurnError }
  | { readonly kind: "done"; readonly at: Timestamp; readonly outcome: TurnOutcome };

export type TurnError =
  | { readonly kind: "write-denied"; readonly denial: WriteDenial }
  | { readonly kind: "agent"; readonly message: string }
  | { readonly kind: "slot-lost"; readonly reason: ReclaimReason }
  | { readonly kind: "budget-exhausted" };

/**
 * `commits` is the authorship primitive. A turn that produced commits makes its author a
 * contributor on the PR; a turn that produced none was conversation. Contributors are derived
 * from the turn ledger at publish time (§8 `contributorsOf`), never tracked separately.
 */
export interface TurnOutcome {
  readonly commits: readonly CommitSha[];
  readonly filesChanged: number;
  readonly summary: string;
  readonly children: readonly SessionId[];
}

/** What `submit` hands back: enough to render immediately and to start streaming. */
export interface QueuedTurn {
  readonly id: TurnId;
  readonly ahead: number;
  readonly queuedSeq: EventSeq;
  /** True when this submission was deduped against an earlier one with the same clientToken. */
  readonly deduped: boolean;
}

// ── Per-actor state, merged at the read boundary ─────────────────────────────────────────
//
// Two clients writing one shared "who is here / who is typing" record is the classic
// lost-update. Per separate-before-serializing-shared-state, each (actor, surface) owns its
// own record and nothing merges on write; `mergeParticipants` (§8) merges on read. The turn
// queue is the deliberate exception — ordering is the invariant users actually perceive, so
// it is serialised through the session actor.

export interface ParticipantRecord {
  readonly actor: Actor;
  readonly surface: ClientSurface;
  readonly joinedAt: Timestamp;
  readonly presenceAt: Timestamp;
  readonly lastSeenSeq: EventSeq;
  readonly composing: boolean;
}

export interface ParticipantView {
  readonly actor: Actor;
  readonly surfaces: readonly ClientSurface[];
  readonly present: boolean;
  readonly composing: boolean;
  readonly contributed: boolean;
}

export interface SessionView {
  readonly id: SessionId;
  readonly repo: RepoRef;
  readonly intent: string;
  readonly lifecycle: SessionLifecycle;
  readonly turns: readonly Turn[];
  readonly participants: readonly ParticipantView[];
  readonly branch: BranchName;
  readonly freshness: Freshness;
  readonly pullRequest: PullRequestView | null;
  readonly parent: ChildLink | null;
  readonly at: EventSeq;
}

/**
 * Lifecycle is about the *lease*, not about the conversation. `parked` is a normal resting
 * state, not an error: a session that has not been prompted in a while gives its slot back and
 * gets a new one on the next prompt. Clients that render this should treat parked as idle.
 *
 * Carries no handles. An earlier draft put `SlotLease` on `active` and `SnapshotRef` on
 * `parked`, which shipped slot ids, snapshot ids and lease epochs to every web client for no
 * reason — `LeaseBinding` below is the private version, projected by `publicLifecycle`.
 */
export type SessionLifecycle =
  | { readonly kind: "acquiring"; readonly since: Timestamp }
  | { readonly kind: "active"; readonly since: Timestamp; readonly warmStart: boolean }
  | { readonly kind: "parked"; readonly since: Timestamp; readonly resumable: boolean }
  | { readonly kind: "closed"; readonly at: Timestamp; readonly reason: SessionCloseReason };

export type SessionCloseReason = "published" | "abandoned" | "failed";

export type SessionEvent = { readonly seq: EventSeq; readonly at: Timestamp } & (
  | { readonly type: "session.lifecycle"; readonly lifecycle: SessionLifecycle }
  | { readonly type: "turn.queued"; readonly turn: Turn }
  | { readonly type: "turn.started"; readonly turnId: TurnId }
  | { readonly type: "turn.delta"; readonly turnId: TurnId; readonly delta: AgentDelta }
  | { readonly type: "turn.finished"; readonly turnId: TurnId; readonly status: TurnStatus }
  | { readonly type: "slot.freshness"; readonly freshness: Freshness }
  | { readonly type: "participant.changed"; readonly participants: readonly ParticipantView[] }
  | { readonly type: "status"; readonly text: string; readonly emoji?: string; readonly turnId: TurnId }
  | { readonly type: "pull_request"; readonly pullRequest: PullRequestView }
);

export interface PullRequestView {
  readonly repo: RepoRef;
  readonly number: number;
  readonly url: string;
  readonly branch: BranchName;
  readonly state: "open" | "merged" | "closed" | "draft";
  readonly openedBy: ActorId;
  readonly contributors: readonly ActorId[];
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// §5  Agent runtime — the OpenCode integration point
// ═════════════════════════════════════════════════════════════════════════════════════════

/**
 * The runtime port. One method, because the session's turn loop needs exactly one thing:
 * attach to a leased slot and run turns on it.
 *
 * No OpenCode type crosses this boundary. The adapter owns the server lifecycle, the SDK
 * client, the plugin registration, and the translation of its event frames into `AgentDelta`.
 */
export interface AgentRuntime {
  attach(slot: LeasedSlot, caps: TurnCapabilities): Promise<AgentAttachment>;
}

export interface AgentAttachment {
  run(turn: Turn, opts?: { readonly signal?: AbortSignal }): AsyncIterable<AgentDelta>;
  /** Cooperative stop for the running turn. Must be safe to call after the turn finished. */
  abort(reason: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * What the session grants an attached agent. Each field becomes one OpenCode plugin in the
 * adapter, and each is the *only* way the agent can reach back into the system — there is no
 * ambient access to the session or the workspace from inside the runtime.
 */
export interface TurnCapabilities {
  /** → `tool.execute.before`: classify the call, park mutating calls until the gate opens. */
  readonly gate: WriteGate;
  /** → the agent's status tool: free-form progress the humans in the thread should see. */
  readonly status: (msg: { readonly text: string; readonly emoji?: string }) => void;
  /** → the child-session tool: fan-out research, or splitting a change across slots. */
  readonly spawnChild: (req: ChildSpawnRequest) => Promise<SessionId>;
  /**
   * Extension point. Ramp's internal MCP suite (Sentry, Datadog, LaunchDarkly, Buildkite) and
   * the computer-use tools plug in here without touching the session or workspace modules.
   */
  readonly extraTools: readonly ToolSpec[];
}

export interface WriteGate {
  readonly policy: ToolEffectPolicy;
  /**
   * Resolves when the call may proceed. The plugin awaits this and nothing else — it holds no
   * timer, no retry loop and no copy of the freshness state.
   */
  admit(call: ToolCall): Promise<Result<MutableSlot | null, WriteDenial>>;
}

export interface ChildSpawnRequest {
  readonly intent: string;
  readonly isolation: ChildLink["isolation"];
  readonly budget?: ChildLink["budget"];
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly effect: CommandEffect;
  readonly invoke: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** Domain-level agent output. Deliberately not the runtime's frame type. */
export type AgentDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "tool.start"; readonly call: ToolCall; readonly id: string }
  | { readonly kind: "tool.end"; readonly id: string; readonly ok: boolean; readonly preview?: string }
  | { readonly kind: "tool.parked"; readonly id: string; readonly waitingOn: Freshness }
  | { readonly kind: "file.changed"; readonly path: RepoPath; readonly added: number; readonly removed: number }
  | { readonly kind: "commit"; readonly sha: CommitSha; readonly message: string }
  | { readonly kind: "child"; readonly sessionId: SessionId; readonly intent: string }
  | { readonly kind: "finished"; readonly summary: string };

// ═════════════════════════════════════════════════════════════════════════════════════════
// §6  Root — the only thing an application constructs
// ═════════════════════════════════════════════════════════════════════════════════════════

export interface Inspect {
  /** Open-or-create. Binds policy, ensures the image build loop, registers the webhook. */
  workspace(repo: RepoRef, policy?: Partial<WorkspacePolicy>): Promise<Workspace>;

  /**
   * The chat path, end to end: classify the repo from the message and its channel context,
   * open that workspace, find-or-start the session for the conversation, join the speaker, and
   * queue the prompt. `ambiguous` is a first-class outcome, so a client can ask instead of
   * guessing.
   */
  dispatch(msg: InboundMessage): Promise<Dispatch>;

  /** The one lookup. Three ways in because three clients know three different names. */
  locate(loc: SessionLocator): Promise<Session | null>;

  readonly webhooks: WebhookSink;

  /** Org-wide roll-up across every open workspace. */
  stats(window: StatsWindow): Promise<readonly WorkspaceStats[]>;

  close(): Promise<void>;
}

export function createInspect(env: InspectEnv): Inspect {
  throw new Error("not implemented");
}

export interface InspectEnv {
  readonly ports: Ports;
  readonly policy?: Partial<WorkspacePolicy>;
}

export interface InboundMessage {
  readonly surface: ClientSurface;
  readonly conversation: ConversationRef;
  readonly speaker: Actor;
  readonly text: string;
  readonly hints?: {
    readonly channelName?: string;
    readonly recentText?: readonly string[];
    /** A surface that already knows the repo skips the classifier entirely. */
    readonly repo?: RepoRef;
  };
  readonly attachments?: readonly Attachment[];
}

export type Dispatch =
  | { readonly kind: "dispatched"; readonly session: Session; readonly turn: QueuedTurn; readonly repo: RepoRef }
  | { readonly kind: "ambiguous"; readonly candidates: readonly RepoCandidate[] }
  | { readonly kind: "unroutable"; readonly reason: string };

export interface RepoCandidate {
  readonly repo: RepoRef;
  readonly confidence: number;
  readonly because: string;
}

export type SessionLocator =
  | { readonly by: "id"; readonly id: SessionId }
  | { readonly by: "conversation"; readonly ref: ConversationRef }
  | { readonly by: "branch"; readonly repo: RepoRef; readonly branch: BranchName };

export interface WebhookSink {
  /** Verifies, parses into `ForgeEvent`, and routes to the owning workspace. */
  deliver(raw: RawWebhook): Promise<void>;
}

export interface RawWebhook {
  readonly signature: string;
  readonly event: string;
  readonly body: string | Uint8Array;
}

/** Parsed at the boundary; the GitHub payload shape never travels inward. */
export type ForgeEvent =
  | { readonly type: "pr.opened"; readonly repo: RepoRef; readonly number: number; readonly branch: BranchName }
  | { readonly type: "pr.merged"; readonly repo: RepoRef; readonly number: number; readonly branch: BranchName; readonly by: GithubLogin }
  | { readonly type: "pr.closed"; readonly repo: RepoRef; readonly number: number; readonly branch: BranchName }
  | { readonly type: "pr.review"; readonly repo: RepoRef; readonly number: number; readonly by: GithubLogin; readonly body: string }
  | { readonly type: "pr.comment"; readonly repo: RepoRef; readonly number: number; readonly by: GithubLogin; readonly body: string }
  | { readonly type: "push"; readonly repo: RepoRef; readonly branch: BranchName; readonly head: CommitSha };

// ═════════════════════════════════════════════════════════════════════════════════════════
// §7  Ports — everything the core needs from the outside world
// ═════════════════════════════════════════════════════════════════════════════════════════

export interface Ports {
  readonly compute: ComputePort;
  readonly images: ImagePort;
  readonly store: StorePort;
  readonly bus: BusPort;
  readonly forge: ForgePort;
  readonly identities: IdentityPort;
  readonly agent: AgentRuntime;
  readonly classifier: RepoClassifierPort;
  readonly clock: Clock;
  /** Defaults to random ids. Overridden only by tests that want deterministic ones. */
  readonly ids?: IdPort;
}

/** Modal in production, a directory + child process locally. */
export interface ComputePort {
  boot(req: { readonly generation: ImageGenerationId; readonly lease: SlotLease }): Promise<LeasedSlot>;
  resume(req: { readonly snapshot: SnapshotId; readonly lease: SlotLease }): Promise<LeasedSlot>;
  snapshot(slot: SlotId, lease: SlotLease): Promise<SnapshotRef>;
  /**
   * Begins the git delta apply and drives the slot's `Freshness` transitions. Started by the
   * workspace immediately after boot, in parallel with agent attach — that parallelism is the
   * whole reason the gate exists.
   */
  sync(slot: SlotId, target: CommitSha, lease: SlotLease): Promise<void>;
  kill(slot: SlotId, reason: ReclaimReason): Promise<void>;
}

export interface ImagePort {
  build(repo: RepoRef, policy: WorkspacePolicy, token: InstallationToken): Promise<ImageGeneration>;
  current(repo: RepoRef): Promise<ImageGeneration | null>;
  expire(generation: ImageGenerationId): Promise<void>;
}

/**
 * Two keyspaces, because there are two aggregates: one durable record per workspace and one
 * per session. Maps to two Durable Object classes; locally, to two tables.
 */
export interface StorePort {
  workspace(id: WorkspaceId): AggregateStore<WorkspaceRecord>;
  session(id: SessionId): AggregateStore<SessionRecord>;
  directory(): DirectoryStore;
}

export interface AggregateStore<T> {
  read(): Promise<T | null>;
  /** Optimistic concurrency. `mutate` is pure; the store retries it on version conflict. */
  update(mutate: (current: T | null) => T): Promise<T>;
  appendEvents(events: readonly unknown[]): Promise<EventSeq>;
  readEvents(from: EventSeq, limit: number): Promise<readonly unknown[]>;
}

/** The only global index. Everything else hangs off a workspace or a session. */
export interface DirectoryStore {
  workspaceOf(repo: RepoRef): Promise<WorkspaceId | null>;
  putWorkspace(repo: RepoRef, id: WorkspaceId): Promise<void>;
  sessionOfConversation(ref: ConversationRef): Promise<SessionId | null>;
  putConversation(ref: ConversationRef, id: SessionId): Promise<void>;
  listWorkspaces(): Promise<readonly WorkspaceId[]>;
}

/** Durable Object WebSocket hibernation in production; an EventTarget locally. */
export interface BusPort {
  publish(topic: string, events: readonly unknown[]): Promise<EventSeq>;
  subscribe(topic: string, opts?: StreamOptions): AsyncIterable<unknown>;
}

export interface ForgePort {
  installationToken(repo: RepoRef): Promise<InstallationToken>;
  originHead(repo: RepoRef, branch: BranchName): Promise<CommitSha>;
  /**
   * Takes a `UserToken`, not an `InstallationToken`. The brand split is the enforcement of
   * "PRs are opened by the human, never by the app".
   */
  openPullRequest(req: {
    readonly repo: RepoRef;
    readonly branch: BranchName;
    readonly base: BranchName;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly as: UserToken;
  }): Promise<PullRequestView>;
  findPullRequest(repo: RepoRef, branch: BranchName): Promise<PullRequestView | null>;
  verifyWebhook(raw: RawWebhook): Result<ForgeEvent, { readonly reason: string }>;
}

export interface IdentityPort {
  /** Throws if the actor has not completed OAuth — publish is the only path that needs this. */
  userToken(actor: ActorId): Promise<UserToken>;
  bySurfaceId(surface: ClientSurface, externalId: string): Promise<Actor | null>;
}

export interface RepoClassifierPort {
  classify(msg: InboundMessage, known: readonly RepoRef[]): Promise<readonly RepoCandidate[]>;
}

export interface Clock {
  now(): Timestamp;
  sleep(ms: DurationMs, signal?: AbortSignal): Promise<void>;
  /** Durable timer: survives a Durable Object eviction. Backs the reaper and the park timer. */
  schedule(at: Timestamp, key: string): Promise<void>;
}

export interface IdPort {
  session(): SessionId;
  turn(): TurnId;
  slot(): SlotId;
  lease(): LeaseId;
  workspace(): WorkspaceId;
}

// ── Durable records (private to the store; never returned from a public method) ───────────

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly repo: RepoRef;
  readonly policy: WorkspacePolicy;
  readonly generations: readonly ImageGeneration[];
  readonly slots: Readonly<Record<string, SlotState>>;
  readonly leases: Readonly<Record<string, SlotLease>>;
  readonly nextEpoch: LeaseEpoch;
  readonly demand: readonly DemandHint[];
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly workspace: WorkspaceId;
  readonly intent: string;
  readonly opener: ActorId;
  readonly branch: BranchName;
  readonly base: CommitSha;
  readonly binding: LeaseBinding;
  readonly turns: readonly Turn[];
  /** Keyed by `${actorId}:${surface}` — per-actor, never merged on write. */
  readonly participants: Readonly<Record<string, ParticipantRecord>>;
  readonly seenTokens: Readonly<Record<string, TurnId>>;
  readonly pullRequest: PullRequestView | null;
  readonly parent: ChildLink | null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// §8  Policy — the decisions, as pure functions
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// Everything genuinely hard about this system is here, with no I/O, so it is unit-testable
// against a fake clock. The shells in §2–§4 read state, call one of these, and apply the
// result, per boundary-discipline.

export interface AcquisitionInput {
  readonly now: Timestamp;
  readonly policy: WorkspacePolicy;
  readonly current: ImageGeneration | null;
  readonly pool: readonly PooledSlot[];
  readonly resumeFrom: SnapshotRef | null;
  readonly originHead: CommitSha;
}

export type AcquisitionPlan =
  | { readonly kind: "take-warm"; readonly slot: SlotId; readonly expect: Freshness }
  | { readonly kind: "resume-snapshot"; readonly snapshot: SnapshotId; readonly expect: Freshness }
  | { readonly kind: "cold-boot"; readonly generation: ImageGenerationId; readonly expect: Freshness }
  | { readonly kind: "build-first"; readonly reason: "no-generation" | "recipe-changed" | "beyond-horizon" };

/**
 * The single place that decides warm-pool hit vs. cold boot vs. snapshot resume. Callers never
 * see this choice; `origin` on the resulting lease records which way it went, for metrics only.
 */
export function planAcquisition(input: AcquisitionInput): AcquisitionPlan {
  // TODO 1. resumeFrom set and its generation is still live → resume-snapshot. The session's
  //         own edits are in that snapshot and cannot be reconstructed from the pool.
  // TODO 2. a warm slot on `current` exists → take-warm. Expected freshness is "stale" with
  //         behindMs = now - current.builtAt, which is what the gate will wait out.
  // TODO 3. no generation, or its recipe hash no longer matches policy → build-first.
  // TODO 4. current.builtAt older than syncHorizonMs → build-first("beyond-horizon"): a large
  //         delta syncs slower than a rebuild boots, and the rebuild also refills the pool.
  // TODO 5. otherwise cold-boot on `current`.
  throw new Error("not implemented");
}

export interface PoolInput {
  readonly now: Timestamp;
  readonly policy: WorkspacePolicy;
  readonly current: ImageGenerationId | null;
  readonly pool: readonly PooledSlot[];
  readonly recentHints: readonly DemandHint[];
}

export interface PoolAdjustment {
  readonly boot: number;
  readonly retire: readonly { readonly slot: SlotId; readonly reason: ReclaimReason }[];
}

/**
 * Warm-on-keystroke and pool expiry are the same decision, which is why they are one function:
 * both answer "given demand and generation, what should the pool look like right now".
 */
export function planPool(input: PoolInput): PoolAdjustment {
  // TODO retire every slot whose generation !== current (reason "generation-expired") — a new
  //      image invalidates the pool wholesale, per the Ramp note on expiring on rebuild.
  // TODO retire slots idle beyond maxIdleMs, down to `target`.
  // TODO boot = clamp(target + burst - live, 0, max - live) where burst counts distinct actors
  //      with a "composing" hint inside the last few seconds. This is the whole warm-on-
  //      keystroke feature; it is deliberately not a separate code path.
  throw new Error("not implemented");
}

export type QueueDecision =
  | { readonly kind: "idle" }
  | { readonly kind: "start"; readonly turn: TurnId }
  | { readonly kind: "park"; readonly after: DurationMs };

/**
 * Append-only queue semantics in one place: at most one running turn, FIFO by acceptance
 * order, park when the queue has been empty for `parkAfterIdleMs`.
 */
export function advanceQueue(turns: readonly Turn[], now: Timestamp, policy: WorkspacePolicy): QueueDecision {
  throw new Error("not implemented");
}

/**
 * Read-boundary merge for multiplayer presence. Same human on Slack and web is one participant
 * with two surfaces; present if any surface is present; contributing if any of their turns
 * produced commits. No writer ever touches another actor's record.
 */
export function mergeParticipants(
  records: readonly ParticipantRecord[],
  turns: readonly Turn[],
): readonly ParticipantView[] {
  throw new Error("not implemented");
}

/**
 * The private half of `SessionLifecycle`: the same states, plus the handles the session needs
 * and clients must never receive.
 */
export type LeaseBinding =
  | { readonly kind: "acquiring"; readonly since: Timestamp }
  | { readonly kind: "active"; readonly since: Timestamp; readonly lease: SlotLease }
  | { readonly kind: "parked"; readonly since: Timestamp; readonly snapshot: SnapshotRef }
  | { readonly kind: "closed"; readonly at: Timestamp; readonly reason: SessionCloseReason };

/** The projection. The only function that may turn a binding into something a client sees. */
export function publicLifecycle(binding: LeaseBinding): SessionLifecycle {
  throw new Error("not implemented");
}

/** Contributors are derived from the turn ledger, not tracked alongside it. */
export function contributorsOf(turns: readonly Turn[]): readonly ActorId[] {
  throw new Error("not implemented");
}

/**
 * Branch naming is a function, and its inverse is `sessionOfBranch`. That round trip is why a
 * GitHub webhook needs no branch→session index: the name carries the id.
 */
export function branchOfSession(policy: WorkspacePolicy, session: SessionId): BranchName {
  throw new Error("not implemented");
}
export function sessionOfBranch(policy: WorkspacePolicy, branch: BranchName): SessionId | null {
  throw new Error("not implemented");
}

/** Derives the PR body: intent, per-turn summaries, contributor credits, session deep link. */
export function renderPullRequestBody(view: SessionView): { readonly title: string; readonly body: string } {
  throw new Error("not implemented");
}

/** Freshness transition, given what the sync process reported. Total over the union. */
export function nextFreshness(current: Freshness, report: SyncReport, now: Timestamp): Freshness {
  throw new Error("not implemented");
}

export type SyncReport =
  | { readonly kind: "started"; readonly target: CommitSha }
  | { readonly kind: "applied"; readonly head: CommitSha }
  | { readonly kind: "conflict"; readonly paths: readonly RepoPath[] }
  | { readonly kind: "failed"; readonly message: string };

// ═════════════════════════════════════════════════════════════════════════════════════════
// §9  Adapters — the credential-free path is the default one
// ═════════════════════════════════════════════════════════════════════════════════════════

export interface LocalPortsOptions {
  readonly root?: string;
  readonly clock?: Clock;
  readonly origin?: OriginFixture;
  readonly compute?: { readonly syncDelayMs?: DurationMs; readonly staleBy?: DurationMs };
  readonly agent?: AgentRuntime;
}

/** A bare git repo on disk standing in for origin, plus the assertions a test wants on it. */
export interface OriginFixture {
  readonly repo: RepoRef;
  readonly path: string;
  head(branch?: BranchName): Promise<CommitSha>;
  readAtHead(path: RepoPath): Promise<string>;
  /** Lets a test move origin forward mid-session, which is how divergence gets covered. */
  commit(files: Readonly<Record<string, string>>, message: string): Promise<CommitSha>;
}

export function gitFixture(init: {
  readonly repo?: RepoRef;
  readonly files: Readonly<Record<string, string>>;
}): Promise<OriginFixture> {
  throw new Error("not implemented");
}

/**
 * Everything real except the cloud: sandboxes are directories, `exec` is a child process,
 * snapshots are tarballs, the bus is an EventTarget, the store is SQLite, and the forge is an
 * in-memory PR list over a local bare repo. Enough to run the full create → prompt → stream →
 * PR path in a test.
 */
export function localPorts(opts?: LocalPortsOptions): Promise<Ports> {
  throw new Error("not implemented");
}

/** Deterministic time. `advance` drains scheduled timers in order, so the reaper is testable. */
export interface FakeClock extends Clock {
  advance(ms: DurationMs): Promise<void>;
}
export function fakeClock(startMs: number): FakeClock {
  throw new Error("not implemented");
}

/**
 * A runtime that replays a fixed tool script, so gate behaviour is asserted without a model.
 * The steps are domain-level on purpose: a test asserting "edits park until sync lands" should
 * not have to know an OpenCode frame, and neither should this fake.
 */
export type ScriptStep =
  | { readonly tool: "read"; readonly path: RepoPath }
  | { readonly tool: "edit"; readonly path: RepoPath; readonly to: string }
  | { readonly tool: "run"; readonly argv: readonly string[]; readonly effect: CommandEffect }
  | { readonly tool: "status"; readonly text: string; readonly emoji?: string }
  | { readonly tool: "spawn"; readonly intent: string; readonly isolation: ChildLink["isolation"] }
  | { readonly tool: "finish"; readonly summary: string };

export function scriptedAgent(script: readonly ScriptStep[]): AgentRuntime {
  throw new Error("not implemented");
}

export function systemClock(): Clock {
  throw new Error("not implemented");
}

// Deployed adapters. Same signatures, credentials instead of directories.
export function modalCompute(env: Readonly<Record<string, string>>): ComputePort {
  throw new Error("not implemented");
}
export function modalImages(env: Readonly<Record<string, string>>): ImagePort {
  throw new Error("not implemented");
}
export function durableObjectStore(env: unknown): StorePort {
  throw new Error("not implemented");
}
export function durableObjectBus(env: unknown): BusPort {
  throw new Error("not implemented");
}
export function githubAppForge(env: Readonly<Record<string, string>>): ForgePort {
  throw new Error("not implemented");
}
export function githubIdentities(env: Readonly<Record<string, string>>): IdentityPort {
  throw new Error("not implemented");
}
/** Small fast model + channel/thread context. Returns candidates; never picks for the caller. */
export function llmRepoClassifier(opts: { readonly model: string }): RepoClassifierPort {
  throw new Error("not implemented");
}

/**
 * Owns the OpenCode server lifecycle inside the slot and builds three plugins from
 * `TurnCapabilities`:
 *   tool.execute.before → caps.gate.admit(call)      (parks mutating calls; emits tool.parked)
 *   tool "status"       → caps.status(...)           (Slack/web progress line)
 *   tool "spawn"        → caps.spawnChild(...)       (returns a SessionId the clients can open)
 * plus `caps.extraTools` as MCP servers. No OpenCode type escapes this function.
 */
export function openCodeRuntime(opts: { readonly serverUrl: string }): AgentRuntime {
  throw new Error("not implemented");
}
