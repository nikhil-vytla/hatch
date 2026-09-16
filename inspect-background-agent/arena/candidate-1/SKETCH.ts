/**
 * Inspect-style background agent — candidate 1.
 *
 * Axis A: Session-as-actor. One long-lived SessionActor per session (Durable
 * Object–shaped) owns the prompt queue, the event stream, the sandbox handle,
 * and authorship. Clients are thin event sources over the SessionHub /
 * SessionHandle surface; every other interface here is an internal port.
 *
 * Single file for review; MODULES.md maps the banner sections below onto the
 * intended file layout. Bodies are `not implemented`; TODO comments mark the
 * tricky logic.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * module: core — branded ids and shared vocabulary
 *
 * Owns: identity, time, git/GitHub value types, the branch↔session derivation.
 * Depends on nothing. Everything else depends on it.
 * ────────────────────────────────────────────────────────────────────────── */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type PromptId = Brand<string, "PromptId">;
export type AuthorId = Brand<string, "AuthorId">;
export type SandboxId = Brand<string, "SandboxId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type ImageId = Brand<string, "ImageId">;
export type EventSeq = Brand<number, "EventSeq">; // monotonic per session, gapless
export type GitSha = Brand<string, "GitSha">;
export type BranchName = Brand<string, "BranchName">;
export type IsoTime = Brand<string, "IsoTime">;
export type UserToken = Brand<string, "UserToken">; // GitHub OAuth token; never logged

export function sessionId(raw: string): SessionId { throw new Error("not implemented"); }
export function authorId(raw: string): AuthorId { throw new Error("not implemented"); }
export function eventSeq(raw: number): EventSeq { throw new Error("not implemented"); }

export type RepoRef = { readonly owner: string; readonly name: string };
export type AuthorRef = { readonly id: AuthorId; readonly ghLogin: string; readonly display: string };
export type SandboxRef = { readonly id: SandboxId };
export type PrRef = { readonly repo: RepoRef; readonly number: number; readonly url: string };

/** Where a prompt or session came from. "agent" = spawned by a parent session's tool. */
export type ClientSource = "web" | "slack" | "extension" | "pr-comment" | "agent";

/**
 * Branch names derive from session ids — the single source of truth that lets
 * webhook routing be a pure function instead of a synced mapping table.
 */
export function branchFor(id: SessionId): BranchName { throw new Error("not implemented"); }
export function sessionForBranch(branch: BranchName): SessionId | undefined { throw new Error("not implemented"); }

export interface Clock { now(): IsoTime; }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: session — domain state, events, and the actor
 *
 * Owns: what a session IS. Lifecycle phases, sync gate, prompt queue,
 * authorship attribution, event log, and the coordination of sandbox + agent
 * runtime + GitHub. The actor is the ONLY writer of session state; all
 * commands serialize through its mailbox (per separate-before-serializing-
 * shared-state: one writer per state, merge at the actor boundary).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Git sync gate. The sandbox boots from a snapshot that may be up to ~30 min
 * stale; sync starts immediately on acquire. While `syncing`, the agent may
 * READ files but write/edit tools are blocked (enforced by the runtime plugin
 * via SessionCapabilities.gate). `synced` carries the head the workspace now
 * matches.
 */
export type SyncGate =
  | { readonly kind: "syncing"; readonly since: IsoTime }
  | { readonly kind: "synced"; readonly head: GitSha };

export type ActiveRun = {
  readonly prompt: PromptId;
  readonly startedAt: IsoTime;
  /** Set by stop(); the actor aborts the agent and resolves the prompt as stopped. */
  readonly stopRequestedBy?: AuthorId;
};

/**
 * Session lifecycle. Invariants encoded here rather than checked at runtime:
 * - a run and a gate exist only while a sandbox is live;
 * - a hibernated session always has a resume snapshot;
 * - closed is terminal and carries its reason.
 * Note the gate is a FIELD of `live`, not a phase: the agent can be running
 * (reads only) while sync is still in flight.
 */
export type SessionPhase =
  | { readonly kind: "initializing" }
  | { readonly kind: "live"; readonly sandbox: SandboxRef; readonly gate: SyncGate; readonly run?: ActiveRun }
  | { readonly kind: "hibernated"; readonly resume: SnapshotId }
  | { readonly kind: "closed"; readonly reason: CloseReason };

export type CloseReason = "pr-merged" | "pr-closed" | "user-closed" | "expired" | "error";

export type PromptState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly startedAt: IsoTime }
  | { readonly kind: "done"; readonly outcome: PromptOutcome }
  | { readonly kind: "stopped"; readonly by: AuthorId };

export type PromptOutcome = {
  readonly changedCode: boolean;
  readonly commits: readonly GitSha[]; // authored as the prompt's author (git user rewrite)
  readonly summary: string;
};

export type PromptRecord = {
  readonly id: PromptId;
  readonly author: AuthorRef; // multiplayer attribution lives here, not on the session
  readonly source: ClientSource;
  readonly text: string;
  readonly dedupeKey?: string; // client-supplied; enqueue is idempotent per key
  readonly state: PromptState;
};

/**
 * The actor's whole persisted state. Deliberately small; everything derivable
 * is derived (queue position from array order, authors from prompt records,
 * branch from id).
 */
export type SessionState = {
  readonly id: SessionId;
  readonly repo: RepoRef;
  readonly createdBy: AuthorRef;
  readonly createdAt: IsoTime;
  readonly parent?: SessionId;
  readonly children: readonly SessionId[];
  readonly phase: SessionPhase;
  /** Full prompt history in arrival order; the queue is the `queued` subset. */
  readonly prompts: readonly PromptRecord[];
  /** True after stop(); cleared by enqueue (fresh intent) or resumeQueue. */
  readonly queuePaused: boolean;
  readonly pr?: PrRef;
  readonly lastSeq: EventSeq;
};

// Pure derivations — single source of truth stays in SessionState.
export function queuedPrompts(s: SessionState): readonly PromptRecord[] { throw new Error("not implemented"); }
export function sessionAuthors(s: SessionState): readonly AuthorRef[] { throw new Error("not implemented"); }
/** Authors whose prompts produced commits — becomes Co-authored-by trailers on the PR. */
export function contributingAuthors(s: SessionState): readonly AuthorRef[] { throw new Error("not implemented"); }

/**
 * Everything a client can observe arrives as one of these on one stream.
 * Domain types only — AgentDelta is already parsed from the runtime's wire
 * format inside the agent adapter (per boundary-discipline).
 */
export type SessionEvent =
  | { readonly kind: "session.created"; readonly repo: RepoRef; readonly by: AuthorRef }
  | { readonly kind: "phase.changed"; readonly phase: SessionPhase }
  | { readonly kind: "gate.changed"; readonly gate: SyncGate }
  | { readonly kind: "prompt.queued"; readonly prompt: PromptRecord }
  | { readonly kind: "prompt.started"; readonly prompt: PromptId }
  | { readonly kind: "prompt.delta"; readonly prompt: PromptId; readonly delta: AgentDelta }
  | { readonly kind: "prompt.finished"; readonly prompt: PromptId; readonly state: PromptState }
  | { readonly kind: "agent.status"; readonly text: string } // status tool output; clients render
  | { readonly kind: "git.pushed"; readonly branch: BranchName; readonly head: GitSha }
  | { readonly kind: "pr.opened"; readonly pr: PrRef; readonly by: AuthorId }
  | { readonly kind: "pr.lifecycle"; readonly pr: PrRef; readonly change: "merged" | "closed" | "reopened" }
  | { readonly kind: "child.spawned"; readonly child: SessionId }
  | { readonly kind: "session.closed"; readonly reason: CloseReason };

export type SessionEventEnvelope = {
  readonly seq: EventSeq; // clients reconnect with { since: lastSeenSeq }
  readonly at: IsoTime;
  readonly event: SessionEvent;
};

/** Read-model handed to clients by view(); no live handles, safe to serialize. */
export type SessionView = {
  readonly id: SessionId;
  readonly repo: RepoRef;
  readonly branch: BranchName;
  readonly phase: SessionPhase;
  readonly queue: readonly PromptRecord[];
  readonly authors: readonly AuthorRef[];
  readonly pr?: PrRef;
  readonly children: readonly SessionId[];
};

/* ── public surface ──────────────────────────────────────────────────────── */

export type CreateSessionArgs = {
  readonly repo: RepoRef;
  readonly author: AuthorRef;
  readonly source: ClientSource;
  readonly firstPrompt?: string;
  readonly parent?: SessionId;
  /** Same key → same session (retry-safe create). */
  readonly idempotencyKey?: string;
};

export type EnqueuePromptArgs = {
  readonly author: AuthorRef;
  readonly source: ClientSource;
  readonly text: string;
  /** Same key → same PromptId, no duplicate entry (retry-safe enqueue). */
  readonly dedupeKey?: string;
};

/**
 * The whole client-facing API. Clients hold a hub and handles; they never see
 * sandboxes, agent connections, tokens, or wire types.
 */
export interface SessionHub {
  create(args: CreateSessionArgs): Promise<SessionHandle>;
  get(id: SessionId): Promise<SessionHandle | undefined>;
  /**
   * Fire on keystroke. Best-effort, idempotent, free to call repeatedly; the
   * fleet decides whether a pool fill is actually needed.
   */
  warmHint(repo: RepoRef): void;
  /** Routes by sessionForBranch(); events for unknown branches are dropped. */
  routeWebhook(event: GitHubWebhookEvent): Promise<void>;
}

/**
 * Location-transparent stub for one actor: in-process in the local demo, a DO
 * stub in production. Methods are commands into the actor's mailbox.
 *
 * Depth note: enqueue on a hibernated session transparently revives it
 * (acquire from resume snapshot, re-open agent conn, re-arm gate). Callers
 * never branch on phase.
 */
export interface SessionHandle {
  readonly id: SessionId;
  view(): Promise<SessionView>;
  enqueue(args: EnqueuePromptArgs): Promise<PromptId>;
  /**
   * Cancels the active run (if any) and pauses the queue so the next queued
   * prompt does not immediately start. Idempotent: stopping an idle session
   * only pauses the queue. Queued prompts are kept — in multiplayer they may
   * belong to other authors.
   */
  stop(by: AuthorId): Promise<void>;
  resumeQueue(by: AuthorId): Promise<void>;
  /**
   * Replays the persisted log from `since` (exclusive), then live-tails.
   * The iterator ends when the session closes.
   */
  events(opts?: { readonly since?: EventSeq }): AsyncIterable<SessionEventEnvelope>;
  /**
   * Pushes the branch (if dirty), then opens the PR with the REQUESTING
   * AUTHOR's token — the app never authors PRs. Idempotent: an existing open
   * PR for the branch is returned as-is. Co-author trailers derive from
   * contributingAuthors().
   */
  openPullRequest(args: { readonly requestedBy: AuthorId; readonly title?: string; readonly body?: string }): Promise<PrRef>;
  close(by: AuthorId): Promise<void>;
}

/* ── actor internals (not exported to clients) ───────────────────────────── */

/** Commands accepted by the mailbox; one-to-one with handle methods + webhook. */
export type SessionCommand =
  | { readonly kind: "enqueue"; readonly args: EnqueuePromptArgs }
  | { readonly kind: "stop"; readonly by: AuthorId }
  | { readonly kind: "resumeQueue"; readonly by: AuthorId }
  | { readonly kind: "openPr"; readonly requestedBy: AuthorId; readonly title?: string; readonly body?: string }
  | { readonly kind: "webhook"; readonly event: GitHubWebhookEvent }
  | { readonly kind: "close"; readonly by: AuthorId };

export type SessionActorDeps = {
  readonly fleet: SandboxFleet;
  readonly runtime: AgentRuntime;
  readonly github: GitHubPort;
  readonly vault: TokenVault;
  readonly spawner: ChildSpawner; // closes over the hub; breaks the actor→hub cycle
  readonly store: SessionStore;
  readonly clock: Clock;
  readonly policy: SessionPolicy;
};

export type SessionPolicy = {
  readonly idleHibernateAfterMs: number;
  readonly eventReplayWindow: number; // how much log to retain for reconnects
};

/**
 * The actor. Rehydrated from SessionStore on first command after eviction
 * (WebSocket-hibernation shaped). All private methods run inside the mailbox,
 * so state transitions are serialized by construction.
 */
export class SessionActor {
  constructor(deps: SessionActorDeps, boot: CreateSessionArgs & { readonly id: SessionId }) {
    throw new Error("not implemented");
  }

  /** Single entry point; the mailbox guarantees one command at a time. */
  handle(cmd: SessionCommand): Promise<unknown> { throw new Error("not implemented"); }

  view(): Promise<SessionView> { throw new Error("not implemented"); }
  events(since?: EventSeq): AsyncIterable<SessionEventEnvelope> { throw new Error("not implemented"); }

  /**
   * Ensure a live sandbox, reviving from resume snapshot when hibernated.
   * Idempotent: live phase returns the existing handle.
   * // TODO: crash-recovery — if phase says live but the fleet reports the
   * // sandbox dead (actor evicted mid-run), fall back to the latest snapshot
   * // if one exists, else a fresh acquire; emit phase.changed either way.
   */
  private ensureLive(): Promise<LiveSandbox> { throw new Error("not implemented"); }

  /**
   * Queue pump: while not paused and no active run, start the next queued
   * prompt. Runs after enqueue, prompt completion, and resumeQueue.
   * // TODO: before each run — sandbox.setCommitAuthor(prompt.author) so
   * // commits attribute to the human, not the app; consume AgentDelta stream,
   * // translate to prompt.delta events, fold commits into PromptOutcome.
   * // TODO: on stopRequestedBy — conn.abort(), resolve prompt as stopped,
   * // set queuePaused, do NOT pump.
   */
  private pump(): Promise<void> { throw new Error("not implemented"); }

  /**
   * Idle hibernation: snapshot the sandbox, terminate it, persist phase =
   * hibernated. Idempotent — re-running after a crash between snapshot and
   * persist just takes a newer snapshot; last write wins.
   */
  private hibernate(): Promise<void> { throw new Error("not implemented"); }

  /** pr.lifecycle events; merged/closed transition the session to closed. */
  private applyWebhook(event: GitHubWebhookEvent): Promise<void> { throw new Error("not implemented"); }

  /** Append to log + fan out to live subscribers; the ONLY event emitter. */
  private emit(event: SessionEvent): void { throw new Error("not implemented"); }
}

/** Per-session persistence port (DO SQLite–shaped; local adapter is in-memory/file). */
export interface SessionStore {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  append(events: readonly SessionEventEnvelope[]): Promise<void>;
  read(since?: EventSeq): AsyncIterable<SessionEventEnvelope>;
}
export interface SessionStoreFactory { storeFor(id: SessionId): SessionStore; }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: hub — actor registry and routing
 *
 * Owns: which sessions exist, how to reach them, create-idempotency, webhook
 * fan-in, and the warm-hint entry point. Thin by design — the depth lives in
 * the actors — but it is the ONLY module holding fleet + store + runtime
 * references, which is what keeps clients thin.
 * ────────────────────────────────────────────────────────────────────────── */

export type HubDeps = {
  readonly fleet: SandboxFleet;
  readonly runtime: AgentRuntime;
  readonly github: GitHubPort;
  readonly vault: TokenVault;
  readonly stores: SessionStoreFactory;
  readonly clock: Clock;
  readonly policy: SessionPolicy;
};

/**
 * // TODO create(): dedupe on idempotencyKey → existing handle; else mint
 * // SessionId, construct actor (spawner closes over this hub for child
 * // sessions), fire fleet acquire via the actor, return handle.
 * // TODO routeWebhook(): sessionForBranch() → get() → cmd {kind:"webhook"}.
 */
export function createSessionHub(deps: HubDeps): SessionHub { throw new Error("not implemented"); }

/** Capability the actor uses to spawn/inspect child sessions without owning the hub. */
export interface ChildSpawner {
  spawn(args: CreateSessionArgs): Promise<SessionId>;
  status(id: SessionId): Promise<SessionView | undefined>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * module: sandbox — fleet port, live-sandbox handle, image pipeline
 *
 * Owns: all knowledge of images, snapshots, warm pools, and git sync
 * mechanics. The interface is two calls deep on purpose: acquire() and the
 * handle it returns. Whether a sandbox came from the warm pool, a resume
 * snapshot, or a cold image build is invisible above this line.
 * ────────────────────────────────────────────────────────────────────────── */

export type AcquireRequest = {
  readonly repo: RepoRef;
  readonly session: SessionId; // for labeling/limits; fleet stays session-agnostic otherwise
  readonly resumeFrom?: SnapshotId;
};

export interface SandboxFleet {
  /**
   * Returns a BOOTED sandbox: agent server running, git sync already started
   * (gate = syncing). Resolution order: resumeFrom snapshot → warm pool →
   * latest image. Callers never choose the path.
   */
  acquire(req: AcquireRequest): Promise<LiveSandbox>;
  /** Best-effort pool fill; idempotent; expired by new image builds. */
  warm(repo: RepoRef): void;
}

/** Opaque address of the agent server inside a sandbox; only AgentRuntime interprets it. */
export type AgentServerRef = Brand<string, "AgentServerRef">;

export interface LiveSandbox {
  readonly ref: SandboxRef;
  readonly agentServer: AgentServerRef;
  /** Current gate; truth lives here, the actor mirrors transitions as events. */
  gate(): SyncGate;
  gateChanges(): AsyncIterable<SyncGate>;
  /** git user.name/email rewrite — commits attribute to the prompting human. */
  setCommitAuthor(author: AuthorRef): Promise<void>;
  /** Push via the GitHub App installation token baked into the image. */
  push(branch: BranchName): Promise<{ readonly head: GitSha }>;
  snapshot(): Promise<SnapshotId>;
  terminate(): Promise<void>;
}

/**
 * Internal to the sandbox module — the per-repo image registry (rebuild loop
 * ~every 30 min: clone with installation token, install, setup, optional warm
 * run) and the warm pool it feeds. Not visible to session/hub.
 */
export interface ImageRegistry {
  latest(repo: RepoRef): Promise<ImageId>;
  /** // TODO: scheduled rebuild; on success, expire the repo's warm pool. */
  rebuild(repo: RepoRef): Promise<ImageId>;
}

/** Adapters: modalSandboxFleet(cfg) — Modal-shaped; localSandboxFleet(cfg) —
 *  temp dirs + real git subprocesses + node child-process "sandbox". Same port. */
export function localSandboxFleet(cfg: { readonly workRoot: string }): SandboxFleet { throw new Error("not implemented"); }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: agent — runtime port (OpenCode-shaped) and session capabilities
 *
 * Owns: talking to the agent server and translating its wire protocol into
 * AgentDelta domain events. OpenCode types never cross this boundary. The
 * capabilities object is how the actor grants powers to sandbox-side plugins
 * without the runtime knowing about sessions, Slack, or the hub.
 * ────────────────────────────────────────────────────────────────────────── */

/** Already-parsed domain deltas (per boundary-discipline; no SDK types here). */
export type AgentDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool.start"; readonly tool: string; readonly summary: string }
  | { readonly kind: "tool.end"; readonly tool: string; readonly ok: boolean; readonly summary: string }
  | { readonly kind: "commit"; readonly sha: GitSha; readonly message: string };

/**
 * Powers the actor grants the runtime. The adapter maps them to OpenCode
 * plugins: gate() → tool.execute.before hook (block write/edit while syncing,
 * allow reads); postStatus → status tool (emitted as agent.status event —
 * clients render it, the agent never talks to Slack directly); spawnChild /
 * childStatus → fan-out tools looping back through the hub via ChildSpawner.
 */
export type SessionCapabilities = {
  readonly gate: () => SyncGate;
  readonly postStatus: (text: string) => void;
  readonly spawnChild: (args: { readonly prompt: string; readonly repo?: RepoRef }) => Promise<SessionId>;
  readonly childStatus: (id: SessionId) => Promise<SessionView | undefined>;
};

export type AgentRunRequest = {
  readonly prompt: PromptRecord;
  readonly repo: RepoRef;
};

export interface AgentRuntime {
  open(server: AgentServerRef, caps: SessionCapabilities): Promise<AgentConn>;
}

export interface AgentConn {
  /** One prompt run; the stream ends when the agent finishes or aborts. */
  run(req: AgentRunRequest): AsyncIterable<AgentDelta>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

/** Adapters: openCodeRuntime(sdkCfg); fakeAgentRuntime(script) for local/tests. */
export function fakeAgentRuntime(script?: readonly AgentDelta[][]): AgentRuntime { throw new Error("not implemented"); }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: github — PR + webhook port, token vault
 *
 * Owns: GitHub protocol knowledge — REST shapes, webhook signature checking,
 * app-vs-user auth. Raw payloads are parsed HERE into domain events; octokit
 * and webhook JSON never escape this module.
 * ────────────────────────────────────────────────────────────────────────── */

export type OpenPrArgs = {
  readonly repo: RepoRef;
  readonly branch: BranchName;
  readonly head: GitSha;
  readonly title: string;
  readonly body: string; // includes Co-authored-by trailers from contributingAuthors()
};

export interface GitHubPort {
  /** Idempotent: an existing open PR for (repo, branch) is returned unchanged. */
  ensurePullRequest(args: OpenPrArgs, token: UserToken): Promise<PrRef>;
  /** Verify signature, then parse to domain or classify as ignored/invalid. */
  parseWebhook(raw: RawWebhookDelivery): GitHubWebhookEvent | { readonly kind: "ignored" } | { readonly kind: "invalid"; readonly reason: string };
}

export type RawWebhookDelivery = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type GitHubWebhookEvent =
  | { readonly kind: "pr"; readonly repo: RepoRef; readonly branch: BranchName; readonly pr: PrRef; readonly change: "merged" | "closed" | "reopened" }
  | { readonly kind: "branch.deleted"; readonly repo: RepoRef; readonly branch: BranchName };

/** Maps authors to their GitHub OAuth tokens (session never sees raw tokens). */
export interface TokenVault {
  userToken(author: AuthorId): Promise<UserToken>;
}

/** Adapters: octokitGitHub(cfg); fakeGitHub() records PRs in memory and can
 *  synthesize webhook events for tests. */
export function fakeGitHub(): GitHubPort & { readonly emitMerge: (pr: PrRef) => GitHubWebhookEvent } { throw new Error("not implemented"); }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: clients/slack — thin adapter
 *
 * Owns: Slack-transport knowledge only — thread↔session index, Block Kit
 * rendering, repo classification for channel-first prompts. Depends on the
 * hub surface and nothing deeper.
 * ────────────────────────────────────────────────────────────────────────── */

export type SlackThreadKey = Brand<string, "SlackThreadKey">; // channel + thread_ts
export type SlackBlocks = Brand<string, "SlackBlocks">; // rendered Block Kit JSON, opaque here

/** Parsed at the HTTP boundary from Slack's event payload; no Slack SDK types beyond this. */
export type SlackInboundMessage = {
  readonly eventId: string; // Slack retries webhooks — doubles as dedupeKey
  readonly thread: SlackThreadKey;
  readonly author: AuthorRef; // resolved from Slack user → GitHub identity mapping
  readonly text: string;
  readonly ctx: SlackThreadCtx;
};
export type SlackThreadCtx = { readonly channelName: string; readonly recentText: readonly string[] };

export interface RepoClassifier {
  /** Fast-model classification with channel/thread context; undefined = ask the user. */
  classify(text: string, ctx: SlackThreadCtx): Promise<RepoRef | undefined>;
}

export interface SlackGateway {
  post(thread: SlackThreadKey, blocks: SlackBlocks): Promise<void>;
  update(thread: SlackThreadKey, blocks: SlackBlocks): Promise<void>;
}

/** Thread→session mapping is Slack-owned knowledge; adapter-local KV. */
export interface ThreadIndex {
  get(thread: SlackThreadKey): Promise<SessionId | undefined>;
  set(thread: SlackThreadKey, id: SessionId): Promise<void>;
}

export class SlackClientAdapter {
  constructor(deps: {
    readonly hub: SessionHub;
    readonly classifier: RepoClassifier;
    readonly slack: SlackGateway;
    readonly threads: ThreadIndex;
  }) { throw new Error("not implemented"); }

  /** See USAGE.md call site 2. */
  handleMessage(msg: SlackInboundMessage): Promise<void> { throw new Error("not implemented"); }

  /**
   * Subscribes to session.events() and renders to the thread until closed.
   * // TODO: coalesce prompt.delta bursts into message updates; distinct
   * // renderings for gate.changed, agent.status, pr.opened (custom emoji).
   */
  private follow(session: SessionHandle, thread: SlackThreadKey): Promise<void> { throw new Error("not implemented"); }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * module: clients/web — thin adapter
 *
 * Owns: HTTP/WS mapping only (see USAGE.md call sites 1 and 3). Framework-
 * neutral handler map so the demo can mount it on anything.
 * ────────────────────────────────────────────────────────────────────────── */

export type WebRoutes = {
  readonly warm: (repo: RepoRef) => void;
  readonly createSession: (args: CreateSessionArgs) => Promise<{ readonly id: SessionId }>;
  readonly enqueuePrompt: (id: SessionId, args: EnqueuePromptArgs) => Promise<{ readonly promptId: PromptId }>;
  readonly stop: (id: SessionId, by: AuthorId) => Promise<void>;
  readonly streamEvents: (id: SessionId, since?: EventSeq) => AsyncIterable<SessionEventEnvelope>;
  readonly openPr: (id: SessionId, requestedBy: AuthorId) => Promise<PrRef>;
  readonly webhook: (raw: RawWebhookDelivery) => Promise<{ readonly status: 202 | 400 }>;
};

export function webRoutes(hub: SessionHub, github: GitHubPort): WebRoutes { throw new Error("not implemented"); }

/* ────────────────────────────────────────────────────────────────────────── *
 * module: local — composition root for the credential-free demo
 *
 * The ONLY module that references adapters concretely. Wires: localSandboxFleet
 * (temp dirs + real git), fakeAgentRuntime (scripted deltas incl. a commit),
 * fakeGitHub, env-var TokenVault, in-memory stores.
 * ────────────────────────────────────────────────────────────────────────── */

export function createLocalInspect(opts?: { readonly workRoot?: string }): {
  readonly hub: SessionHub;
  readonly github: GitHubPort; // exposed so the demo can feed synthetic webhooks
} { throw new Error("not implemented"); }
